import type { RequestEventInput, RequestEventStore } from '@noodle-borg/module';
import { InMemoryRequestEventStore, PostgresRequestEventStore } from '@noodle-borg/observability';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

function base(overrides: Partial<RequestEventInput> = {}): RequestEventInput {
  return {
    org: 'acme',
    app: 'support',
    env: 'prod',
    requestId: 'req-1',
    sessionSource: 'none',
    subjectKind: 'anonymous',
    method: 'tools/call',
    kind: 'usage',
    outcome: 'ok',
    durationMs: 42,
    ...overrides,
  };
}

/** Shared behavior contract both stores must satisfy (mirrors `auditStoreBehavior`). */
function requestEventStoreBehavior(name: string, setup: () => RequestEventStore): void {
  describe(name, () => {
    it('emits and lists newest-first, scoped to the tenant', async () => {
      const store = setup();
      await store.emit(base({ requestId: 'a', toolName: 'search_orders' }));
      await store.emit(base({ requestId: 'b', toolName: 'create_ticket' }));
      await store.emit(base({ org: 'globex', requestId: 'c' }));

      const events = await store.list({ org: 'acme' });
      expect(events.map((e) => e.requestId)).toEqual(['b', 'a']);
      expect(events.every((e) => e.org === 'acme')).toBe(true);
      expect(events[0]?.id).toBeTypeOf('string');
      expect(events[0]?.schemaVersion).toBe(3);
      expect(events[0]?.createdAt).toBeTypeOf('string');
    });

    // Both stores must agree about the surface or the analytics reader gets a different answer
    // depending on which one is configured, which is exactly the class of bug the parity contract
    // exists to prevent. The unattributed row matters too: every row written before v3 has no
    // surface, and reading one back must not invent a value or drop the row.
    it('round-trips the surface, filters by it, and leaves an unattributed row unattributed', async () => {
      const store = setup();
      await store.emit(base({ requestId: 'mcp1', surface: 'mcp' }));
      await store.emit(base({ requestId: 'bridge1', surface: 'webmcp' }));
      await store.emit(base({ requestId: 'panel1', surface: 'assistant-public' }));
      await store.emit(base({ requestId: 'legacy1' }));

      const all = await store.list({ org: 'acme' });
      expect(all.find((e) => e.requestId === 'bridge1')?.surface).toBe('webmcp');
      expect(all.find((e) => e.requestId === 'legacy1')?.surface).toBeUndefined();

      const bridged = await store.list({ org: 'acme', surface: 'webmcp' });
      expect(bridged.map((e) => e.requestId)).toEqual(['bridge1']);
      // A surface filter must not sweep up the unattributed rows as a side effect.
      const mcp = await store.list({ org: 'acme', surface: 'mcp' });
      expect(mcp.map((e) => e.requestId)).toEqual(['mcp1']);
    });

    it('filters by two-tier outcome, tool, client, and session', async () => {
      const store = setup();
      await store.emit(base({ requestId: 'ok1', toolName: 'refund_order', outcome: 'ok' }));
      await store.emit(base({ requestId: 'assistant1', method: 'assistant' }));
      await store.emit(
        base({
          requestId: 'err1',
          toolName: 'refund_order',
          outcome: 'tool_error',
          errorKind: 'connector_error',
          clientName: 'chatgpt',
        }),
      );
      await store.emit(
        base({
          requestId: 'err2',
          toolName: 'get_status',
          outcome: 'mcp_error',
          errorKind: 'timeout',
          sessionId: 's-1',
          sessionSource: 'synthetic',
        }),
      );

      const byOutcome = await store.list({ org: 'acme', outcome: 'tool_error' });
      expect(byOutcome.map((e) => e.requestId)).toEqual(['err1']);
      const byTool = await store.list({ org: 'acme', toolName: 'refund_order' });
      expect(byTool.map((e) => e.requestId)).toEqual(['err1', 'ok1']);
      const byClient = await store.list({ org: 'acme', clientName: 'chatgpt' });
      expect(byClient.map((e) => e.requestId)).toEqual(['err1']);
      const bySession = await store.list({ org: 'acme', sessionId: 's-1' });
      expect(bySession.map((e) => e.requestId)).toEqual(['err2']);
      const byMethod = await store.list({ org: 'acme', method: 'assistant' });
      expect(byMethod.map((e) => e.requestId)).toEqual(['assistant1']);
    });

    it('honors the limit', async () => {
      const store = setup();
      for (let i = 0; i < 5; i++) await store.emit(base({ requestId: `r${i}` }));
      expect(await store.list({ org: 'acme', limit: 2 })).toHaveLength(2);
    });

    it('redacts non-scalar details and never stores raw objects/arrays', async () => {
      const store = setup();
      await store.emit(base({ details: { scalar: 1, nested: { secret: 'x' }, arr: [1, 2] } }));
      const [event] = await store.list({ org: 'acme' });
      expect(event?.details?.scalar).toBe(1);
      expect(event?.details?.nested).toBe('[unloggable]');
      expect(event?.details?.arr).toBe('[unloggable]');
    });

    it('round-trips the full field set', async () => {
      const store = setup();
      await store.emit(
        base({
          deploymentId: 'dep-1',
          serverVersion: '2.0.6',
          sdkProtocolVersion: '2025-11-25',
          sessionId: 's-9',
          sessionSource: 'mcp',
          clientName: 'claude',
          clientVersion: '1.2.3',
          clientFamily: 'claude',
          accessMode: 'owner-only',
          subjectKind: 'authenticated',
          outputTokensEst: 128,
          queueMs: 3,
          execMs: 41,
          details: { connectorId: 'acme_orders', connectorCategory: 'timeout' },
        }),
      );
      const [e] = await store.list({ org: 'acme' });
      expect(e).toMatchObject({
        deploymentId: 'dep-1',
        serverVersion: '2.0.6',
        sdkProtocolVersion: '2025-11-25',
        sessionId: 's-9',
        sessionSource: 'mcp',
        clientName: 'claude',
        clientVersion: '1.2.3',
        clientFamily: 'claude',
        accessMode: 'owner-only',
        subjectKind: 'authenticated',
        outputTokensEst: 128,
        queueMs: 3,
        execMs: 41,
        details: { connectorId: 'acme_orders', connectorCategory: 'timeout' },
      });
    });
  });
}

describe('InMemoryRequestEventStore', () => {
  requestEventStoreBehavior('behavior parity', () => new InMemoryRequestEventStore());

  it('bounds memory to the ring cap by dropping oldest', async () => {
    const store = new InMemoryRequestEventStore(3);
    for (let i = 0; i < 5; i++) await store.emit(base({ requestId: `r${i}` }));
    expect((await store.list({ org: 'acme' })).map((e) => e.requestId)).toEqual(['r4', 'r3', 'r2']);
  });
});

const URL = process.env.DATABASE_URL_TEST;

describe.skipIf(!URL)('PostgresRequestEventStore (integration)', () => {
  let pool: Pool;
  let now = Date.parse('2026-07-05T00:00:00.000Z');

  beforeAll(async () => {
    pool = new Pool({ connectionString: URL, max: 3 });
    await new PostgresRequestEventStore(pool).ensureSchema();
  });
  afterAll(async () => {
    await pool.query('DROP TABLE IF EXISTS request_events');
    await pool.end();
  });
  beforeEach(async () => {
    now = Date.parse('2026-07-05T00:00:00.000Z');
    await pool.query('TRUNCATE request_events');
  });

  requestEventStoreBehavior(
    'behavior parity',
    () =>
      new PostgresRequestEventStore(pool, {
        now: () => {
          now += 1000; // strictly-increasing clock so each emit gets a distinct created_at
          return new Date(now);
        },
      }),
  );

  it('creates its schema idempotently', async () => {
    const store = new PostgresRequestEventStore(pool);
    await store.ensureSchema();
    await store.ensureSchema(); // a second call must not throw
  });

  it('prunes events older than the retention window', async () => {
    const store = new PostgresRequestEventStore(pool, { now: () => new Date(now) });
    await store.emit(base({ requestId: 'old' }));
    now += 8 * 24 * 60 * 60 * 1000; // 8 days later
    await store.emit(base({ requestId: 'fresh' }));

    const pruned = await store.prune(new Date(now - 7 * 24 * 60 * 60 * 1000));
    expect(pruned).toBe(1);
    expect((await store.list({ org: 'acme' })).map((e) => e.requestId)).toEqual(['fresh']);
  });
});
