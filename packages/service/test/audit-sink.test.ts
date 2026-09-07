import { type Logger, noopLogger } from '@noodle-borg/transport-http';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type AuditSink,
  type AuditStore,
  InMemoryAuditStore,
  MultiSink,
  PostgresAuditStore,
  StdoutAuditSink,
} from '../src/index.js';

/**
 * Shared behaviour suite for the {@link AuditStore} port, run against both the in-memory and Postgres
 * adapters so the system-of-record contract is identical across backends (the parity pattern used by the
 * other stores). `advance(ms)` moves the injected clock so newest-first ordering is exercised deterministically.
 */
function auditStoreBehavior(
  name: string,
  makeStore: () => { store: AuditStore; advance(ms: number): void },
): void {
  describe(name, () => {
    let store: AuditStore;
    let advance: (ms: number) => void;
    beforeEach(() => {
      ({ store, advance } = makeStore());
    });

    it('round-trips emit -> list for a tenant', async () => {
      await store.emit({
        eventType: 'deploy.accepted',
        org: 'acme',
        app: 'hello',
        env: 'prod',
        deploymentId: 'hello-abcd1234',
        actorSubject: 'sub-1',
        actorEmail: 'dev@noodleseed.com',
      });
      const events = await store.list({ org: 'acme' });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        eventType: 'deploy.accepted',
        org: 'acme',
        app: 'hello',
        env: 'prod',
        deploymentId: 'hello-abcd1234',
        actorSubject: 'sub-1',
        actorEmail: 'dev@noodleseed.com',
        schemaVersion: 1,
      });
      expect(events[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(typeof events[0]?.createdAt).toBe('string');
    });

    it('returns events newest-first', async () => {
      await store.emit({ eventType: 'a', org: 'acme' });
      advance(1000);
      await store.emit({ eventType: 'b', org: 'acme' });
      advance(1000);
      await store.emit({ eventType: 'c', org: 'acme' });
      const events = await store.list({ org: 'acme' });
      expect(events.map((e) => e.eventType)).toEqual(['c', 'b', 'a']);
    });

    it('isolates tenants', async () => {
      await store.emit({ eventType: 'x', org: 'acme' });
      await store.emit({ eventType: 'y', org: 'globex' });
      expect((await store.list({ org: 'acme' })).map((e) => e.eventType)).toEqual(['x']);
      expect((await store.list({ org: 'globex' })).map((e) => e.eventType)).toEqual(['y']);
    });

    it('filters by app/env and eventType', async () => {
      await store.emit({ eventType: 'deploy.accepted', org: 'acme', app: 'hello', env: 'prod' });
      await store.emit({ eventType: 'config.secret.set', org: 'acme', app: 'hello', env: 'prod' });
      await store.emit({ eventType: 'deploy.accepted', org: 'acme', app: 'other', env: 'prod' });
      expect(await store.list({ org: 'acme', app: 'hello' })).toHaveLength(2);
      expect(
        await store.list({ org: 'acme', app: 'hello', eventType: 'deploy.accepted' }),
      ).toHaveLength(1);
      expect(await store.list({ org: 'acme', eventType: 'deploy.accepted' })).toHaveLength(2);
    });

    it('respects the list limit', async () => {
      for (let i = 0; i < 5; i++) {
        await store.emit({ eventType: `e${i}`, org: 'acme' });
        advance(1000);
      }
      expect(await store.list({ org: 'acme', limit: 2 })).toHaveLength(2);
    });

    it('coerces status to string and preserves decision/reasonCode', async () => {
      await store.emit({
        eventType: 'deploy.rejected',
        org: 'acme',
        status: 400,
        decision: 'deny',
        reasonCode: 'invalid_manifest',
      });
      const [event] = await store.list({ org: 'acme' });
      expect(event).toMatchObject({
        status: '400',
        decision: 'deny',
        reasonCode: 'invalid_manifest',
      });
    });

    it('redacts non-scalar details to a marker — no raw object reaches the row', async () => {
      await store.emit({
        eventType: 'x',
        org: 'acme',
        details: {
          name: 'API_KEY',
          count: 3,
          flag: true,
          leak: { token: 'sk-super-secret' },
        },
      });
      const [event] = await store.list({ org: 'acme' });
      expect(event?.details).toEqual({
        name: 'API_KEY',
        count: 3,
        flag: true,
        leak: '[unloggable]',
      });
      expect(JSON.stringify(event)).not.toContain('sk-super-secret');
    });
  });
}

auditStoreBehavior('InMemoryAuditStore', () => {
  let now = Date.parse('2026-06-13T00:00:00.000Z');
  return {
    store: new InMemoryAuditStore({ now: () => new Date(now) }),
    advance(ms: number) {
      now += ms;
    },
  };
});

const URL = process.env.DATABASE_URL_TEST;

describe.skipIf(!URL)('PostgresAuditStore (integration)', () => {
  let pool: Pool;
  let now = Date.parse('2026-06-13T00:00:00.000Z');

  beforeAll(async () => {
    pool = new Pool({ connectionString: URL, max: 3 });
    await new PostgresAuditStore(pool).ensureSchema();
  });
  afterAll(async () => {
    await pool.query('DROP TABLE IF EXISTS audit_events');
    await pool.end();
  });
  beforeEach(async () => {
    now = Date.parse('2026-06-13T00:00:00.000Z');
    await pool.query('TRUNCATE audit_events');
  });

  auditStoreBehavior('PostgresAuditStore parity', () => ({
    store: new PostgresAuditStore(pool, { now: () => new Date(now) }),
    advance(ms: number) {
      now += ms;
    },
  }));

  it('creates its schema idempotently', async () => {
    const store = new PostgresAuditStore(pool);
    await store.ensureSchema();
    await store.ensureSchema(); // a second call must not throw
  });
});

describe('MultiSink', () => {
  it('fans an event out to the primary and every mirror', async () => {
    const primary = new InMemoryAuditStore();
    const mirror = new InMemoryAuditStore();
    const sink = new MultiSink(primary, [mirror]);
    await sink.emit({ eventType: 'x', org: 'acme' });
    expect(await primary.list({ org: 'acme' })).toHaveLength(1);
    expect(await mirror.list({ org: 'acme' })).toHaveLength(1);
  });

  it('a failing mirror neither blocks the primary nor throws to the caller', async () => {
    const primary = new InMemoryAuditStore();
    const failing: AuditSink = { emit: () => Promise.reject(new Error('mirror down')) };
    const sink = new MultiSink(primary, [failing]);
    await expect(sink.emit({ eventType: 'x', org: 'acme' })).resolves.toBeUndefined();
    expect(await primary.list({ org: 'acme' })).toHaveLength(1);
  });

  it('a failing primary surfaces (the durability guarantee)', async () => {
    const failing: AuditSink = { emit: () => Promise.reject(new Error('sor down')) };
    const sink = new MultiSink(failing, []);
    await expect(sink.emit({ eventType: 'x', org: 'acme' })).rejects.toThrow('sor down');
  });

  it('fans a transactionally committed event only to mirrors', async () => {
    const primary = new InMemoryAuditStore();
    const mirror = new InMemoryAuditStore();
    const sink = new MultiSink(primary, [mirror]);

    await sink.emitMirrors({ eventType: 'x', org: 'acme' });

    await expect(primary.list({ org: 'acme' })).resolves.toHaveLength(0);
    await expect(mirror.list({ org: 'acme' })).resolves.toHaveLength(1);
  });
});

describe('StdoutAuditSink', () => {
  it('writes one redacted audit.<type> line through the logger', async () => {
    const calls: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const logger: Logger = {
      ...noopLogger,
      info: (event, fields) => calls.push({ event, fields }),
    };
    const sink = new StdoutAuditSink(logger);
    await sink.emit({
      eventType: 'config.secret.set',
      org: 'acme',
      app: 'hello',
      env: 'prod',
      actorSubject: 'sub-1',
      details: { name: 'API_KEY', leak: { token: 'sk-secret' } },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.event).toBe('audit.config.secret.set');
    expect(calls[0]?.fields).toMatchObject({
      org: 'acme',
      app: 'hello',
      env: 'prod',
      name: 'API_KEY',
    });
    expect(JSON.stringify(calls[0]?.fields)).not.toContain('sk-secret');
  });
});
