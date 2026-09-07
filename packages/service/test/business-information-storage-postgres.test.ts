import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  NATIVE_RETAINED_BYTES_LIMIT as CAP,
  NativeStorageLimitError,
} from '../src/business-information/native-storage-budget.js';
import { PostgresBusinessInformationStore } from '../src/business-information/postgres-store.js';
import { TestPayloadCipher } from './business-information-test-cipher.js';

const databaseUrl = process.env.DATABASE_URL_TEST;
describe.skipIf(databaseUrl === undefined)('PostgreSQL atomic native custody budget', () => {
  const schema = `custody_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 6,
    options: `-c search_path=${schema}`,
  });
  const cipher = new TestPayloadCipher();
  let now = new Date('2030-01-01T00:00:00.000Z');
  const store = new PostgresBusinessInformationStore(pool, cipher, { now: () => new Date(now) });
  const scope = { org: 'acme', app: 'travel', env: 'prod', installationId: 'travel-prod' };
  const input = {
    scope,
    collectionKey: 'travel_requests',
    idempotencyKey: 'original',
    payload: { request_type: 'refund', summary: 'Original' },
    origin: { kind: 'mcp' as const },
    actorSubject: 'founder',
  };
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await store.ensureSchema();
    await store.createInstallation({
      scope,
      profileKey: 'travel',
      managedCollections: ['travel_requests'],
      actorSubject: 'founder',
    });
    await store.createRequest(input);
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
  async function total(): Promise<number> {
    return Number(
      (await pool.query('SELECT retained_bytes FROM native_record_custody')).rows[0]
        ?.retained_bytes,
    );
  }
  async function actual(): Promise<number> {
    return Number(
      (
        await pool.query(
          `SELECT (SELECT COALESCE(sum(octet_length(to_jsonb(r)::text)+CASE WHEN deleted_at IS NULL THEN 16384 ELSE 0 END),0) FROM managed_request_records r)+(SELECT COALESCE(sum(octet_length(to_jsonb(a)::text)),0) FROM managed_request_activities a) AS total`,
        )
      ).rows[0]?.total,
    );
  }

  it('backfills existing current/history rows once, preserving bytes and immutable history', async () => {
    const created = await store.createRequest(input);
    expect(created.disposition).toBe('replayed');
    expect(await total()).toBe(await actual());
    await pool.query(
      'DROP TRIGGER native_custody_record_guard ON managed_request_records; DROP TRIGGER native_custody_activity_guard ON managed_request_activities; DROP TRIGGER native_custody_installation_guard ON business_solution_installations; DROP TABLE native_record_custody',
    );
    await store.ensureSchema();
    await store.ensureSchema();
    expect(await total()).toBe(await actual());
    expect((await store.createRequest(input)).disposition).toBe('replayed');
  });

  it('serializes concurrent near-ceiling writers, rolls back history/receipt on rejection, and funds erase', async () => {
    const original = await store.createRequest(input);
    if (original.disposition !== 'replayed') throw new Error('Missing original');
    const before = await total();
    // Boundary fixture represents pre-existing charged custody without allocating a gigabyte of test data.
    await pool.query('UPDATE native_record_custody SET retained_bytes=$1', [CAP - 25000]);
    const results = await Promise.allSettled(
      ['one', 'two'].map((idempotencyKey) => store.createRequest({ ...input, idempotencyKey })),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const denied = results.find((result) => result.status === 'rejected');
    expect(denied?.status === 'rejected' && denied.reason).toBeInstanceOf(NativeStorageLimitError);
    expect(
      Number((await pool.query('SELECT count(*) FROM managed_request_records')).rows[0]?.count),
    ).toBe(2);
    expect(
      Number((await pool.query('SELECT count(*) FROM managed_request_activities')).rows[0]?.count),
    ).toBe(2);
    const charged = await total();
    expect((await store.createRequest(input)).disposition).toBe('replayed');
    expect(await total()).toBe(charged);
    await pool.query('UPDATE native_record_custody SET retained_bytes=$1', [CAP * 2]);
    // An older application writer has no helper-level guard: the database still rejects net growth.
    await expect(
      pool.query('UPDATE managed_request_records SET updated_by_subject=$1 WHERE record_id=$2', [
        'x'.repeat(256),
        original.record.id,
      ]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'managed_record_storage_limit' });
    expect(await total()).toBe(CAP * 2);
    expect(
      await store.deleteRequest({
        scope,
        collectionKey: 'travel_requests',
        id: original.record.id,
        expectedRevision: 1,
        actorSubject: 'founder',
        reason: 'customer_request',
      }),
    ).toMatchObject({ ok: true });
    expect(await total()).toBeLessThan(CAP * 2);
    expect(await total()).toBeGreaterThan(CAP);
    const history = await store.listActivity(scope, 'travel_requests', original.record.id);
    expect(history.activities.map((event) => event.kind)).toEqual(['deleted', 'created']);
    expect(history.activities.every((event) => event.content === undefined)).toBe(true);
    // Remove only the synthetic accounting baseline; retained metadata still consumes actual capacity.
    await pool.query('UPDATE native_record_custody SET retained_bytes=$1', [await actual()]);
    expect(await total()).toBeGreaterThan(0);
    expect(await total()).toBeGreaterThan(before);
  });
  it('decrypts only a bounded history window and expiry reclaims bytes without pruning revisions', async () => {
    const created = await store.createRequest({ ...input, idempotencyKey: 'long-history' });
    if (created.disposition !== 'created') throw new Error('Missing history fixture');
    for (let revision = 1; revision < 62; revision++)
      await store.mutateRequest({
        scope,
        collectionKey: 'travel_requests',
        id: created.record.id,
        expectedRevision: revision,
        actorSubject: 'founder',
        operation: { kind: 'update', payload: { summary: `Revision ${revision}` } },
      });
    const open = vi.spyOn(cipher, 'open');
    const page = await store.listActivity(scope, 'travel_requests', created.record.id);
    expect(page.activities).toHaveLength(50);
    expect(open.mock.calls.length).toBeLessThanOrEqual(52);
    open.mockRestore();
    expect(await total()).toBe(await actual());
    const before = await total();
    const revisionsBefore = Number(
      (await pool.query('SELECT count(*) FROM managed_request_activities')).rows[0]?.count,
    );
    now = new Date('2030-02-02T00:00:00.000Z');
    const expired = await store.purgeExpired({ scope, limit: 100 });
    expect(expired).toBeGreaterThan(0);
    expect(await total()).toBeLessThan(before);
    expect(await total()).toBe(await actual());
    expect(
      Number((await pool.query('SELECT count(*) FROM managed_request_activities')).rows[0]?.count),
    ).toBe(revisionsBefore + expired);
  });
});
