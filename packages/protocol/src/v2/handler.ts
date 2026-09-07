import { randomBytes } from 'node:crypto';
import {
  createMcpHandler,
  isLegacyRequest,
  type McpHttpHandler,
  type McpRequestContext,
  type McpServerFactory,
} from '@modelcontextprotocol/server';
import { notify, type ProtocolObservation } from '../observation.js';
import { RequestStateManager, requestStateSecretBox } from '../request-state.js';
import type { ProtocolRequestContext, ServedArtifact } from '../sdk-server.js';
import { protocolErrorObservation } from './response-observation.js';
import { buildDualEraMcpServer } from './server.js';
import { type McpProtocolMode, SERVED_MCP_PROTOCOL_VERSIONS } from './versions.js';

/**
 * The single Noodle MCP entry: SDK-owned era classification/dispatch with a narrow Noodle response seam.
 */
export function createDualEraMcpHandler(
  target: ServedArtifact,
  context: ProtocolRequestContext = {},
): McpHttpHandler {
  const requestState = context.requestState ?? processRequestState;
  const requestObservations = new WeakMap<Request, { observed: boolean }>();
  return createPlatformDualEraMcpHandlerInternal(
    (requestContext) =>
      buildDualEraMcpServer(
        target,
        requestContext.era,
        requestProtocolContext(
          observedProtocolContext(
            { ...context, requestState },
            requestContext,
            requestObservations,
          ),
          requestContext,
        ),
      ),
    {},
    {
      begin: (request) => requestObservations.set(request, { observed: false }),
      observeResponse: async (request, requestBody, response) => {
        if (requestObservations.get(request)?.observed === true) return;
        const responseBody = await readResponseBody(response);
        const observation = protocolErrorObservation(
          target.artifact,
          requestBody,
          responseBody,
          response.status,
        );
        if (observation !== undefined) notify(context, observation);
      },
      finish: (request) => requestObservations.delete(request),
    },
  );
}

/** Platform-wide SDK v2 handler used by artifact and first-party MCP surfaces alike. */
export function createPlatformDualEraMcpHandler(
  factory: McpServerFactory,
  platformOptions: { readonly protocolMode?: McpProtocolMode } = {},
): McpHttpHandler {
  return createPlatformDualEraMcpHandlerInternal(factory, platformOptions);
}

interface PlatformHandlerHooks {
  readonly begin: (request: Request) => void;
  readonly observeResponse: (
    request: Request,
    requestBody: unknown,
    response: Response,
  ) => void | Promise<void>;
  readonly finish: (request: Request) => void;
}

function createPlatformDualEraMcpHandlerInternal(
  factory: McpServerFactory,
  platformOptions: { readonly protocolMode?: McpProtocolMode } = {},
  hooks?: PlatformHandlerHooks,
): McpHttpHandler {
  const sdkHandler = createMcpHandler(factory, { legacy: 'stateless' });
  return {
    ...sdkHandler,
    fetch: async (request, options) => {
      hooks?.begin(request);
      try {
        const legacy = await isLegacyRequest(request.clone(), options?.parsedBody);
        const requestBody = await readRequestBody(request, options?.parsedBody);
        if (platformOptions.protocolMode === 'legacy-only' && !legacy) {
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: requestId(requestBody),
              error: { code: -32601, message: 'Method not found' },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        const response = await sdkHandler.fetch(request, {
          ...options,
          ...(requestBody === undefined ? {} : { parsedBody: requestBody }),
        });
        const shaped = await shapeNoodleResponse(response, requestBody, legacy);
        await observeResponseBestEffort(hooks, request, requestBody, shaped);
        return shaped;
      } finally {
        hooks?.finish(request);
      }
    },
  };
}

const processRequestState = new RequestStateManager(requestStateSecretBox(randomBytes(32)));

function requestProtocolContext(
  context: ProtocolRequestContext,
  requestContext: McpRequestContext,
): ProtocolRequestContext {
  return {
    ...context,
    ...(requestContext.era === 'legacy'
      ? { formElicitationTransport: 'unavailable' as const }
      : {}),
  };
}

function observedProtocolContext(
  context: ProtocolRequestContext,
  requestContext: McpRequestContext,
  requestObservations: WeakMap<Request, { observed: boolean }>,
): ProtocolRequestContext {
  return {
    ...context,
    observe: (observation: ProtocolObservation) => {
      const request = requestContext.requestInfo;
      const state = request === undefined ? undefined : requestObservations.get(request);
      if (state !== undefined) state.observed = true;
      notify(context, observation);
    },
  };
}

async function observeResponseBestEffort(
  hooks: PlatformHandlerHooks | undefined,
  request: Request,
  requestBody: unknown,
  response: Response,
): Promise<void> {
  try {
    await hooks?.observeResponse(request, requestBody, response);
  } catch {
    // Protocol analytics must never change the response it observes.
  }
}

async function readRequestBody(request: Request, parsedBody: unknown): Promise<unknown> {
  if (parsedBody !== undefined) return parsedBody;
  if (request.method.toUpperCase() !== 'POST') return undefined;
  try {
    return await request.clone().json();
  } catch {
    return undefined;
  }
}

async function readResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type');
  if (contentType?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') return undefined;
  try {
    return await response.clone().json();
  } catch {
    return undefined;
  }
}

async function shapeNoodleResponse(
  response: Response,
  requestBody: unknown,
  legacy: boolean,
): Promise<Response> {
  const contentType = response.headers.get('content-type');
  if (legacy && contentType?.split(';', 1)[0]?.trim().toLowerCase() === 'text/event-stream') {
    const eventStream = await response.text();
    const eventData = firstServerSentEventData(eventStream);
    if (eventData === undefined) return copyResponse(response, eventStream);
    const headers = new Headers(response.headers);
    headers.set('content-type', 'application/json');
    return shapeNoodleResponse(
      new Response(eventData, {
        status: response.status,
        statusText: response.statusText,
        headers,
      }),
      requestBody,
      legacy,
    );
  }
  if (contentType?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') return response;
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return copyResponse(response, text);
  }
  if (!isRecord(body)) return copyResponse(response, text);
  const method = requestMethod(requestBody);
  const id = requestId(requestBody);
  const error = isRecord(body.error) ? body.error : undefined;
  const result = isRecord(body.result) ? body.result : undefined;
  let status = response.status;

  if (!legacy && method === 'initialize') {
    status = 400;
    body = {
      jsonrpc: '2.0',
      error: {
        code: -32022,
        message: 'Unsupported protocol version',
        data: {
          supported: [...SERVED_MCP_PROTOCOL_VERSIONS],
          requested: '2026-07-28',
        },
      },
      id,
    };
  } else if (error?.code === -32022 && isRecord(error.data)) {
    error.data.supported = [...SERVED_MCP_PROTOCOL_VERSIONS];
  } else if (legacy && error !== undefined && typeof error.code === 'number') {
    const code = method === 'resources/read' && error.code === -32602 ? -32002 : error.code;
    const rawMessage =
      typeof error.message === 'string'
        ? error.message.replace(/^MCP error -?\d+: /, '')
        : 'Protocol error';
    body = {
      jsonrpc: '2.0',
      id,
      error: {
        code,
        message: `MCP error ${code}: ${rawMessage}`,
        ...(error.data === undefined ? {} : { data: error.data }),
      },
    };
  } else if (!legacy && method === 'server/discover' && result !== undefined) {
    result.supportedVersions = [...SERVED_MCP_PROTOCOL_VERSIONS];
  }
  return copyResponse(response, JSON.stringify(body), status);
}

function copyResponse(response: Response, body: string | null, status = response.status): Response {
  return new Response(body, {
    status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function firstServerSentEventData(body: string): string | undefined {
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (data.length > 0) return data;
  }
  return undefined;
}

function requestMethod(body: unknown): string | undefined {
  return isRecord(body) && typeof body.method === 'string' ? body.method : undefined;
}

function requestId(body: unknown): string | number | null {
  if (!isRecord(body)) return null;
  return typeof body.id === 'string' || typeof body.id === 'number' ? body.id : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
