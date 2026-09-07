import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgresGoogleWorkloadIdentityStore } from '../src/google-workload-identity-postgres.js';

const URL = process.env.DATABASE_URL_TEST;
const SCHEMA = `google_workload_identity_${process.pid}`;
const tenant = { org: 'acme', app: 'analytics', env: 'prod' };

describe.skipIf(!URL)('PostgresGoogleWorkloadIdentityStore', () => {
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: URL, max: 1 });
    await admin.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    pool = new Pool({ connectionString: URL, max: 6, options: `-c search_path=${SCHEMA}` });
    await new PostgresGoogleWorkloadIdentityStore(pool).ensureSchema();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE google_workload_identities');
  });

  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  });

  it('prepares before any deployment/environment row exists', async () => {
    const store = new PostgresGoogleWorkloadIdentityStore(pool, {
      randomId: () => 'identity-first-deploy',
      now: () => new Date('2026-07-23T12:00:00.000Z'),
    });

    await expect(
      store.prepare({ ...tenant, actorSubject: 'owner-1', actorEmail: 'owner@example.com' }),
    ).resolves.toMatchObject({
      id: 'identity-first-deploy',
      tenantId: 'acme/analytics/prod',
      active: true,
    });
  });

  it('returns one durable identity across concurrent store instances', async () => {
    const first = new PostgresGoogleWorkloadIdentityStore(pool);
    const second = new PostgresGoogleWorkloadIdentityStore(pool);

    const [left, right] = await Promise.all([
      first.prepare({ ...tenant, actorSubject: 'owner-1' }),
      second.prepare({ ...tenant, actorSubject: 'owner-2' }),
    ]);

    expect(left.id).toBe(right.id);
    await expect(second.get(tenant)).resolves.toEqual(left);
  });

  it('persists revocation and rotates the subject on explicit re-prepare', async () => {
    let sequence = 0;
    const store = new PostgresGoogleWorkloadIdentityStore(pool, {
      randomId: () => `identity-${++sequence}`,
    });
    const original = await store.prepare({ ...tenant, actorSubject: 'owner-1' });
    await store.revoke({ ...tenant, actorSubject: 'owner-2' });

    await expect(
      new PostgresGoogleWorkloadIdentityStore(pool).resolve({
        tenantId: 'acme/analytics/prod',
        deploymentId: 'deployment-does-not-own-the-identity',
      }),
    ).resolves.toMatchObject({ id: original.id, active: false });

    const replacement = await store.prepare({ ...tenant, actorSubject: 'owner-3' });
    expect(replacement.subject).not.toBe(original.subject);
    expect(replacement.active).toBe(true);
  });
});
