import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OperationSignature, RuntimeArtifact } from '@noodle-borg/compiler';
import type { IntentEventInput, RequestEventInput } from '@noodle-borg/module';
import type { ServedArtifact } from '@noodle-borg/protocol';
import {
  type ExecuteDeps,
  InMemoryConnector,
  InMemoryConnectorRegistry,
  StaticServiceBroker,
} from '@noodle-borg/runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpRouter } from '../src/index.js';

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

function deps(): ExecuteDeps {
  const connector = new InMemoryConnector('acme_orders', '1.2.0', {
    get_order: {
      signature: getOrderSig,
      handler: (args) => ({ order: { id: args.id, status: 'open' } }),
    },
  });
  return {
    connectors: new InMemoryConnectorRegistry([connector]),
    broker: new StaticServiceBroker({ token: 'svc' }),
  };
}

const VERSIONED = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'mcp-protocol-version': '2025-11-25',
};

const INIT = {
  jsonrpc: '2.0' as const,
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'claude-ai', version: '0.1.0' },
  },
};

const CALL = {
  jsonrpc: '2.0' as const,
  id: 2,
  method: 'tools/call',
  params: { name: 'get_order', arguments: { order_id: 'o-1' } },
};

const LIST = { jsonrpc: '2.0' as const, id: 3, method: 'tools/list' };

let server: Server;

async function start(events: RequestEventInput[], intents?: IntentEventInput[]): Promise<string> {
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as RuntimeArtifact;
  const target: ServedArtifact = { artifact, deps: deps() };
  const handler = createMcpRouter(() => Promise.resolve(undefined), {
    tenantLookup: () =>
      Promise.resolve({
        served: target,
        deploymentId: 'dep-1',
        org: 'acme',
        ...(intents === undefined ? {} : { intentCaptureMode: 'starter-v1' as const }),
      }),
    captureRequestEvent: (event) => events.push(event),
    ...(intents === undefined ? {} : { captureIntentEvent: (event) => intents.push(event) }),
  });
  server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${address.port}/o/acme/support/mcp`;
}

afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

async function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, { method: 'POST', headers: VERSIONED, body: JSON.stringify(body) });
}

describe('transport request-event capture', () => {
  it('captures initialize with client identity and tenant scope', async () => {
    const events: RequestEventInput[] = [];
    const url = await start(events);
    const res = await post(url, INIT);
    expect(res.status).toBe(200);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      org: 'acme',
      app: 'support',
      env: 'prod',
      deploymentId: 'dep-1',
      method: 'initialize',
      kind: 'discovery',
      outcome: 'ok',
      subjectKind: 'anonymous',
      sessionSource: 'none',
      clientName: 'claude-ai',
      clientVersion: '0.1.0',
      sdkProtocolVersion: '2025-11-25',
      protocolEra: 'legacy',
      surface: 'mcp',
    });
    expect(events[0]?.requestId).toBeTypeOf('string');
    expect(events[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('captures a tools/call with the observed tool outcome', async () => {
    const events: RequestEventInput[] = [];
    const url = await start(events);
    const res = await post(url, CALL);
    expect(res.status).toBe(200);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      method: 'tools/call',
      kind: 'usage',
      toolName: 'get_order',
      outcome: 'ok',
    });
    expect(events[0]?.outputTokensEst).toBeGreaterThan(0);
  });

  // Every event this transport emits comes from a real MCP request, so the surface is a constant
  // here rather than something derived. It is stamped anyway: an unstamped row is indistinguishable
  // from a pre-v3 row, and the whole point of the field is that a reader can group by it.
  it('attributes every captured request to the mcp surface', async () => {
    const events: RequestEventInput[] = [];
    const url = await start(events);
    expect((await post(url, INIT)).status).toBe(200);
    expect((await post(url, CALL)).status).toBe(200);

    expect(events).toHaveLength(2);
    expect(events.map((event) => event.surface)).toEqual(['mcp', 'mcp']);
  });

  it('captures validated intent separately with the request correlation id', async () => {
    const events: RequestEventInput[] = [];
    const intents: IntentEventInput[] = [];
    const url = await start(events, intents);
    const res = await post(url, {
      ...CALL,
      params: {
        ...CALL.params,
        arguments: {
          order_id: 'o-1',
          __noodleIntent: {
            category: 'support',
            match: 'direct',
            goal: 'Check an order status',
          },
        },
      },
    });
    expect(res.status).toBe(200);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      org: 'acme',
      app: 'support',
      env: 'prod',
      toolName: 'get_order',
      category: 'support',
      match: 'direct',
      goal: 'Check an order status',
      source: 'tool_schema',
    });
    expect(intents[0]?.requestId).toBe(events[0]?.requestId);
  });

  it('tags list methods as discovery', async () => {
    const events: RequestEventInput[] = [];
    const url = await start(events);
    await post(url, LIST);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ method: 'tools/list', kind: 'discovery', outcome: 'ok' });
  });

  it('tags draft skill enumeration as discovery even when the target does not advertise it', async () => {
    const events: RequestEventInput[] = [];
    const url = await start(events);
    const method = 'skills/list';
    await fetch(url, {
      method: 'POST',
      headers: {
        ...VERSIONED,
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': method,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method,
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      method: 'skills/list',
      kind: 'discovery',
      outcome: 'mcp_error',
    });
  });

  it('emits exactly one event per request', async () => {
    const events: RequestEventInput[] = [];
    const url = await start(events);
    await post(url, INIT);
    await post(url, CALL);
    await post(url, LIST);
    expect(events).toHaveLength(3);
  });

  it('propagates a client-sent mcp-session-id as an mcp-sourced session', async () => {
    const events = [];
    const url = await start(events);
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...VERSIONED, 'mcp-session-id': 'sess-42' },
      body: JSON.stringify(CALL),
    });
    expect(res.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ sessionId: 'sess-42', sessionSource: 'mcp' });
  });

  it('records modern body-authoritative identity and never trusts modern session headers', async () => {
    const events: RequestEventInput[] = [];
    const url = await start(events);
    const method = 'tools/list';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': method,
        'mcp-session-id': 'forged-modern-session',
        'last-event-id': 'forged-resume-token',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method,
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
            'io.modelcontextprotocol/clientInfo': {
              name: 'modern-console',
              version: '2.0.0',
            },
          },
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      protocolEra: 'modern',
      sdkProtocolVersion: '2026-07-28',
      clientName: 'modern-console',
      clientVersion: '2.0.0',
      sessionSource: 'none',
    });
    expect(events[0]).not.toHaveProperty('sessionId');
  });

  it('captures nothing for malformed JSON rejected before the SDK', async () => {
    const events = [];
    const url = await start(events);
    const res = await fetch(url, { method: 'POST', headers: VERSIONED, body: '{nope' });
    expect(res.status).toBe(400);
    expect(events).toHaveLength(0);
  });

  it('a throwing capture callback never breaks the response', async () => {
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as RuntimeArtifact;
    const target: ServedArtifact = { artifact, deps: deps() };
    const handler = createMcpRouter(() => Promise.resolve(undefined), {
      tenantLookup: () => Promise.resolve({ served: target, org: 'acme' }),
      captureRequestEvent: () => {
        throw new Error('capture bug');
      },
    });
    server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const res = await post(`http://127.0.0.1:${address.port}/o/acme/support/mcp`, CALL);
    expect(res.status).toBe(200);
  });
});
