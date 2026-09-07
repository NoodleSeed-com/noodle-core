import {
  Client,
  type FetchLike,
  SdkHttpError,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { guardedFetch } from '@noodle-borg/connector-http';
import { snapshotFromTools } from './snapshot.js';
import type { McpDiscoveredTool, McpImportSnapshot, ProbeMcpOptions } from './types.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 6 * 1024 * 1024;
const MAX_TIMEOUT_MS = 300_000;

export async function probeMcpServer(options: ProbeMcpOptions): Promise<McpImportSnapshot> {
  const endpoint = safeEndpoint(options.endpoint);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`MCP import timeout must be between 1 and ${MAX_TIMEOUT_MS} milliseconds`);
  }
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes < 1 ||
    maxResponseBytes > DEFAULT_MAX_RESPONSE_BYTES
  ) {
    throw new Error(
      `MCP import response limit must be between 1 and ${DEFAULT_MAX_RESPONSE_BYTES} bytes`,
    );
  }
  const signal = AbortSignal.timeout(timeoutMs);
  const fetch = importFetch(
    endpoint.origin,
    options.headers ?? {},
    maxResponseBytes,
    options.fetch,
  );
  const client = new Client(
    { name: 'noodle-mcp-import', version: '1.0.0' },
    {
      capabilities: {},
      versionNegotiation: { mode: protocolMode(options.protocol) },
      inputRequired: { autoFulfill: false },
      listMaxPages: 32,
    },
  );
  const transport = new StreamableHTTPClientTransport(endpoint, {
    fetch,
    onInsufficientScope: 'throw',
  });
  const closeTransportOnAbort = (): void => {
    void transport.close().catch(() => undefined);
  };
  signal.addEventListener('abort', closeTransportOnAbort, { once: true });
  if (signal.aborted) closeTransportOnAbort();
  let tools: readonly McpDiscoveredTool[];
  try {
    await client.connect(transport, { signal, timeout: timeoutMs });
    const result = await client.listTools(undefined, {
      signal,
      timeout: timeoutMs,
      cacheMode: 'bypass',
    });
    tools = result.tools.map(
      (tool): McpDiscoveredTool => ({
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
        ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
      }),
    );
  } catch (error) {
    if (signal.aborted) throw new Error('MCP import probe timed out');
    if (SdkHttpError.isInstance(error)) {
      throw new Error(`MCP import probe rejected with HTTP ${error.status}`);
    }
    throw new Error('MCP import probe failed');
  } finally {
    signal.removeEventListener('abort', closeTransportOnAbort);
    await client.close().catch(() => undefined);
  }
  return snapshotFromTools({
    endpoint: options.endpoint,
    name: options.name,
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    ...(options.auth === undefined ? {} : { auth: options.auth }),
    tools,
  });
}

function importFetch(
  allowedOrigin: string,
  configuredHeaders: Readonly<Record<string, string>>,
  maxBytes: number,
  injected?: FetchLike,
): FetchLike {
  const safeHeaders = validatedHeaders(configuredHeaders);
  return async (input, init = {}) => {
    const url = new URL(input);
    if (url.origin !== allowedOrigin) throw new Error('MCP import egress origin rejected');
    const headers = new Headers(init.headers);
    for (const [name, value] of Object.entries(safeHeaders)) headers.set(name, value);
    const response =
      injected === undefined
        ? await guardedFetch(url, { ...init, headers, redirect: 'manual' })
        : await injected(url, { ...init, headers, redirect: 'manual' });
    if (response.status >= 300 && response.status <= 399) {
      throw new Error('MCP import redirect rejected');
    }
    return boundedResponse(response, maxBytes);
  };
}

function boundedResponse(response: Response, maxBytes: number): Response {
  const length = Number(response.headers.get('content-length') ?? '0');
  if (length > maxBytes) throw new Error('MCP import response exceeds the size limit');
  if (response.body === null) return response;
  const reader = response.body.getReader();
  let size = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          return;
        }
        size += chunk.value.byteLength;
        if (size > maxBytes) {
          await reader.cancel().catch(() => undefined);
          controller.error(new Error('MCP import response exceeds the size limit'));
          return;
        }
        controller.enqueue(chunk.value);
      },
      async cancel(reason) {
        await reader.cancel(reason).catch(() => undefined);
      },
    }),
    { status: response.status, statusText: response.statusText, headers: response.headers },
  );
}

function safeEndpoint(value: string): URL {
  const url = new URL(value);
  if (url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new Error('MCP endpoint contains forbidden URL components');
  }
  const loopback =
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
  if (url.protocol !== 'https:' && !loopback) throw new Error('MCP endpoint must use HTTPS');
  return url;
}

function validatedHeaders(input: Readonly<Record<string, string>>): Record<string, string> {
  if (Object.keys(input).length > 32) throw new Error('MCP import accepts at most 32 headers');
  const headers: Record<string, string> = Object.create(null) as Record<string, string>;
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(input)) {
    const lower = name.toLowerCase();
    if (seen.has(lower)) throw new Error(`MCP import header "${name}" is duplicated`);
    seen.add(lower);
    if (
      lower === 'host' ||
      lower === 'cookie' ||
      lower === 'content-type' ||
      lower === 'content-length' ||
      lower.startsWith('mcp-')
    ) {
      throw new Error(`MCP import header "${name}" is transport-owned`);
    }
    if (value.length > 8_192 || /[\r\n]/.test(value)) {
      throw new Error(`MCP import header "${name}" has an invalid value`);
    }
    try {
      new Headers({ [name]: value });
    } catch {
      throw new Error(`MCP import header "${name}" is invalid`);
    }
    headers[lower] = value;
  }
  return headers;
}

function protocolMode(
  value: ProbeMcpOptions['protocol'],
): 'auto' | 'legacy' | { readonly pin: '2026-07-28' } {
  if (value === 'modern') return { pin: '2026-07-28' };
  return value ?? 'auto';
}
