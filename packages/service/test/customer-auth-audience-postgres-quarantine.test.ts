import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type DeployRecord,
  PostgresArtifactStore,
  ServerRegistry,
  type TenantAuthConfig,
  type TenantRef,
} from '../src/index.js';

const URL = process.env.DATABASE_URL_TEST;
const SCHEMA = `customer_auth_audience_quarantine_${process.pid}`;
const PROD = { org: 'acme', app: 'support', env: 'prod' } as const;
const DEV = { org: 'acme', app: 'support', env: 'dev' } as const;
const OTHER = { org: 'acme', app: 'other', env: 'prod' } as const;
const AUTH = { issuer: 'https://idp.example', audience: 'acme-support' } as const;
const DEV_AUTH = { issuer: 'https://idp.example', audience: 'acme-support-dev' } as const;
const OTHER_AUTH = { issuer: 'https://idp.example', audience: 'acme-other' } as const;

describe.skipIf(!URL)('Postgres customer OIDC quarantine reconciliation', () => {
  let admin: Pool;
  let pool: Pool;
  let store: PostgresArtifactStore;

  beforeAll(async () => {
    admin = new Pool({ connectionString: URL, max: 1 });
    await admin.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    pool = new Pool({ connectionString: URL, max: 4, options: `-c search_path=${SCHEMA}` });
    store = new PostgresArtifactStore(pool);
    await store.ensureSchema();
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE customer_auth_audience_bindings, deploy_records, environments, apps, orgs CASCADE',
    );
    await store.ensureSchema();
    await store.createOrg({ slug: 'acme', displayName: 'Acme' });
  });

  afterAll(async () => {
    await pool?.end();
    if (admin !== undefined) {
      await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await admin.end();
    }
  });

  it('reconciles two legacy owners and reserves one deterministic boundary', async () => {
    await seedLegacyCollision();

    await expect(store.ensureSchemaWithCustomerAuthAudienceReport()).resolves.toEqual({
      invalidBoundaries: 0,
      conflictingBindings: 1,
      conflictingBoundaries: 2,
    });
    await expect(bindingOwner()).resolves.toEqual(DEV);
  });

  it('skips a malformed legacy projection and reports its boundary', async () => {
    await store.append(record('malformed-owner-11111111', PROD));
    await pool.query('DROP TRIGGER deploy_records_customer_auth_audience ON deploy_records');
    await pool.query('UPDATE deploy_records SET server_auth = NULL WHERE deployment_id = $1', [
      'malformed-owner-11111111',
    ]);

    await expect(store.ensureSchemaWithCustomerAuthAudienceReport()).resolves.toEqual({
      invalidBoundaries: 1,
      conflictingBindings: 0,
      conflictingBoundaries: 0,
    });
    await expect(bindingCount()).resolves.toBe(0);
  });

  it('returns a zero report for a valid unique owner', async () => {
    await store.append(record('unique-owner-11111111', PROD));

    await expect(store.ensureSchemaWithCustomerAuthAudienceReport()).resolves.toEqual({
      invalidBoundaries: 0,
      conflictingBindings: 0,
      conflictingBoundaries: 0,
    });
  });

  it('rejects a mutation by the selected reservation holder while a legacy collision remains', async () => {
    await seedLegacyCollision();
    await store.ensureSchema();
    await expect(bindingOwner()).resolves.toEqual(DEV);

    await expect(
      pool.query('UPDATE deploy_records SET created_at = created_at WHERE deployment_id = $1', [
        'dev-legacy-owner-22222222',
      ]),
    ).rejects.toMatchObject({
      code: 'NDA01',
      message: 'customer auth audience conflict',
    });
  });

  it('does not transfer a stale reservation past an authoritative active owner', async () => {
    await seedLegacyCollision();
    await store.ensureSchema();
    await pool.query(
      `UPDATE deploy_records
       SET server_auth = $2::jsonb, manifest = $3
       WHERE deployment_id = $1`,
      ['dev-legacy-owner-22222222', JSON.stringify(DEV_AUTH), manifest(DEV_AUTH)],
    );

    await expect(store.append(record('third-owner-33333333', OTHER))).rejects.toMatchObject({
      code: 'customer_auth_audience_conflict',
    });
    await pool.query('UPDATE deploy_records SET created_at = created_at WHERE deployment_id = $1', [
      'prod-legacy-owner-11111111',
    ]);
    await expect(bindingOwner()).resolves.toEqual(PROD);
  });

  it('quarantines collided boundaries during PostgreSQL recovery and serves repaired boundaries', async () => {
    await seedLegacyCollision();
    await store.append(record('unrelated-owner-33333333', OTHER, OTHER_AUTH));
    await store.ensureSchema();

    const recovered = await registry().recover();

    expect(recovered.recovered).toBe(1);
    expect(recovered.failed.map(({ deploymentId }) => deploymentId).sort()).toEqual([
      'dev-legacy-owner-22222222',
      'prod-legacy-owner-11111111',
    ]);
    await expect(registry().getActiveByTenant(PROD)).resolves.toBeUndefined();
    await expect(registry().getActiveByTenant(DEV)).resolves.toBeUndefined();
    await expect(registry().getActiveByTenant(OTHER)).resolves.toBeDefined();

    await pool.query(
      `UPDATE deploy_records
       SET server_auth = $2::jsonb, manifest = $3
       WHERE deployment_id = $1`,
      ['dev-legacy-owner-22222222', JSON.stringify(DEV_AUTH), manifest(DEV_AUTH)],
    );
    const repaired = registry();
    await expect(repaired.recover()).resolves.toEqual({ recovered: 3, failed: [] });
    await expect(repaired.getActiveByTenant(PROD)).resolves.toBeDefined();
    await expect(repaired.getActiveByTenant(DEV)).resolves.toBeDefined();
    await expect(repaired.getActiveByTenant(OTHER)).resolves.toBeDefined();
  });

  it('allows the remaining boundary to recover after the selected legacy owner is archived', async () => {
    await seedLegacyCollision();
    await store.ensureSchema();
    await expect(bindingOwner()).resolves.toEqual(DEV);
    await pool.query(
      `UPDATE deploy_records
       SET archived_at = '2026-07-30T00:00:00.000Z'::timestamptz
       WHERE deployment_id = $1`,
      ['dev-legacy-owner-22222222'],
    );

    const recovered = registry();
    await expect(recovered.recover()).resolves.toEqual({ recovered: 1, failed: [] });
    await expect(recovered.getActiveByTenant(PROD)).resolves.toBeDefined();
    await expect(recovered.getActiveByTenant(DEV)).resolves.toBeUndefined();
  });

  async function seedLegacyCollision(): Promise<void> {
    await store.append(record('prod-legacy-owner-11111111', PROD));
    await pool.query(
      `INSERT INTO environments (org_slug, app_slug, name, is_production)
       VALUES ($1, $2, $3, false)`,
      [DEV.org, DEV.app, DEV.env],
    );
    await pool.query('DROP TRIGGER deploy_records_customer_auth_audience ON deploy_records');
    await pool.query(
      `INSERT INTO deploy_records
       (deployment_id, org_slug, app_slug, environment, server_version, deployment_version,
        active, server_name, created_at, created_by_subject, created_by_email, access_mode,
        server_auth, caller_key_hash, manifest, connectors, hosted_assets, secrets,
        schema_version, archived_at, deployment_source, org_membership_sources)
       SELECT $2, org_slug, app_slug, $3, server_version, deployment_version + 1,
              true, server_name, created_at, created_by_subject, created_by_email, access_mode,
              server_auth, caller_key_hash, manifest, connectors, hosted_assets, secrets,
              schema_version, archived_at, deployment_source, org_membership_sources
       FROM deploy_records
       WHERE deployment_id = $1`,
      ['prod-legacy-owner-11111111', 'dev-legacy-owner-22222222', DEV.env],
    );
  }

  async function bindingOwner(): Promise<TenantRef | undefined> {
    const { rows } = await pool.query<{
      org_slug: string;
      app_slug: string;
      environment: string;
    }>(
      `SELECT org_slug, app_slug, environment
       FROM customer_auth_audience_bindings
       WHERE issuer = $1 AND audience = $2`,
      [AUTH.issuer, AUTH.audience],
    );
    const row = rows[0];
    return row === undefined
      ? undefined
      : { org: row.org_slug, app: row.app_slug, env: row.environment };
  }

  async function bindingCount(): Promise<number> {
    const { rows } = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM customer_auth_audience_bindings',
    );
    return rows[0]?.count ?? 0;
  }

  function registry(): ServerRegistry {
    return new ServerRegistry(store, undefined, undefined, {
      customerVerifierFactory: () => async (_token, resource) => ({
        caller: {
          subject: 'customer',
          ...(resource === undefined ? {} : { audience: resource }),
          identityKind: 'customer',
        },
      }),
    });
  }
});

function record(
  deploymentId: string,
  tenant: TenantRef,
  auth: TenantAuthConfig = AUTH,
): DeployRecord {
  return {
    schemaVersion: 1,
    deploymentId,
    orgSlug: tenant.org,
    appSlug: tenant.app,
    environment: tenant.env,
    serverVersion: '1',
    deploymentVersion: 1,
    active: true,
    serverName: 'support',
    createdAt: '2026-07-30T00:00:00.000Z',
    accessMode: 'customers',
    serverAuth: auth,
    manifest: manifest(auth),
    secrets: { enc: 'none', values: {} },
  };
}

function manifest(auth: TenantAuthConfig): string {
  return JSON.stringify({
    manifestVersion: '2',
    server: {
      name: 'support',
      title: 'Support',
      version: '1.0.0',
      auth,
    },
    tools: [
      {
        name: 'whoami',
        description: 'Show the caller',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        fulfilment: { steps: [], output: { ok: true } },
      },
    ],
  });
}
