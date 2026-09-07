import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OperationSignature, RuntimeArtifact } from '@noodle-borg/compiler';
import type { RequestEventInput } from '@noodle-borg/module';
import type { ServedArtifact } from '@noodle-borg/protocol';
import {
  ConnectorInvocationError,
  type ExecuteDeps,
  InMemoryConnector,
  InMemoryConnectorRegistry,
  StaticServiceBroker,
} from '@noodle-borg/runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clientFamily, SessionClientMemo } from '../src/client-identity.js';
import { createMcpRouter, type ServedTarget } from '../src/index.js';
import { resetSessionClientMemo } from '../src/request-capture.js';

/**
 * Safe client + connector failure attribution (#1309): session-correlated legacy client identity,
 * bounded user-agent families, queue/exec timing, connector failure details, front-door denial
 * events, and the negative retention proofs (headers, bodies, tokens never reach an event).
 */

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

function deps(options: { failingCategory?: 'timeout' | 'upstream_5xx' } = {}): ExecuteDeps {
  const connector = new InMemoryConnector('acme_orders', '1.2.0', {
    get_order: {
      signature: getOrderSig,
      handler:
        options.failingCategory === undefined
          ? (args) => ({ order: { id: args.id, status: 'open' } })
          : () => {
              throw new ConnectorInvocationError('upstream said no: Bearer sk-upstream-secret', {
                category: options.failingCategory,
                ...(options.failingCategory === 'upstream_5xx'
                  ? { status: 503, attempts: 3, retryable: true }
                  : {}),
                responseExcerpt: 'raw upstream body with sk-upstream-secret',
              });
            },
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

let server: Server | undefined;

async function start(
  events: RequestEventInput[],
  options: {
    failingCategory?: 'timeout' | 'upstream_5xx';
    target?: Partial<ServedTarget>;
  } = {},
): Promise<string> {
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as RuntimeArtifact;
  const target: ServedArtifact = {
    artifact,
    deps: deps(
      options.failingCategory === undefined ? {} : { failingCategory: options.failingCategory },
    ),
  };
  const handler = createMcpRouter(() => Promise.resolve(undefined), {
    tenantLookup: () =>
      Promise.resolve({
        served: target,
        deploymentId: 'dep-1',
        org: 'acme',
        ...options.target,
      }),
    captureRequestEvent: (event) => events.push(event),
  });
  server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${address.port}/o/acme/support/mcp`;
}

beforeEach(() => {
  resetSessionClientMemo();
});

afterEach(async () => {
  const running = server;
  server = undefined;
  if (running === undefined) return;
  await new Promise<void>((resolve, reject) =>
    running.close((err) => (err ? reject(err) : resolve())),
  );
});

async function post(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { ...VERSIONED, ...headers },
    body: JSON.stringify(body),
  });
}

describe('legacy session client correlation', () => {
  it('recalls initialize clientInfo for later requests on the same session', async () => {
    const events: RequestEventInput[] = [];
    const url = await start(events);
    await post(url, INIT, { 'mcp-session-id': 'sess-1' });
    await post(url, CALL, { 'mcp-session-id': 'sess-1' });

    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      method: 'tools/call',
      clientName: 'claude-ai',
      clientVersion: '0.1.0',
      clientFamily: 'claude-ai',
      sessionId: 'sess-1',
    });
  });

  it('does not recall identity across different sessions', async () => {
    const events: RequestEventInput[] = [];
    const url = await start(events);
    await post(url, INIT, { 'mcp-session-id': 'sess-1' });
    await post(url, CALL, { 'mcp-session-id': 'sess-other' });

    expect(events[1]?.clientName).toBeUndefined();
  });

  it('leaves legacy requests without a session id unattributed by name', async () => {
    const events: RequestEventInput[] = [];
    const url = await start(events);
    await post(url, INIT);
    await post(url, CALL);
    expect(events[1]?.clientName).toBeUndefined();
  });
});

describe('bounded client family projection', () => {
  it('maps a known user agent to its family when clientInfo is absent', async () => {
    const events: RequestEventInput[] = [];
    const url = await start(events);
    await post(url, CALL, { 'user-agent': 'undici/6.19.2' });
    expect(events[0]).toMatchObject({ clientFamily: 'undici' });
    expect(events[0]?.clientName).toBeUndefined();
  });

  it('marks an unrecognized user agent as other, never retaining the raw string', async () => {
    const events: RequestEventInput[] = [];
    const url = await start(events);
    const junkAgent = 'load-blaster/9.9 (deadbeef-cafe; +http://example.invalid)';
    await post(url, CALL, { 'user-agent': junkAgent });
    expect(events[0]).toMatchObject({ clientFamily: 'other' });
    expect(JSON.stringify(events)).not.toContain('load-blaster');
    expect(JSON.stringify(events)).not.toContain('deadbeef');
  });

  it('explicitly represents an unknown client', async () => {
    const events: RequestEventInput[] = [];
    const url = await start(events);
    await fetch(url, { method: 'POST', headers: VERSIONED, body: JSON.stringify(CALL) });
    expect(events[0]).toMatchObject({ clientFamily: expect.stringMatching(/^(unknown|node)$/) });
  });

  it('bounds oversized clientInfo values before retention', async () => {
    const events: RequestEventInput[] = [];
    const url = await start(events);
    const huge = 'x'.repeat(4000);
    await post(url, {
      ...INIT,
      params: { ...INIT.params, clientInfo: { name: huge, version: huge } },
    });
    expect(events[0]?.clientName?.length).toBeLessThanOrEqual(128);
    expect(events[0]?.clientVersion?.length).toBeLessThanOrEqual(64);
    expect(events[0]?.clientFamily?.length).toBeLessThanOrEqual(32);
  });
});

describe('queue/exec latency split', () => {
  it('records front-door wait and protocol execution separately', async () => {
    const events: RequestEventInput[] = [];
    const url = await start(events);
    await post(url, CALL);
    const event = events[0];
    expect(event?.queueMs).toBeGreaterThanOrEqual(0);
    expect(event?.execMs).toBeGreaterThanOrEqual(0);
    expect((event?.queueMs ?? 0) + (event?.execMs ?? 0)).toBeLessThanOrEqual(
      (event?.durationMs ?? 0) + 1,
    );
  });
});

describe('connector failure attribution', () => {
  it('retains the stable failure stage, connector, and operation — never upstream content', async () => {
    const events: RequestEventInput[] = [];
    // Legitimate identifiers can contain status-like digits (including a random request UUID).
    const url = await start(events, {
      failingCategory: 'upstream_5xx',
      target: { deploymentId: 'dep-503' },
    });
    const res = await post(url, CALL);
    expect(res.status).toBe(200); // tool errors are isError results, not HTTP failures

    expect(events[0]).toMatchObject({
      method: 'tools/call',
      deploymentId: 'dep-503',
      toolName: 'get_order',
      outcome: 'tool_error',
      errorKind: 'connector_error.upstream_5xx',
    });
    // Exact keys reject raw status/excerpt fields without mistaking IDs or durations for leaks.
    expect(events[0]?.details).toEqual({
      connectorId: 'acme_orders',
      connectorVersion: '1.2.0',
      connectorOperation: 'get_order',
      connectorCategory: 'upstream_5xx',
      connectorStatusClass: '5xx',
      connectorAttempts: 3,
      connectorRetryable: true,
    });
    const retained = JSON.stringify(events);
    expect(retained).not.toContain('sk-upstream-secret');
    expect(retained).not.toContain('raw upstream body');
    expect(events[0]).not.toHaveProperty('status');
    expect(events[0]).not.toHaveProperty('responseExcerpt');
  });

  it('carries the same attribution on the modern era end to end', async () => {
    const events: RequestEventInput[] = [];
    const url = await start(events, { failingCategory: 'timeout' });
    const method = 'tools/call';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': method,
        'mcp-name': 'get_order',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 9,
        method,
        params: {
          name: 'get_order',
          arguments: { order_id: 'o-1' },
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
            'io.modelcontextprotocol/clientInfo': { name: 'modern-console', version: '2.0.0' },
          },
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(events[0]).toMatchObject({
      protocolEra: 'modern',
      clientName: 'modern-console',
      clientFamily: 'modern-console',
      outcome: 'tool_error',
      errorKind: 'connector_error.timeout',
      details: { connectorId: 'acme_orders', connectorCategory: 'timeout' },
    });
  });

  it('distinguishes a connector timeout from other connector failures', async () => {
    const events: RequestEventInput[] = [];
    const url = await start(events, { failingCategory: 'timeout' });
    await post(url, CALL);
    expect(events[0]).toMatchObject({
      errorKind: 'connector_error.timeout',
      details: { connectorCategory: 'timeout' },
    });
  });
});

describe('front-door denial attribution', () => {
  it('retains an auth_denied event with a bounded reason for a missing bearer token', async () => {
    const events: RequestEventInput[] = [];
    const url = await start(events, { target: { accessMode: 'authenticated' } });
    const res = await post(url, CALL, { 'user-agent': 'undici/6.19.2' });
    expect(res.status).toBe(401);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      outcome: 'mcp_error',
      errorKind: 'auth_denied.missing_token',
      subjectKind: 'anonymous',
      clientFamily: 'undici',
      method: 'unknown', // denial happens before the body is read
    });
  });

  it('never retains the rejected bearer token or any header value', async () => {
    const events: RequestEventInput[] = [];
    const url = await start(events, { target: { accessMode: 'authenticated' } });
    const res = await post(url, CALL, {
      authorization: 'Bearer super-secret-bearer-token',
      cookie: 'session=cookie-secret',
    });
    expect(res.status).toBe(401);
    expect(events[0]?.errorKind).toBe('auth_denied.verifier_unavailable');
    const retained = JSON.stringify(events);
    expect(retained).not.toContain('super-secret-bearer-token');
    expect(retained).not.toContain('cookie-secret');
    expect(retained).not.toContain('authorization');
  });
});

describe('negative retention proofs', () => {
  it('never retains request bodies, tool arguments, or continuation material', async () => {
    const events: RequestEventInput[] = [];
    const url = await start(events);
    await post(
      url,
      {
        ...CALL,
        params: {
          name: 'get_order',
          arguments: { order_id: 'order-secret-value-77' },
          _meta: { continuationToken: 'continuation-secret-88' },
        },
      },
      { authorization: 'Bearer sk-live-very-secret' },
    );
    expect(events).toHaveLength(1);
    const retained = JSON.stringify(events);
    expect(retained).not.toContain('order-secret-value-77');
    expect(retained).not.toContain('continuation-secret-88');
    expect(retained).not.toContain('sk-live-very-secret');
  });

  it('keeps anonymous requests distinguishable without inventing actor attribution', async () => {
    const events: RequestEventInput[] = [];
    const url = await start(events);
    await post(url, CALL);
    expect(events[0]).toMatchObject({ subjectKind: 'anonymous' });
    // Never an invented actor: no raw subject/email/identity fields on anonymous traffic.
    expect(events[0]).not.toHaveProperty('subject');
    expect(JSON.stringify(events)).not.toContain('email');
  });
});

describe('SessionClientMemo bounds', () => {
  it('evicts oldest entries at the cap and scopes keys by tenant', () => {
    const memo = new SessionClientMemo(2);
    memo.remember('acme///s1', { clientName: 'a' });
    memo.remember('acme///s2', { clientName: 'b' });
    memo.remember('acme///s3', { clientName: 'c' });
    expect(memo.size).toBe(2);
    expect(memo.recall('acme///s1')).toBeUndefined();
    expect(memo.recall('globex///s2')).toBeUndefined();
    expect(memo.recall('acme///s2')).toEqual({ clientName: 'b' });
  });
});

describe('clientFamily unit behavior', () => {
  it('derives bounded families from names and agents', () => {
    expect(clientFamily('Claude Desktop', undefined)).toBe('claude-desktop');
    expect(clientFamily(undefined, 'python-httpx/0.27')).toBe('python-httpx');
    expect(clientFamily(undefined, 'totally-novel-agent/1.0')).toBe('other');
    expect(clientFamily(undefined, undefined)).toBe('unknown');
  });
});
