import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  Client,
  PROTOCOL_VERSION_META_KEY,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import type { McpHttpHandler } from '@modelcontextprotocol/server';
import type { RuntimeArtifact } from '@noodle-borg/compiler';
import type { ProtocolRequestContext, ServedArtifact } from '../src/index.js';
import { createDualEraMcpHandler } from '../src/v2/handler.js';
import { servedArtifact } from './harness.js';

export type TestClientMode = 'legacy' | 'automatic' | 'pinned-modern';

export interface ConnectedV2Client {
  readonly client: Client;
  readonly close: () => Promise<void>;
}

export function testServedArtifact(
  mutate: (artifact: RuntimeArtifact) => RuntimeArtifact = (artifact) => artifact,
): ServedArtifact {
  const base = servedArtifact();
  return { ...base, artifact: mutate(base.artifact) };
}

export function createTestDualEraHandler(
  target: ServedArtifact = testServedArtifact(),
  context: ProtocolRequestContext = {},
): McpHttpHandler {
  return createDualEraMcpHandler(target, context);
}

export async function connectV2Client(
  handler: McpHttpHandler,
  mode: TestClientMode,
): Promise<ConnectedV2Client> {
  const versionNegotiation =
    mode === 'legacy'
      ? { mode: 'legacy' as const }
      : mode === 'automatic'
        ? { mode: 'auto' as const }
        : { mode: { pin: '2026-07-28' } };
  const client = new Client(
    { name: 'noodle-v2-test-client', version: '1.0.0' },
    { capabilities: {}, versionNegotiation },
  );
  const transport = new StreamableHTTPClientTransport(new URL('https://mcp.test/endpoint'), {
    fetch: async (input, init) => {
      const request =
        input instanceof Request && init === undefined ? input : new Request(input, init);
      return handler.fetch(request);
    },
  });
  await client.connect(transport);
  return {
    client,
    close: async () => {
      await client.close();
      await handler.close();
    },
  };
}

export interface RpcResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly json: Record<string, unknown>;
  readonly text: string;
}

export function modernRequestBody(
  method: string,
  params: Record<string, unknown> = {},
  options: {
    id?: number;
    version?: string;
    clientCapabilities?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  const version = options.version ?? '2026-07-28';
  return {
    jsonrpc: '2.0',
    id: options.id ?? 1,
    method,
    params: {
      ...params,
      _meta: {
        [PROTOCOL_VERSION_META_KEY]: version,
        [CLIENT_INFO_META_KEY]: { name: 'noodle-v2-test-client', version: '1.0.0' },
        [CLIENT_CAPABILITIES_META_KEY]: options.clientCapabilities ?? {},
      },
    },
  };
}

export async function modernRpc(
  handler: McpHttpHandler,
  method: string,
  params: Record<string, unknown> = {},
  options: {
    id?: number;
    version?: string;
    methodHeader?: string | null;
    nameHeader?: string | null;
    clientCapabilities?: Record<string, unknown>;
  } = {},
): Promise<RpcResponse> {
  const body = modernRequestBody(method, params, options);
  const version = options.version ?? '2026-07-28';
  const headers = new Headers({
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'mcp-protocol-version': version,
  });
  if (options.methodHeader !== null) headers.set('mcp-method', options.methodHeader ?? method);
  const targetName =
    method === 'tools/call' || method === 'prompts/get'
      ? params.name
      : method === 'resources/read'
        ? params.uri
        : undefined;
  if (options.nameHeader !== null && typeof targetName === 'string') {
    headers.set('mcp-name', options.nameHeader ?? targetName);
  }
  const response = await handler.fetch(
    new Request('https://mcp.test/endpoint', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
  );
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    json: text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>),
    text,
  };
}

export async function legacyRpc(
  handler: McpHttpHandler,
  method: string,
  params: Record<string, unknown>,
  version = '2025-11-25',
): Promise<RpcResponse> {
  const response = await handler.fetch(
    new Request('https://mcp.test/endpoint', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': version,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  );
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    json: text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>),
    text,
  };
}
