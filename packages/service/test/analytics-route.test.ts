import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createServiceHandler,
  InMemoryControlPlaneStore,
  InMemoryRequestEventStore,
  ServerRegistry,
} from '../src/index.js';

/**
 * Route tests for the tenant analytics read surface (ADR 0121 Stage B):
 * `GET .../metrics`, `GET .../events`, `GET .../sessions/{id}` — org-membership gated,
 * tenant-isolated, reading the request-event store.
 */
let server: Server;
let base: string;
const events = new InMemoryRequestEventStore();

beforeAll(async () => {
  const controlPlane = new InMemoryControlPlaneStore();
  await controlPlane.addOrgMember({
    org: 'acme',
    subject: 'owner-sub',
    email: 'owner@acme.test',
    role: 'owner',
  });

  // Seed one session + three calls for acme, one event for another org (isolation probe).
  const baseEvent = {
    org: 'acme',
    app: 'support',
    env: 'prod',
    sessionSource: 'none',
    subjectKind: 'anonymous',
    kind: 'usage',
    durationMs: 50,
  } as const;
  await events.emit({
    ...baseEvent,
    requestId: 'r-init',
    sessionId: 's-1',
    method: 'initialize',
    clientName: 'claude-ai',
    clientFamily: 'claude-ai',
    protocolEra: 'legacy',
    outcome: 'ok',
  });
  await events.emit({
    ...baseEvent,
    requestId: 'assistant-session',
    sessionId: 'assistant-s-1',
    method: 'assistant',
    outcome: 'ok',
    details: {
      eventKind: 'session',
      surface: 'public',
      modelSource: 'noodle-managed',
    },
  });
  await events.emit({
    ...baseEvent,
    requestId: 'assistant-turn',
    sessionId: 'assistant-s-1',
    method: 'assistant',
    outcome: 'ok',
    durationMs: 420,
    details: {
      eventKind: 'turn',
      surface: 'public',
      modelSource: 'noodle-managed',
      assistantOutcome: 'delivered',
      turnNumber: 1,
      modelRequests: 1,
      toolCalls: 0,
      interactionCount: 0,
      promptTokens: 120,
      completionTokens: 30,
      totalTokens: 130,
    },
  });
  await events.emit({
    ...baseEvent,
    requestId: 'r-1',
    sessionId: 's-1',
    method: 'tools/call',
    toolName: 'search',
    surface: 'mcp',
    clientFamily: 'claude-ai',
    protocolEra: 'legacy',
    outcome: 'ok',
  });
  await events.emit({
    ...baseEvent,
    requestId: 'r-2',
    method: 'tools/call',
    toolName: 'refund',
    surface: 'webmcp',
    clientFamily: 'openai-mcp',
    protocolEra: 'modern',
    outcome: 'tool_error',
    errorKind: 'connector_error',
  });
  await events.emit({
    ...baseEvent,
    org: 'globex',
    requestId: 'r-other',
    method: 'tools/call',
    outcome: 'ok',
  });

  const handler = createServiceHandler(new ServerRegistry(), {
    controlPlaneStore: controlPlane,
    requestEventStore: events,
    deployGate: {
      authorize: (req) => {
        const token = (req.headers.authorization ?? '').replace('Bearer ', '');
        if (token === 'owner-token') {
          return Promise.resolve({
            ok: true as const,
            identity: { subject: 'owner-sub', email: 'o@acme.dev', superAdmin: false },
          });
        }
        return Promise.resolve({
          ok: false as const,
          status: 401 as const,
          message: 'unauthorized',
        });
      },
    },
  });
  server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

const get = (path: string, token = 'owner-token'): Promise<Response> =>
  fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });

describe('tenant analytics routes', () => {
  it('GET assistant/usage returns tenant-scoped engagement and token aggregates', async () => {
    const res = await get('/v1/orgs/acme/apps/support/envs/prod/assistant/usage?window=7d');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      metrics: {
        sessions: { minted: number; public: number };
        turns: { attempted: number; delivered: number };
        tokens: { total: number };
      };
    };
    expect(body.ok).toBe(true);
    expect(body.metrics.sessions).toMatchObject({ minted: 1, public: 1 });
    expect(body.metrics.turns).toMatchObject({ attempted: 1, delivered: 1 });
    expect(body.metrics.tokens.total).toBe(130);
  });

  it('GET metrics returns the aggregated shape for the tenant', async () => {
    const res = await get('/v1/orgs/acme/apps/support/envs/prod/metrics?window=7d');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      metrics: {
        totals: { requests: number; sessions: number; legacyInitializations: number };
        errors: { toolErrors: number };
        byTool: readonly { tool: string }[];
        byClientFamily: readonly { family: string; requests: number }[];
      };
    };
    expect(body.ok).toBe(true);
    expect(body.metrics.totals).toMatchObject({
      requests: 2,
      sessions: 1,
      legacyInitializations: 1,
    });
    expect(body.metrics.errors.toolErrors).toBe(1);
    expect(body.metrics.byTool.map((t) => t.tool)).toContain('refund');
    expect(body.metrics.byClientFamily).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ family: 'claude-ai', requests: 1 }),
        expect.objectContaining({ family: 'openai-mcp', requests: 1 }),
      ]),
    );
  });

  it('GET events supports outcome and tool filters', async () => {
    const res = await get('/v1/orgs/acme/apps/support/envs/prod/events?status=tool_error&limit=10');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; events: readonly { requestId: string }[] };
    expect(body.events.map((e) => e.requestId)).toEqual(['r-2']);
  });

  // A tenant asking "what is the browser-agent bridge actually doing on my site?" is the whole
  // reason the surface is stored; without a filter they would have to pull every event and group
  // client-side.
  it('GET events filters by originating surface, and rejects one it does not know', async () => {
    const bridged = await get('/v1/orgs/acme/apps/support/envs/prod/events?surface=webmcp');
    expect(bridged.status).toBe(200);
    const body = (await bridged.json()) as { events: readonly { requestId: string }[] };
    expect(body.events.map((e) => e.requestId)).toEqual(['r-2']);

    const mcp = await get('/v1/orgs/acme/apps/support/envs/prod/events?surface=mcp');
    expect(
      ((await mcp.json()) as { events: readonly { requestId: string }[] }).events.map(
        (e) => e.requestId,
      ),
    ).toEqual(['r-1']);

    // An unknown surface is a client error, not a silently empty page.
    expect(
      (await get('/v1/orgs/acme/apps/support/envs/prod/events?surface=carrier-pigeon')).status,
    ).toBe(400);
  });

  it('GET sessions/{id} reconstructs the session sequence oldest-first', async () => {
    const res = await get('/v1/orgs/acme/apps/support/envs/prod/sessions/s-1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; events: readonly { requestId: string }[] };
    expect(body.events.map((e) => e.requestId)).toEqual(['r-init', 'r-1']);
  });

  it('rejects a non-member with 403 (tenant isolation)', async () => {
    const res = await get('/v1/orgs/globex/apps/hello/envs/prod/metrics');
    expect(res.status).toBe(403);
  });

  it('rejects a missing token with 401', async () => {
    const res = await fetch(`${base}/v1/orgs/acme/apps/support/envs/prod/metrics`);
    expect(res.status).toBe(401);
  });

  it('rejects an out-of-range events limit with 400', async () => {
    const res = await get('/v1/orgs/acme/apps/support/envs/prod/events?limit=99999');
    expect(res.status).toBe(400);
  });

  it('rejects prototype-chain window names with 400, not a crash', async () => {
    for (const window of ['toString', '__proto__', 'constructor']) {
      const res = await get(`/v1/orgs/acme/apps/support/envs/prod/metrics?window=${window}`);
      expect(res.status).toBe(400);
    }
  });

  it('rejects an unparseable since/until timestamp with 400', async () => {
    const res = await get('/v1/orgs/acme/apps/support/envs/prod/metrics?since=garbage');
    expect(res.status).toBe(400);
  });

  it('never leaks another org into a tenant read', async () => {
    const res = await get('/v1/orgs/acme/apps/support/envs/prod/events');
    const body = (await res.json()) as { events: readonly { requestId: string }[] };
    expect(body.events.map((e) => e.requestId)).not.toContain('r-other');
  });
});

describe('tenant analytics routes with a failing store', () => {
  let failing: Server;
  let failingBase: string;

  beforeAll(async () => {
    const controlPlane = new InMemoryControlPlaneStore();
    await controlPlane.addOrgMember({
      org: 'acme',
      subject: 'owner-sub',
      email: 'owner@acme.test',
      role: 'owner',
    });
    const handler = createServiceHandler(new ServerRegistry(), {
      controlPlaneStore: controlPlane,
      requestEventStore: {
        emit: () => Promise.resolve(),
        list: () => Promise.reject(new Error('store down')),
      },
      deployGate: {
        authorize: () =>
          Promise.resolve({
            ok: true as const,
            identity: { subject: 'owner-sub', email: 'o@acme.dev', superAdmin: false },
          }),
      },
    });
    failing = createServer(handler);
    await new Promise<void>((resolve) => failing.listen(0, '127.0.0.1', resolve));
    failingBase = `http://127.0.0.1:${(failing.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      failing.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it('surfaces store failures as 500, never 400', async () => {
    for (const path of [
      '/v1/orgs/acme/apps/support/envs/prod/metrics',
      '/v1/orgs/acme/apps/support/envs/prod/events',
      '/v1/orgs/acme/apps/support/envs/prod/sessions/s-1',
    ]) {
      const res = await fetch(`${failingBase}${path}`, {
        headers: { authorization: 'Bearer owner-token' },
      });
      expect(res.status).toBe(500);
    }
  });
});
