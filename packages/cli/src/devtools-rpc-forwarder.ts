import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/client';
import { LEGACY_MCP_PROTOCOL_VERSION, MODERN_MCP_PROTOCOL_VERSION } from '@noodle-borg/protocol';
import { DevtoolsAuthRequiredError, type DevtoolsAuthSession } from './devtools-auth-session.js';

const DISCOVERY_TIMEOUT_MS = 5_000;

interface DevtoolsRpcProtocol {
  readonly era: 'legacy' | 'modern';
  readonly version: string;
  /** True when discovery did not establish the server era and should be retried. */
  readonly retryable?: boolean;
}

export interface RpcLogEntry {
  readonly time: number;
  readonly method: string;
  readonly name?: string;
  readonly status: 'ok' | 'error';
  readonly durationMs: number;
  readonly summary: string;
  /** Request params (input) captured for the inspector; size-capped. */
  readonly request?: unknown;
  /** Response result or error (output) captured for the inspector; size-capped. */
  readonly response?: unknown;
}

export interface DevtoolsRpcRequest {
  readonly method: string;
  readonly id: unknown;
  readonly params?: Record<string, unknown>;
}

interface DevtoolsRpcResponse {
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code?: number; readonly message?: string };
}

export interface DevtoolsRpcForwardResult {
  readonly httpStatus: number;
  readonly json: DevtoolsRpcResponse | undefined;
}

/** Build the credential-owning MCP forwarder used by every Devtools host surface. */
export function createDevtoolsRpcForwarder(options: {
  readonly mcpUrl: string;
  readonly protocolVersion?: string;
  readonly authSession: () => DevtoolsAuthSession | undefined;
  readonly record: (entry: RpcLogEntry) => void;
}): (body: DevtoolsRpcRequest) => Promise<DevtoolsRpcForwardResult> {
  const protocolCache = new Map<string, Promise<DevtoolsRpcProtocol>>();
  const explicitProtocol =
    options.protocolVersion === undefined
      ? undefined
      : {
          era:
            options.protocolVersion === MODERN_MCP_PROTOCOL_VERSION
              ? ('modern' as const)
              : ('legacy' as const),
          version: options.protocolVersion,
        };
  const resolveProtocol = (bearer: string | undefined): Promise<DevtoolsRpcProtocol> =>
    explicitProtocol === undefined
      ? automaticProtocol(protocolCache, options.mcpUrl, bearer)
      : Promise.resolve(explicitProtocol);

  return async (body) => {
    const start = Date.now();
    const name = toolName(body);
    try {
      const authSession = options.authSession();
      let accessToken: string | undefined;
      if (authSession !== undefined) {
        try {
          accessToken = await authSession.accessToken();
        } catch (error) {
          if (error instanceof DevtoolsAuthRequiredError) {
            return authRequiredResult(body, start, name, error.message, options.record);
          }
          throw error;
        }
      }
      const protocol = await resolveProtocol(accessToken);
      const send = (bearer: string | undefined): Promise<Response> => {
        const headers = new Headers({
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': protocol.version,
        });
        const requestBody =
          protocol.era === 'modern' ? modernRequest(body, protocol.version) : body;
        if (bearer !== undefined) headers.set('authorization', `Bearer ${bearer}`);
        if (protocol.era === 'modern') setModernRoutingHeaders(headers, body, name);
        return fetch(options.mcpUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({ jsonrpc: '2.0', ...requestBody }),
        });
      };
      let response = await send(accessToken);
      if (response.status === 401 && authSession !== undefined) {
        await response.body?.cancel();
        try {
          accessToken = await authSession.accessToken({ forceRefresh: true });
          response = await send(accessToken);
          if (response.status === 401) authSession.rejectToken();
        } catch (error) {
          if (error instanceof DevtoolsAuthRequiredError) {
            return authRequiredResult(body, start, name, error.message, options.record);
          }
          throw error;
        }
      }
      authSession?.noteBearerChallenge(response.status, response.headers.get('www-authenticate'));
      const json = parseRpcBody(await response.text());
      const resultIsError = json?.result?.isError === true;
      const status: 'ok' | 'error' = json?.error !== undefined || resultIsError ? 'error' : 'ok';
      options.record({
        time: start,
        method: body.method,
        ...(name !== undefined ? { name } : {}),
        status,
        durationMs: Date.now() - start,
        summary: json?.error?.message ?? summarize(body.method, json?.result),
        ...(body.params !== undefined ? { request: capForLog(body.params) } : {}),
        ...(json !== undefined ? { response: capForLog(json.error ?? json.result) } : {}),
      });
      return { httpStatus: response.status, json };
    } catch (error) {
      options.record({
        time: start,
        method: body.method,
        ...(name !== undefined ? { name } : {}),
        status: 'error',
        durationMs: Date.now() - start,
        summary: error instanceof Error ? error.message : String(error),
        ...(body.params !== undefined ? { request: capForLog(body.params) } : {}),
      });
      throw error;
    }
  };
}

function automaticProtocol(
  cache: Map<string, Promise<DevtoolsRpcProtocol>>,
  endpoint: string,
  bearer: string | undefined,
): Promise<DevtoolsRpcProtocol> {
  const origin = new URL(endpoint).origin;
  const key = `${origin}\u0000${bearer === undefined ? 'anonymous' : 'authenticated'}`;
  let pending = cache.get(key);
  if (pending === undefined) {
    pending = discoverProtocol(endpoint, bearer);
    cache.set(key, pending);
    void pending.then(
      (protocol) => {
        if (protocol.retryable === true && cache.get(key) === pending) cache.delete(key);
      },
      () => {
        if (cache.get(key) === pending) cache.delete(key);
      },
    );
  }
  return pending;
}

async function discoverProtocol(
  endpoint: string,
  bearer: string | undefined,
): Promise<DevtoolsRpcProtocol> {
  const method = 'server/discover';
  const headers = new Headers({
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'mcp-method': method,
    'mcp-protocol-version': MODERN_MCP_PROTOCOL_VERSION,
  });
  if (bearer !== undefined) headers.set('authorization', `Bearer ${bearer}`);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      body: JSON.stringify(
        modernRequest({ jsonrpc: '2.0', id: 'noodle-devtools-discover', method, params: {} }),
      ),
    });
    const json = parseRpcBody(await response.text());
    const versions = json?.result?.supportedVersions;
    if (response.ok && Array.isArray(versions)) {
      return versions.includes(MODERN_MCP_PROTOCOL_VERSION)
        ? { era: 'modern', version: MODERN_MCP_PROTOCOL_VERSION }
        : { era: 'legacy', version: LEGACY_MCP_PROTOCOL_VERSION };
    }
    if (response.status === 401 || response.status === 403) {
      return { era: 'legacy', version: LEGACY_MCP_PROTOCOL_VERSION, retryable: true };
    }
    if (response.status === 404 || json?.error?.code === -32601) {
      return { era: 'legacy', version: LEGACY_MCP_PROTOCOL_VERSION };
    }
    return { era: 'legacy', version: LEGACY_MCP_PROTOCOL_VERSION, retryable: true };
  } catch {
    return { era: 'legacy', version: LEGACY_MCP_PROTOCOL_VERSION, retryable: true };
  }
}

function setModernRoutingHeaders(
  headers: Headers,
  body: DevtoolsRpcRequest,
  name: string | undefined,
): void {
  headers.set('mcp-method', body.method);
  if (name !== undefined) headers.set('mcp-name', name);
  else if (body.method === 'resources/read' && typeof body.params?.uri === 'string') {
    headers.set('mcp-name', body.params.uri);
  } else if (body.method === 'prompts/get' && typeof body.params?.name === 'string') {
    headers.set('mcp-name', body.params.name);
  }
}

function modernRequest<
  T extends {
    readonly method: string;
    readonly params?: Record<string, unknown>;
  },
>(
  body: T,
  version: string = MODERN_MCP_PROTOCOL_VERSION,
): T & { readonly params: Record<string, unknown> } {
  const existingMeta =
    body.params?._meta !== null &&
    typeof body.params?._meta === 'object' &&
    !Array.isArray(body.params._meta)
      ? (body.params._meta as Record<string, unknown>)
      : {};
  return {
    ...body,
    params: {
      ...body.params,
      _meta: {
        ...existingMeta,
        [PROTOCOL_VERSION_META_KEY]: version,
        [CLIENT_INFO_META_KEY]: { name: 'noodle-devtools', version: '1.0.0' },
        [CLIENT_CAPABILITIES_META_KEY]: { elicitation: { form: {} } },
      },
    },
  };
}

function authRequiredResult(
  body: DevtoolsRpcRequest,
  start: number,
  name: string | undefined,
  message: string,
  record: (entry: RpcLogEntry) => void,
): DevtoolsRpcForwardResult {
  const json: DevtoolsRpcResponse = {
    error: { code: -32001, message },
  };
  record({
    time: start,
    method: body.method,
    ...(name !== undefined ? { name } : {}),
    status: 'error',
    durationMs: Date.now() - start,
    summary: message,
    ...(body.params !== undefined ? { request: capForLog(body.params) } : {}),
    response: json.error,
  });
  return { httpStatus: 401, json };
}

/** One JSON-RPC value from a dev-endpoint response body (JSON, or an SSE `data:` fallback). */
function parseRpcBody(text: string): DevtoolsRpcResponse | undefined {
  try {
    return JSON.parse(text) as DevtoolsRpcResponse;
  } catch {
    for (const line of text.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      try {
        return JSON.parse(trimmed.slice(5).trim()) as DevtoolsRpcResponse;
      } catch {
        // Keep scanning.
      }
    }
    return undefined;
  }
}

function capForLog(value: unknown, max = 20_000): unknown {
  if (value === undefined) return undefined;
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length > max) {
      return `${serialized.slice(0, max)}… (truncated ${serialized.length - max} chars)`;
    }
    return value;
  } catch {
    return '[unserializable]';
  }
}

function summarize(method: string, result: Record<string, unknown> | undefined): string {
  if (result === undefined) return method;
  if (method === 'tools/list') {
    return `${Array.isArray(result.tools) ? result.tools.length : 0} tool(s)`;
  }
  if (method === 'tools/call') return result.isError ? 'tool error' : 'ok';
  if (method === 'resources/read') {
    return `${Array.isArray(result.contents) ? result.contents.length : 0} content block(s)`;
  }
  return 'ok';
}

function toolName(body: DevtoolsRpcRequest): string | undefined {
  return body.method === 'tools/call' && typeof body.params?.name === 'string'
    ? body.params.name
    : undefined;
}
