const MAX_MCP_RESPONSE_BYTES = 1024 * 1024;
const MODERN_PROTOCOL_VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';
const MODERN_CLIENT_INFO_KEY = 'io.modelcontextprotocol/clientInfo';
const MODERN_CLIENT_CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities';

function parseJsonRpc(text, expectedId) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('MCP response was not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('MCP response was not one JSON-RPC object');
  }
  if (parsed.jsonrpc !== '2.0') throw new Error('MCP response used an invalid JSON-RPC version');
  if (parsed.id !== expectedId) throw new Error('MCP response id did not match request');
  if (parsed.error !== undefined) {
    const code =
      parsed.error !== null && typeof parsed.error === 'object' && 'code' in parsed.error
        ? String(parsed.error.code)
        : 'unknown';
    throw new Error(`MCP JSON-RPC error ${code}`);
  }
  if (!('result' in parsed)) throw new Error('MCP response did not contain a result');
  return parsed.result;
}

function sseData(text) {
  const events = text.split(/\r?\n\r?\n/);
  for (const event of events) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (data.length > 0) return data;
  }
  throw new Error('MCP SSE response did not contain a data event');
}

export async function parseMcpResponse(response, expectedId) {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`MCP request failed with HTTP ${response.status}`);
  }
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json' && contentType !== 'text/event-stream') {
    await response.body?.cancel();
    throw new Error('MCP response used an unsupported content type');
  }
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MCP_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error('MCP response exceeded the 1 MiB acceptance bound');
  }
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  if (reader !== undefined) {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_MCP_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('MCP response exceeded the 1 MiB acceptance bound');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  }
  const json = contentType === 'text/event-stream' ? sseData(text) : text;
  return parseJsonRpc(json, expectedId);
}

function modernTargetName(method, params) {
  if (method === 'tools/call' || method === 'prompts/get') return params.name;
  if (method === 'resources/read') return params.uri;
  return undefined;
}

export function acceptanceRequestSignal(signal, timeoutMs = 30_000) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

export async function mcpRpc(input) {
  const modern = input.era === '2026-07-28';
  const params = modern
    ? {
        ...input.params,
        _meta: {
          [MODERN_PROTOCOL_VERSION_KEY]: input.era,
          [MODERN_CLIENT_INFO_KEY]: { name: 'noodle-self-host-e2e', version: '1.0.0' },
          [MODERN_CLIENT_CAPABILITIES_KEY]: input.clientCapabilities ?? {},
        },
      }
    : input.params;
  const headers = new Headers({
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'mcp-protocol-version': input.era,
  });
  if (modern) {
    headers.set('mcp-method', input.method);
    const name = modernTargetName(input.method, input.params);
    if (typeof name === 'string') headers.set('mcp-name', name);
  }
  const response = await input.fetch(input.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: input.id,
      method: input.method,
      params,
    }),
    signal: acceptanceRequestSignal(input.signal, input.timeoutMs),
  });
  return parseMcpResponse(response, input.id);
}

export function assertIncludes(value, expected, context) {
  if (!JSON.stringify(value).includes(expected)) {
    throw new Error(`${context} did not contain ${expected}`);
  }
}

async function sendInitialized(fetchImpl, url, signal) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-11-25',
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
    signal: acceptanceRequestSignal(signal),
  });
  if (!response.ok)
    throw new Error(`legacy initialized notification failed with HTTP ${response.status}`);
}

export async function exerciseHello(fetchImpl, url, era, expectedGreeting, startingId, signal) {
  if (era === '2025-11-25') {
    const initialized = await mcpRpc({
      fetch: fetchImpl,
      url,
      era,
      id: startingId,
      method: 'initialize',
      signal,
      params: {
        protocolVersion: era,
        capabilities: {},
        clientInfo: { name: 'noodle-self-host-e2e', version: '1.0.0' },
      },
    });
    assertIncludes(initialized, era, 'legacy initialize response');
    await sendInitialized(fetchImpl, url, signal);
  } else {
    const discovered = await mcpRpc({
      fetch: fetchImpl,
      url,
      era,
      id: startingId,
      method: 'server/discover',
      signal,
      params: {},
    });
    assertIncludes(discovered, era, 'modern discover response');
  }
  const tools = await mcpRpc({
    fetch: fetchImpl,
    url,
    era,
    id: startingId + 1,
    method: 'tools/list',
    signal,
    params: {},
  });
  assertIncludes(tools, 'greet', `${era} tools/list response`);
  const greeting = await mcpRpc({
    fetch: fetchImpl,
    url,
    era,
    id: startingId + 2,
    method: 'tools/call',
    signal,
    params: { name: 'greet', arguments: { name: 'Core' } },
  });
  assertIncludes(greeting, expectedGreeting, `${era} greet response`);
  return greeting;
}
