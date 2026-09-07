import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type AlertRuleStore,
  type CreateAlertRuleInput,
  InMemoryAlertRuleStore,
  JsonFileAlertRuleStore,
  PostgresAlertRuleStore,
} from '../src/index.js';

/**
 * Alert-rule store parity suite (analytics alerting E2): the in-memory, JSON-file, and Postgres
 * backends must agree on create/list/get/delete semantics, tenant scoping, enabled-only evaluator
 * reads, edge-trigger firing-state persistence, and input validation. Postgres runs only when
 * `DATABASE_URL_TEST` points at a disposable local database (mirrors `request-events-store.test.ts`).
 */

const REF = { org: 'acme', app: 'support', env: 'prod' } as const;
const SECRET_URL = 'https://hooks.example.com/T000/B000/secret-hook-token';

function input(overrides: Partial<CreateAlertRuleInput> = {}): CreateAlertRuleInput {
  return {
    orgSlug: 'acme',
    appSlug: 'support',
    environment: 'prod',
    metric: 'error_share',
    threshold: 0.25,
    windowMinutes: 15,
    webhookUrl: SECRET_URL,
    createdBySubject: 'owner-sub',
    ...overrides,
  };
}

function alertRuleStoreBehavior(label: string, makeStore: () => AlertRuleStore): void {
  describe(label, () => {
    it('creates a rule with defaults and round-trips it', async () => {
      const store = makeStore();
      const record = await store.createAlertRule(input({ name: 'error spike' }));
      expect(record.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(record.comparison).toBe('>=');
      expect(record.enabled).toBe(true);
      expect(record.cooldownMinutes).toBe(15);
      expect(record.breaching).toBe(false);
      expect(record.webhookUrl).toBe(SECRET_URL);
      const listed = await store.listAlertRules(REF);
      expect(listed.map((r) => r.id)).toEqual([record.id]);
      expect(await store.getAlertRule(REF, record.id)).toMatchObject({
        name: 'error spike',
        metric: 'error_share',
        threshold: 0.25,
        windowMinutes: 15,
      });
    });

    it('scopes list/get/delete to the tenant ref', async () => {
      const store = makeStore();
      const record = await store.createAlertRule(input());
      const otherOrg = { org: 'globex', app: 'support', env: 'prod' };
      expect(await store.listAlertRules(otherOrg)).toEqual([]);
      expect(await store.getAlertRule(otherOrg, record.id)).toBeUndefined();
      expect(await store.deleteAlertRule(otherOrg, record.id)).toBe(false);
      expect(await store.getAlertRule({ ...REF, env: 'dev' }, record.id)).toBeUndefined();
      expect(await store.deleteAlertRule(REF, record.id)).toBe(true);
      expect(await store.listAlertRules(REF)).toEqual([]);
      expect(await store.deleteAlertRule(REF, record.id)).toBe(false);
    });

    it('lists only enabled rules for the evaluator sweep', async () => {
      const store = makeStore();
      const enabled = await store.createAlertRule(input());
      await store.createAlertRule(input({ appSlug: 'other-app', enabled: false }));
      expect((await store.listEnabledAlertRules()).map((r) => r.id)).toEqual([enabled.id]);
    });

    it('persists firing state and preserves lastFiredAt when omitted', async () => {
      const store = makeStore();
      const record = await store.createAlertRule(input());
      const fired = await store.updateAlertFiringState(record.id, {
        breaching: true,
        lastObserved: 0.5,
        lastFiredAt: '2026-07-06T00:00:00.000Z',
      });
      expect(fired).toMatchObject({
        breaching: true,
        lastObserved: 0.5,
        lastFiredAt: '2026-07-06T00:00:00.000Z',
      });
      const recovered = await store.updateAlertFiringState(record.id, {
        breaching: false,
        lastObserved: 0.1,
      });
      expect(recovered).toMatchObject({
        breaching: false,
        lastObserved: 0.1,
        lastFiredAt: '2026-07-06T00:00:00.000Z',
      });
      const reread = await store.getAlertRule(REF, record.id);
      expect(reread).toMatchObject({ breaching: false, lastObserved: 0.1 });
      expect(
        await store.updateAlertFiringState('00000000-0000-4000-8000-000000000000', {
          breaching: true,
          lastObserved: 1,
        }),
      ).toBeUndefined();
    });

    it('rejects malformed create inputs', async () => {
      const store = makeStore();
      await expect(store.createAlertRule(input({ metric: 'latency' as never }))).rejects.toThrow(
        /metric/,
      );
      await expect(store.createAlertRule(input({ threshold: Number.NaN }))).rejects.toThrow(
        /threshold/,
      );
      await expect(store.createAlertRule(input({ threshold: -1 }))).rejects.toThrow(/threshold/);
      await expect(store.createAlertRule(input({ windowMinutes: 7 as never }))).rejects.toThrow(
        /window/,
      );
      await expect(store.createAlertRule(input({ cooldownMinutes: 0 }))).rejects.toThrow(
        /cooldown/,
      );
      await expect(store.createAlertRule(input({ webhookUrl: 'not a url' }))).rejects.toThrow(
        /webhookUrl/,
      );
      await expect(store.createAlertRule(input({ orgSlug: '../evil' }))).rejects.toThrow();
    });

    it('rejects a malformed rule id before it can touch storage (path-traversal guard)', async () => {
      const store = makeStore();
      await store.createAlertRule(input());
      for (const id of ['../../etc/passwd', 'x'.repeat(80), 'not-a-uuid']) {
        await expect(store.getAlertRule(REF, id)).rejects.toThrow(/rule id/i);
        await expect(store.deleteAlertRule(REF, id)).rejects.toThrow(/rule id/i);
        await expect(
          store.updateAlertFiringState(id, { breaching: true, lastObserved: 1 }),
        ).rejects.toThrow(/rule id/i);
      }
    });
  });
}

describe('InMemoryAlertRuleStore', () => {
  alertRuleStoreBehavior('behavior parity', () => new InMemoryAlertRuleStore());
});

describe('JsonFileAlertRuleStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'noodle-alert-rules-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  alertRuleStoreBehavior('behavior parity', () => new JsonFileAlertRuleStore(dir));

  it('survives a process restart (a fresh instance reads the same records)', async () => {
    const writer = new JsonFileAlertRuleStore(dir);
    const record = await writer.createAlertRule(input({ name: 'durable' }));
    const reader = new JsonFileAlertRuleStore(dir);
    expect(await reader.getAlertRule(REF, record.id)).toMatchObject({ name: 'durable' });
    expect((await reader.listEnabledAlertRules()).map((r) => r.id)).toEqual([record.id]);
  });
});

const URL = process.env.DATABASE_URL_TEST;

describe.skipIf(!URL)('PostgresAlertRuleStore (integration)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: URL, max: 3 });
    await new PostgresAlertRuleStore(pool).ensureSchema();
  });
  afterAll(async () => {
    await pool.query('DROP TABLE IF EXISTS alert_rules');
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE alert_rules');
  });

  alertRuleStoreBehavior('behavior parity', () => new PostgresAlertRuleStore(pool));

  it('creates its schema idempotently', async () => {
    const store = new PostgresAlertRuleStore(pool);
    await store.ensureSchema();
    await store.ensureSchema(); // a second call must not throw
  });
});
