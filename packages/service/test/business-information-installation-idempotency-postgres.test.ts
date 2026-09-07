import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InstallationScope } from '../src/business-information/contracts.js';
import { PostgresBusinessInformationStore } from '../src/business-information/postgres-store.js';
import { withPostgresTransaction } from '../src/store/postgres-transaction.js';
import { TestPayloadCipher } from './business-information-test-cipher.js';

const databaseUrl = process.env.DATABASE_URL_TEST;
function signal<T>() {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
describe.skipIf(databaseUrl === undefined)('installation INSERT arbitration', () => {
  const schema = `installation_idempotency_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 6,
    options: `-c search_path=${schema}`,
  });
  const store = new PostgresBusinessInformationStore(pool, new TestPayloadCipher());
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await store.ensureSchema();
    // Keep both production uniqueness rules, but insert a test-only index evaluation gate between
    // the composite PK and org/installation arbiter. Production capacity authority remains enabled.
    await pool.query(`ALTER TABLE business_solution_installations
      DROP CONSTRAINT business_solution_installations_org_slug_installation_id_key`);
    await pool.query(`CREATE FUNCTION installation_index_gate(value text) RETURNS text
      LANGUAGE plpgsql IMMUTABLE AS $$ BEGIN
        IF coalesce(current_setting('test.installation_gate', true), '') <> '' THEN
          PERFORM pg_advisory_xact_lock(current_setting('test.installation_gate')::bigint);
        END IF;
        RETURN value;
      END $$`);
    await pool.query(`CREATE INDEX installation_test_gate
      ON business_solution_installations (installation_index_gate(public_id))`);
    await pool.query(`ALTER TABLE business_solution_installations
      ADD CONSTRAINT installation_identity UNIQUE (org_slug, installation_id)`);
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
  const input = (scope: InstallationScope, retentionDays = 30) => ({
    scope,
    profileKey: 'travel' as const,
    managedCollections: ['travel_requests'],
    retentionDays,
    actorSubject: 'owner',
    actorEmail: 'owner@example.test',
  });
  it.each([
    'same',
    'different-body',
    'different-scope',
  ] as const)('handles competing %s requests while the first insert holds organization capacity authority', async (variant) => {
    const org = `org-${randomUUID()}`;
    const scope = { org, app: 'travel', env: 'prod', installationId: 'travel-prod' };
    const gate = Math.floor(Math.random() * 1_000_000_000) + 1;
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT pg_advisory_xact_lock($1)', [gate]);
    const firstPid = signal<number>();
    const secondPid = signal<number>();
    const first = withPostgresTransaction(pool, async (client) => {
      await client.query("SELECT set_config('test.installation_gate', $1, true)", [String(gate)]);
      firstPid.resolve(
        (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid ?? 0,
      );
      return store.createInstallation(input(scope));
    });
    const firstOutcome = first.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    let secondOutcome: typeof firstOutcome | undefined;
    try {
      const pid = await firstPid.promise;
      await expect
        .poll(
          async () =>
            (
              await pool.query(
                "SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted",
                [pid],
              )
            ).rowCount,
        )
        .toBe(1);
      const second = withPostgresTransaction(pool, async (client) => {
        secondPid.resolve(
          (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid ?? 0,
        );
        return store.createInstallation(
          input(
            variant === 'different-scope' ? { ...scope, app: 'another' } : scope,
            variant === 'different-body' ? 90 : 30,
          ),
        );
      });
      secondOutcome = second.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      const competingPid = await secondPid.promise;
      // All writes in one org serialize before uniqueness checks, including a conflicting app scope.
      // Waiting for the second INSERT to finish here would deadlock the test's own index gate.
      await expect
        .poll(
          async () =>
            (
              await pool.query<{ blockers: number[] }>('SELECT pg_blocking_pids($1) AS blockers', [
                competingPid,
              ])
            ).rows[0]?.blockers,
        )
        .toContain(pid);
      await blocker.query('COMMIT');
      const firstResult = await firstOutcome;
      const secondResult = await secondOutcome;
      if ('error' in firstResult) throw firstResult.error;
      if ('error' in secondResult) throw secondResult.error;
      expect([firstResult.value.disposition, secondResult.value.disposition].sort()).toEqual(
        variant === 'same' ? ['created', 'replayed'] : ['conflict', 'created'],
      );
      const winner =
        firstResult.value.disposition === 'created' ? firstResult.value : secondResult.value;
      expect(await store.listInstallations(org)).toHaveLength(1);
      expect(await store.getGrant(winner.installation.scope, 'owner')).toMatchObject({
        role: 'administrator',
        revision: 1,
      });
      expect(await store.getInstallationById(org, scope.installationId)).toMatchObject({
        scope: winner.installation.scope,
        retentionDays: 30,
      });
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await Promise.all([firstOutcome, secondOutcome]);
    }
  });
  it('never treats an unrelated public ID collision as a replay or grants access to it', async () => {
    const fixed = new PostgresBusinessInformationStore(pool, new TestPayloadCipher(), {
      publicId: () => 'sol_collision',
    });
    const first = { org: 'first', app: 'travel', env: 'prod', installationId: 'first' };
    const second = { org: 'second', app: 'travel', env: 'prod', installationId: 'second' };
    expect(await fixed.createInstallation(input(first))).toMatchObject({
      disposition: 'created',
    });
    await expect(fixed.createInstallation(input(second))).rejects.toThrow();
    expect(await fixed.getInstallation(second)).toBeUndefined();
    expect(await fixed.getGrant(second, 'owner')).toBeUndefined();
    expect(await fixed.resolveInstallationByPublicId('sol_collision')).toMatchObject({
      scope: first,
    });
  });
});
