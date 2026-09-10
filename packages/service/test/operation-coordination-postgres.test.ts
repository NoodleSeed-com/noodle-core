import { randomUUID } from 'node:crypto';
import { SecretBox, staticMasterKeyProvider } from '@noodle-borg/runtime';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOperationCoordinationPort } from '../src/operation-coordination.js';
import { PostgresOperationCoordinationStore } from '../src/operation-coordination-postgres.js';
import {
  coordinationRecord,
  coordinationScope,
  describeOperationCoordinationStore,
} from './operation-coordination-store-suite.js';

const databaseUrl = process.env.DATABASE_URL_TEST;
describe.skipIf(databaseUrl === undefined)('PostgreSQL external operation coordination', () => {
  const schema = `operation_coordination_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 8,
    options: `-c search_path=${schema}`,
  });
  const box = new SecretBox(staticMasterKeyProvider(Buffer.alloc(32, 17).toString('base64')));
  const store = new PostgresOperationCoordinationStore(pool, box);
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await store.ensureSchema();
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
  beforeEach(async () => {
    await pool.query(
      'TRUNCATE external_operation_coordination,external_operation_coordination_resolutions',
    );
  });
  describeOperationCoordinationStore(async () => store);

  it('survives a new process/store connection while keeping references encrypted', async () => {
    const record = coordinationRecord();
    await store.claim(record);
    await store.markUnknown(record.resource, record.token);
    const restartedPool = new pg.Pool({
      connectionString: databaseUrl,
      max: 1,
      options: `-c search_path=${schema}`,
    });
    try {
      const restarted = new PostgresOperationCoordinationStore(restartedPool, box);
      expect(await restarted.claim(coordinationRecord())).toEqual({
        acquired: false,
        previous: { ...record, state: 'unknown' },
      });
      const stored = await pool.query('SELECT * FROM external_operation_coordination');
      expect(JSON.stringify(stored.rows)).not.toContain(record.reference);
      expect(JSON.stringify(stored.rows)).not.toContain(record.generation);
      expect(JSON.stringify(stored.rows)).not.toContain(record.scope.installationId);
    } finally {
      await restartedPool.end();
    }
  });

  it.each([
    'resource',
    'token',
    'scope',
  ])('rejects protected record %s substitution', async (field) => {
    const record = coordinationRecord();
    await store.claim(record);
    const changed = {
      ...record,
      [field]:
        field === 'scope'
          ? { ...record.scope, org: 'attacker' }
          : field === 'token'
            ? randomUUID()
            : 'c'.repeat(64),
    };
    const sealed = await box.seal(JSON.stringify(changed));
    await pool.query(
      'UPDATE external_operation_coordination SET protected=$1::jsonb WHERE resource=$2',
      [JSON.stringify(sealed), record.resource],
    );
    await expect(store.claim(coordinationRecord())).rejects.toThrow('coordination');
    await expect(store.release(record.resource, record.token, 'completed')).rejects.toThrow(
      'coordination',
    );
    expect(
      (await pool.query('SELECT count(*) FROM external_operation_coordination')).rows[0]?.count,
    ).toBe('1');
  });

  it('records sealed, append-only source-verified and reviewed resolution receipts atomically', async () => {
    const first = coordinationRecord();
    await store.claim(first);
    expect(await store.release(first.resource, first.token, 'source_verified')).toBe(true);
    const second = coordinationRecord();
    await store.claim(second);
    expect(
      await store.resolve(coordinationScope, second.resource, second.token, {
        reviewer: 'private-reviewer',
        reason: 'private-resolution-evidence',
      }),
    ).toBe(true);
    const stored = await pool.query(
      'SELECT * FROM external_operation_coordination_resolutions ORDER BY resolved_at',
    );
    expect(stored.rows).toHaveLength(2);
    expect(JSON.stringify(stored.rows)).not.toContain('private-');
    expect(JSON.stringify(stored.rows)).not.toContain(first.reference);
    const opened = await Promise.all(
      stored.rows.map(async (row) => JSON.parse(await box.open(row.protected))),
    );
    expect(opened).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resolution: 'source_verified', record: first }),
        expect.objectContaining({
          resolution: 'reviewed',
          reviewer: 'private-reviewer',
          reason: 'private-resolution-evidence',
          record: second,
        }),
      ]),
    );
    expect(await store.release(first.resource, first.token, 'source_verified')).toBe(false);
    expect(
      (await pool.query('SELECT count(*) FROM external_operation_coordination_resolutions')).rows[0]
        ?.count,
    ).toBe('2');
  });

  it('rolls back deletion when writing the recovery receipt fails', async () => {
    const record = coordinationRecord();
    await store.claim(record);
    await pool.query(
      'ALTER TABLE external_operation_coordination_resolutions ADD CONSTRAINT reject_receipt CHECK (false)',
    );
    try {
      await expect(
        store.release(record.resource, record.token, 'source_verified'),
      ).rejects.toThrow();
      expect((await store.claim(coordinationRecord())).previous?.token).toBe(record.token);
    } finally {
      await pool.query(
        'ALTER TABLE external_operation_coordination_resolutions DROP CONSTRAINT reject_receipt',
      );
    }
  });

  it('keeps authority across different store instances and fences generation changes through the runtime port', async () => {
    let generation = 'first-account';
    const secondStore = new PostgresOperationCoordinationStore(pool, box);
    const options = {
      scope: coordinationScope,
      identityKey: 'k'.repeat(32),
      epoch: 'current-epoch-00001',
      authorize: async () => true,
      connectionGeneration: () => generation,
    };
    const firstPort = createOperationCoordinationPort({ ...options, store });
    const secondPort = createOperationCoordinationPort({ ...options, store: secondStore });
    const intent = {
      id: 'e'.repeat(64),
      connectionId: 'provider',
      namespace: 'resource',
      key: 'item-42',
      reference: 'effect-42',
      executionBoundMs: 1000,
    };
    const first = await firstPort.acquire(intent);
    expect(first.acquired).toBe(true);
    await first.finish({ outcome: 'unknown' });
    generation = 'replacement-account';
    const replaced = await secondPort.acquire({ ...intent, id: 'f'.repeat(64) });
    expect(replaced.acquired).toBe(false);
    expect(replaced.previous).toBeUndefined();
    await expect(replaced.resolvePrevious()).rejects.toThrow();
    generation = 'first-account';
    const recovery = await secondPort.acquire({ ...intent, id: 'd'.repeat(64) });
    expect(recovery.previous?.reference).toBe('effect-42');
    await recovery.resolvePrevious();
    expect((await firstPort.acquire({ ...intent, id: 'c'.repeat(64) })).acquired).toBe(true);
  });

  it('does not fall back or unlock when PostgreSQL or the encryption key is unavailable', async () => {
    const record = coordinationRecord();
    await store.claim(record);
    const disconnectedPool = new pg.Pool({
      connectionString: databaseUrl,
      max: 1,
      options: `-c search_path=${schema}`,
    });
    const disconnected = new PostgresOperationCoordinationStore(disconnectedPool, box);
    await disconnectedPool.end();
    await expect(disconnected.claim(coordinationRecord())).rejects.toThrow();
    const wrongKey = new PostgresOperationCoordinationStore(
      pool,
      new SecretBox(staticMasterKeyProvider(Buffer.alloc(32, 99).toString('base64'))),
    );
    await expect(wrongKey.release(record.resource, record.token, 'completed')).rejects.toThrow(
      'coordination',
    );
    expect((await store.claim(coordinationRecord())).previous?.token).toBe(record.token);
  });

  it('rejects malformed sealed records without exposing the decrypted diagnostic', async () => {
    const record = coordinationRecord();
    await store.claim(record);
    const protectedValue = await box.seal('private-source-diagnostic-invalid-json');
    await pool.query('UPDATE external_operation_coordination SET protected=$1::jsonb', [
      JSON.stringify(protectedValue),
    ]);
    await expect(store.claim(coordinationRecord())).rejects.toThrow(
      'Invalid protected operation coordination record',
    );
  });

  it('enforces append-only recovery receipts at the database boundary', async () => {
    const record = coordinationRecord();
    await store.claim(record);
    await store.release(record.resource, record.token, 'source_verified');
    await expect(
      pool.query('DELETE FROM external_operation_coordination_resolutions'),
    ).rejects.toThrow('append-only');
    await expect(
      pool.query('UPDATE external_operation_coordination_resolutions SET resolved_at=1'),
    ).rejects.toThrow('append-only');
    expect(
      (await pool.query('SELECT count(*) FROM external_operation_coordination_resolutions')).rows[0]
        ?.count,
    ).toBe('1');
  });

  it('imports an unknown reviewed custody snapshot idempotently and keeps its original identity', async () => {
    const record = coordinationRecord({ state: 'unknown' });
    const target = { scope: record.scope, epoch: record.epoch, generation: record.generation };
    expect(await store.importUnknown(target, [record])).toEqual({ imported: 1, unchanged: 0 });
    expect(await store.importUnknown(target, [record])).toEqual({ imported: 0, unchanged: 1 });
    expect((await store.claim(coordinationRecord())).previous).toEqual(record);
    expect(
      (await pool.query('SELECT count(*) FROM external_operation_coordination_resolutions')).rows[0]
        ?.count,
    ).toBe('0');
  });

  it('rolls back an entire import when any resource conflicts with current custody', async () => {
    const existing = coordinationRecord({ resource: 'f'.repeat(64) });
    await store.claim(existing);
    const first = coordinationRecord({ state: 'unknown' });
    const conflicting = coordinationRecord({ resource: existing.resource, state: 'unknown' });
    await expect(
      store.importUnknown(
        { scope: first.scope, epoch: first.epoch, generation: first.generation },
        [first, conflicting],
      ),
    ).rejects.toThrow('conflicts');
    expect(await store.list(coordinationScope)).toEqual([existing]);
  });

  it.each([
    'scope',
    'epoch',
    'generation',
    'state',
  ])('rejects mismatched %s before importing any custody', async (field) => {
    const record = coordinationRecord({ state: 'unknown' });
    const changes =
      field === 'scope'
        ? { scope: { ...record.scope, org: 'other' } }
        : field === 'state'
          ? { state: 'executing' as const }
          : { [field]: 'another-generation-0002' };
    await expect(
      store.importUnknown(
        { scope: record.scope, epoch: record.epoch, generation: record.generation },
        [{ ...record, ...changes }],
      ),
    ).rejects.toThrow('target mismatch');
    expect(await store.list(coordinationScope)).toEqual([]);
  });
});
