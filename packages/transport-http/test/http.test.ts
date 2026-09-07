import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  compileManifest,
  InMemoryCatalog,
  type OperationSignature,
  type RuntimeArtifact,
} from '@noodle-borg/compiler';
import type { ServedArtifact } from '@noodle-borg/protocol';
import {
  type ExecuteDeps,
  InMemoryConnector,
  InMemoryConnectorRegistry,
  StaticServiceBroker,
} from '@noodle-borg/runtime';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type HttpHandlerOptions,
  type OriginPolicy,
  type RunningServer,
  serveHttp,
} from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const artifactPath = join(
  here,
  '..',
  '..',
  'compiler',
  'fixtures',
  'valid',
  'minimal.resolved.artifact.json',
);

const getOrderSig: OperationSignature = {
  type: 'read',
  input: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  output: {
    type: 'object',
    properties: { order: { type: 'object' } },
    additionalProperties: false,
  },
};

function deps(options: { failing?: boolean } = {}): ExecuteDeps {
  const connector = new InMemoryConnector('acme_orders', '1.2.0', {
    get_order: {
      signature: getOrderSig,
      handler: options.failing
        ? () => {
            throw new Error('boom');
          }
        : (args) => ({ order: { id: args.id, status: 'open' } }),
    },
  });
  return {
    connectors: new InMemoryConnectorRegistry([connector]),
    broker: new StaticServiceBroker({ token: 'svc' }),
  };
}

function artifact(): RuntimeArtifact {
  return JSON.parse(readFileSync(artifactPath, 'utf8')) as RuntimeArtifact;
}

function contextualArtifact(): RuntimeArtifact {
  const base = artifact();
  return {
    ...base,
    server: { ...base.server, context: { defaults: { locale: 'en-GB', timeZone: 'UTC' } } },
  };
}

function elicitingArtifact(): RuntimeArtifact {
  const compiled = compileManifest(
    {
      manifestVersion: '1',
      server: { name: 'eliciting', title: 'Eliciting', version: '1.0.0' },
      tools: [
        {
          name: 'choose_team',
          description: 'Choose a team.',
          inputSchema: { type: 'object', properties: {} },
          fulfilment: {
            steps: [
              {
                id: 'team',
                elicit: {
                  message: 'Which team?',
                  requestedSchema: {
                    type: 'object',
                    properties: { team: { type: 'string', enum: ['noodle', 'platform'] } },
                    required: ['team'],
                  },
                },
              },
            ],
            output: { team: '${steps.team.team}' },
          },
        },
      ],
    },
    { catalog: new InMemoryCatalog([]) },
  );
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
  return compiled.artifact;
}

const ACCEPT = 'application/json, text/event-stream';
const JSON_HEADERS = { 'content-type': 'application/json', accept: ACCEPT };
const VERSIONED = { ...JSON_HEADERS, 'mcp-protocol-version': '2025-11-25' };

/** A spec-valid `initialize` request (the SDK requires protocolVersion + capabilities + clientInfo). */
const INIT = {
  jsonrpc: '2.0' as const,
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 't', version: '1' },
  },
};

let running: RunningServer;

async function start(
  options: {
    failing?: boolean;
    allowedOrigins?: OriginPolicy;
    maxBodyBytes?: number;
    contextual?: boolean;
    artifact?: RuntimeArtifact;
    resolveInvocationContext?: HttpHandlerOptions['resolveInvocationContext'];
  } = {},
): Promise<string> {
  const target: ServedArtifact = {
    artifact: options.artifact ?? (options.contextual ? contextualArtifact() : artifact()),
    deps: deps(options),
  };
  running = await serveHttp({
    target,
    port: 0,
    ...(options.allowedOrigins !== undefined ? { allowedOrigins: options.allowedOrigins } : {}),
    ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
    ...(options.resolveInvocationContext === undefined
      ? {}
      : { resolveInvocationContext: options.resolveInvocationContext }),
  });
  return running.url;
}

async function postWithoutAccept(
  url: string,
  body: unknown,
): Promise<{ status: number; text: string }> {
  return postWithNodeHttp(url, body, {
    'content-type': 'application/json',
  });
}

async function postWithNodeHttp(
  url: string,
  body: unknown,
  headers: Record<string, string | string[]>,
): Promise<{ status: number; text: string }> {
  const parsed = new URL(url);
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      parsed,
      {
        method: 'POST',
        headers: {
          'content-length': Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

afterEach(async () => {
  await running?.close();
});

describe('remote MCP server over Streamable HTTP', () => {
  it('fails closed for nested form elicitation on the stateless JSON-response lane', async () => {
    const url = await start({ artifact: elicitingArtifact() });
    const transport = new StreamableHTTPClientTransport(new URL(url));
    const client = new Client(
      { name: 'http-elicitation-client', version: '1.0.0' },
      { capabilities: { elicitation: { form: {} } } },
    );
    let elicitationRequests = 0;
    client.setRequestHandler(ElicitRequestSchema, async () => {
      elicitationRequests += 1;
      return { action: 'accept', content: { team: 'noodle' } };
    });

    try {
      await client.connect(transport);
      await expect(client.callTool({ name: 'choose_team', arguments: {} })).resolves.toMatchObject({
        isError: true,
        structuredContent: {
          code: 'interaction_unavailable',
          interaction: 'input',
          executed: false,
        },
      });
      expect(elicitationRequests).toBe(0);
    } finally {
      await client.close();
    }
  });

  it('resolves one invocation context snapshot before calling a context-aware MCP tool', async () => {
    const url = await start({
      contextual: true,
      resolveInvocationContext: async () => ({
        temporal: {
          instant: '2030-01-01T23:30:00.000Z',
          localDate: '2030-01-01',
          localTime: '23:30:00',
          utcOffset: '+00:00',
          weekday: 'Tuesday',
          timeZone: 'UTC',
          locale: 'en-GB',
          source: { locale: 'server-default', timeZone: 'server-default' },
        },
        ambientStatus: 'not_configured',
      }),
    });
    const call = await fetch(url, {
      method: 'POST',
      headers: VERSIONED,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'noodle_context', arguments: {} },
      }),
    });

    expect(call.status).toBe(200);
    expect((await call.json()).result.structuredContent).toMatchObject({
      temporal: { instant: '2030-01-01T23:30:00.000Z', locale: 'en-GB' },
      ambientStatus: 'not_configured',
    });
  });

  it('resolves temporal context for executable MCP calls without ambient context configuration', async () => {
    let resolutions = 0;
    const url = await start({
      resolveInvocationContext: async () => {
        resolutions += 1;
        return {
          temporal: {
            instant: '2030-01-01T23:30:00.000Z',
            localDate: '2030-01-01',
            localTime: '23:30:00',
            utcOffset: '+00:00',
            weekday: 'Tuesday',
            timeZone: 'UTC',
            locale: 'en-GB',
            source: { locale: 'server-default', timeZone: 'server-default' },
          },
          ambientStatus: 'not_configured',
        };
      },
    });

    const call = await fetch(url, {
      method: 'POST',
      headers: VERSIONED,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_order', arguments: { order_id: 'A1' } },
      }),
    });

    expect(call.status).toBe(200);
    expect(resolutions).toBe(1);
  });

  it('completes initialize -> tools/list -> tools/call over HTTP', async () => {
    const url = await start();

    const init = await fetch(url, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(INIT),
    });
    expect(init.status).toBe(200);
    expect(init.headers.get('content-type')).toContain('application/json');
    expect(init.headers.get('mcp-session-id')).toBeNull(); // stateless: no session id issued
    const initBody = await init.json();
    expect(initBody.result.protocolVersion).toBe('2025-11-25');

    const list = await fetch(url, {
      method: 'POST',
      headers: VERSIONED,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    const listBody = await list.json();
    expect(listBody.result.tools[0].name).toBe('get_order');

    const call = await fetch(url, {
      method: 'POST',
      headers: VERSIONED,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'get_order', arguments: { order_id: 'A1' } },
      }),
    });
    expect(call.status).toBe(200);
    const callBody = await call.json();
    expect(callBody.result).toEqual({
      content: [{ type: 'text', text: '{"order":{"id":"A1","status":"open"}}' }],
      structuredContent: { order: { id: 'A1', status: 'open' } },
      isError: false,
    });
  });

  it('returns a connector failure as an isError result with HTTP 200', async () => {
    const url = await start({ failing: true });
    const call = await fetch(url, {
      method: 'POST',
      headers: VERSIONED,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'get_order', arguments: { order_id: 'A1' } },
      }),
    });
    expect(call.status).toBe(200);
    expect((await call.json()).result.isError).toBe(true);
  });

  it('returns 202 for a notification', async () => {
    const url = await start();
    const res = await fetch(url, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });

  it('returns 202 for a JSON-RPC response-shaped body', async () => {
    const url = await start();
    const res = await fetch(url, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }),
    });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });

  it('rejects a disallowed Origin with 403', async () => {
    const url = await start({ allowedOrigins: ['https://trusted.example'] });
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...JSON_HEADERS, origin: 'https://evil.example' },
      body: JSON.stringify(INIT),
    });
    expect(res.status).toBe(403);
  });

  it('honors predicate origin policies', async () => {
    const url = await start({
      allowedOrigins: (origin) => origin.endsWith('.trusted.example'),
    });
    const allowed = await fetch(url, {
      method: 'POST',
      headers: { ...JSON_HEADERS, origin: 'https://app.trusted.example' },
      body: JSON.stringify(INIT),
    });
    expect(allowed.status).toBe(200);

    const denied = await fetch(url, {
      method: 'POST',
      headers: { ...JSON_HEADERS, origin: 'https://evil.example' },
      body: JSON.stringify(INIT),
    });
    expect(denied.status).toBe(403);
  });

  it('serves a custom endpoint path and returns 404 at the default endpoint', async () => {
    const target: ServedArtifact = { artifact: artifact(), deps: deps() };
    running = await serveHttp({ target, port: 0, endpoint: '/custom-mcp' });
    const ok = await fetch(running.url, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(INIT),
    });
    expect(ok.status).toBe(200);

    const missing = await fetch(running.url.replace('/custom-mcp', '/mcp'), {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(INIT),
    });
    expect(missing.status).toBe(404);
  });

  it('returns 405 for GET (no server-initiated SSE stream)', async () => {
    const url = await start();
    const res = await fetch(url, { method: 'GET', headers: { accept: 'text/event-stream' } });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });

  it('returns 400 for an unsupported MCP-Protocol-Version on a non-initialize request', async () => {
    const url = await start();
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'mcp-protocol-version': '2099-01-01' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(res.status).toBe(400);
  });

  it('defaults the protocol version when a non-initialize request omits the header (stateless leniency)', async () => {
    // The SDK stateless transport defaults to the negotiated version when the header is absent, rather
    // than the strict 400 the hand-rolled front-door used to return (a documented conformance delta).
    const url = await start();
    const res = await fetch(url, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).result.tools[0].name).toBe('get_order');
  });

  it('returns 400 for malformed JSON', async () => {
    const url = await start();
    const res = await fetch(url, { method: 'POST', headers: JSON_HEADERS, body: '{ not json' });
    expect(res.status).toBe(400);
  });

  it('returns 406 when the client accepts neither JSON nor event-stream', async () => {
    const url = await start();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/plain' },
      body: JSON.stringify(INIT),
    });
    expect(res.status).toBe(406);
  });

  it('returns 415 when POST content type is missing', async () => {
    const url = await start();
    const res = await postWithNodeHttp(url, INIT, { accept: ACCEPT });
    expect(res.status).toBe(415);
  });

  it('returns 415 when POST content type is not JSON', async () => {
    const url = await start();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', accept: ACCEPT },
      body: JSON.stringify(INIT),
    });
    expect(res.status).toBe(415);
  });

  it('returns 406 when the client accepts only JSON', async () => {
    const url = await start();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(INIT),
    });
    expect(res.status).toBe(406);
  });

  it('returns 406 when the client omits Accept', async () => {
    const url = await start();
    const res = await postWithoutAccept(url, INIT);
    expect(res.status).toBe(406);
  });

  it('rejects a non-compliant Accept (the SDK does not honor wildcards) with 406', async () => {
    // The MCP spec requires `Accept: application/json, text/event-stream`; the SDK enforces both
    // literal types and rejects `*/*` or `application/*`, unlike the old lenient front-door parser.
    const url = await start();
    for (const accept of ['*/*', 'application/*']) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept },
        body: JSON.stringify(INIT),
      });
      expect(res.status).toBe(406);
    }
  });

  it('accepts repeated Accept header values when together they cover required response types', async () => {
    const url = await start();
    const res = await postWithNodeHttp(url, INIT, {
      'content-type': 'application/json',
      accept: ['application/json', 'text/event-stream'],
    });
    expect(res.status).toBe(200);
  });

  it('returns 413 for an oversized request body', async () => {
    const url = await start({ maxBodyBytes: 10 });
    const res = await fetch(url, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(INIT),
    });
    expect(res.status).toBe(413);
  });

  it('returns 404 for a request to the wrong endpoint', async () => {
    const url = await start();
    const res = await fetch(url.replace('/mcp', '/wrong'), {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(INIT),
    });
    expect(res.status).toBe(404);
  });
});
