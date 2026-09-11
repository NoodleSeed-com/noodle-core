import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findActiveCustomerAuthAudienceConflictRow } from '../src/store/postgres-customer-auth-audience.js';
import { ensureCustomerAuthAudienceSchema } from '../src/store/postgres-customer-auth-audience-schema.js';

const URL = process.env.DATABASE_URL_TEST;
const SCHEMA = `customer_auth_mixed_${process.pid}`;
// Advisory locks are database-wide, so independent suites need independent issuer keys.
const AUTH = { issuer: `https://${SCHEMA.replaceAll('_', '-')}.example/`, audience: 'support' };
const OTHER = { org: 'acme', app: 'other', env: 'prod' };

describe.skipIf(!URL)('mixed customer auth PostgreSQL ownership', () => {
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: URL, max: 1 });
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new Pool({ connectionString: URL, max: 4, options: `-c search_path=${SCHEMA}` });
    await pool.query(`CREATE TABLE deploy_records (
      deployment_id text PRIMARY KEY, org_slug text NOT NULL, app_slug text NOT NULL,
      environment text NOT NULL, active boolean NOT NULL DEFAULT true,
      archived_at timestamptz, access_mode text NOT NULL, server_auth jsonb,
      schema_version integer NOT NULL
    )`);
    await ensureCustomerAuthAudienceSchema(pool);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE deploy_records, customer_auth_audience_bindings');
    await ensureCustomerAuthAudienceSchema(pool);
  });

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await admin.end();
    }
  });

  it.each([
    ['mixed', 2, 'customers', 1],
    ['customers', 1, 'mixed', 2],
    ['mixed', 2, 'mixed', 2],
  ])('rejects %s v%s versus %s v%s across boundaries', async (mode, version, nextMode, nextVersion) => {
    await insert('first', 'support', mode, version);
    await expect(insert('second', 'other', nextMode, nextVersion)).rejects.toMatchObject({
      code: 'NDA01',
    });
    expect(await countBindings()).toBe(1);
  });

  it.each([0, 1, 3])('does not reserve dormant or unsupported mixed v%s auth', async (version) => {
    await insert('first', 'support', 'mixed', version);
    expect(await countBindings()).toBe(0);
    await insert('second', 'other', 'customers', 1);
    expect(await countBindings()).toBe(1);
  });

  it('allows mixed v2 without auth and rejects malformed non-null auth', async () => {
    await insert('unauthenticated', 'support', 'mixed', 2, null);
    expect(await countBindings()).toBe(0);
    for (const auth of [
      {},
      { kind: 'federatedOidc', issuers: [] },
      'invalid',
      { ...AUTH, issuer: 123 },
      { ...AUTH, kind: null },
      { kind: 'bridge', provider: true },
      { kind: 'federatedOidc', issuers: [{ ...AUTH, audience: 123 }] },
    ]) {
      await expect(insert('malformed', 'other', 'mixed', 2, auth)).rejects.toMatchObject({
        code: 'NDA02',
      });
    }
    await expect(insert('missing', 'other', 'customers', 1, null)).rejects.toMatchObject({
      code: 'NDA02',
    });
  });

  it.each([
    '\t',
    '\n',
    '\u00a0',
    '\ufeff',
  ])('rejects whitespace-only identity fields %j consistently with JS', async (blank) => {
    for (const auth of [
      { kind: 'bridge', provider: blank },
      { ...AUTH, issuer: blank },
      { ...AUTH, audience: blank },
      { kind: 'federatedOidc', issuers: [{ ...AUTH, audience: blank }] },
    ]) {
      await expect(insert('blank', 'support', 'mixed', 2, auth)).rejects.toMatchObject({
        code: 'NDA02',
      });
    }
    expect(await countBindings()).toBe(0);
  });

  it('allows mixed and customers to share inside one app/environment', async () => {
    await insert('first', 'support', 'mixed', 2);
    await insert('second', 'support', 'customers', 1);
    expect(await countBindings()).toBe(1);
  });

  it('rejects sharing across environments of the same mixed app', async () => {
    await insert('first', 'support', 'mixed', 2);
    await expect(
      pool.query(`INSERT INTO deploy_records
      SELECT 'second', org_slug, app_slug, 'dev', active, archived_at, access_mode,
             server_auth, schema_version FROM deploy_records WHERE deployment_id = 'first'`),
    ).rejects.toMatchObject({ code: 'NDA01' });
  });

  it('transfers an archived mixed reservation and rejects its conflicting restore', async () => {
    await insert('first', 'support', 'mixed', 2);
    await pool.query("UPDATE deploy_records SET archived_at = now() WHERE deployment_id = 'first'");
    await insert('second', 'other', 'customers', 1);
    await expect(
      pool.query("UPDATE deploy_records SET archived_at = NULL WHERE deployment_id = 'first'"),
    ).rejects.toMatchObject({ code: 'NDA01' });
    const { rows } = await pool.query<{ archived: boolean }>(
      "SELECT archived_at IS NOT NULL AS archived FROM deploy_records WHERE deployment_id = 'first'",
    );
    expect(rows[0]?.archived).toBe(true);
    expect(await countBindings()).toBe(1);
  });

  it('grants one concurrent owner across mixed and customers without deadlock', async () => {
    const results = await Promise.allSettled([
      insert('first', 'support', 'mixed', 2),
      insert('second', 'other', 'customers', 1),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'NDA01' },
    });
    expect(await countBindings()).toBe(1);
  });

  it('preserves v2 ownership on repeated and concurrent installer runs', async () => {
    await insert('first', 'support', 'mixed', 2);
    await ensureCustomerAuthAudienceSchema(pool);
    await Promise.all([
      ensureCustomerAuthAudienceSchema(pool),
      ensureCustomerAuthAudienceSchema(pool),
    ]);
    expect(await countBindings()).toBe(1);
    await expect(insert('second', 'other', 'customers', 1)).rejects.toMatchObject({
      code: 'NDA01',
    });
  });

  it('replaces the old index and indexes active mixed v2 reservations', async () => {
    await pool.query(`CREATE INDEX IF NOT EXISTS deploy_records_active_customer_auth
      ON deploy_records(org_slug, app_slug, environment) INCLUDE(server_auth)
      WHERE active AND archived_at IS NULL AND access_mode = 'customers' AND server_auth IS NOT NULL`);
    await ensureCustomerAuthAudienceSchema(pool);
    const { rows } = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname LIKE 'deploy_records_active_customer_auth%'`,
      [SCHEMA],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).toContain("'mixed'");
    expect(rows[0]?.indexdef).toContain('schema_version = 2');
  });

  it('finds mixed v2 owners with canonical issuer matching', async () => {
    await insert('first', 'support', 'mixed', 2);
    await expect(
      findActiveCustomerAuthAudienceConflictRow(pool, OTHER, {
        ...AUTH,
        issuer: AUTH.issuer.slice(0, -1),
      }),
    ).resolves.toEqual({ org: 'acme', app: 'support', env: 'prod' });
  });

  it('reports pre-existing mixed collisions and malformed boundaries during backfill', async () => {
    await pool.query('DROP TRIGGER deploy_records_customer_auth_audience ON deploy_records');
    await insert('first', 'support', 'mixed', 2);
    await insert('second', 'other', 'customers', 1);
    await insert('malformed', 'broken', 'mixed', 2, {});
    await insert('dormant', 'legacy', 'mixed', 1);
    await expect(ensureCustomerAuthAudienceSchema(pool)).resolves.toEqual({
      invalidBoundaries: 1,
      conflictingBindings: 1,
      conflictingBoundaries: 2,
    });
    expect(await countBindings()).toBe(1);
    await expect(
      pool.query("UPDATE deploy_records SET active = true WHERE deployment_id = 'first'"),
    ).rejects.toMatchObject({ code: 'NDA01' });
  });

  it('retains an authoritative mixed owner when a stale reservation names another boundary', async () => {
    await insert('first', 'support', 'mixed', 2);
    await pool.query("UPDATE customer_auth_audience_bindings SET app_slug = 'stale'");
    await expect(insert('second', 'other', 'customers', 1)).rejects.toMatchObject({
      code: 'NDA01',
    });
  });

  async function insert(
    id: string,
    app: string,
    mode: string,
    version: number,
    auth: unknown = AUTH,
  ) {
    await pool.query(
      `INSERT INTO deploy_records
      (deployment_id, org_slug, app_slug, environment, access_mode, schema_version, server_auth)
      VALUES ($1, 'acme', $2, 'prod', $3, $4, $5::jsonb)`,
      [id, app, mode, version, auth === null ? null : JSON.stringify(auth)],
    );
  }

  async function countBindings(): Promise<number> {
    const { rows } = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM customer_auth_audience_bindings',
    );
    return rows[0]?.count ?? 0;
  }
});
