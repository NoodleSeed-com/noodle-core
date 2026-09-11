import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type DeployRecord, PostgresArtifactStore, type TenantRef } from '../src/index.js';

const URL = process.env.DATABASE_URL_TEST;
const SCHEMA = `customer_auth_audience_${process.pid}`;
const PROD = { org: 'acme', app: 'support', env: 'prod' } as const;
const DEV = { org: 'acme', app: 'support', env: 'dev' } as const;
const OTHER = { org: 'acme', app: 'other', env: 'prod' } as const;
const AUTH = { issuer: 'https://idp.example', audience: 'acme-support' } as const;
const OTHER_AUTH = { issuer: 'https://idp.example', audience: 'other-support' } as const;

describe.skipIf(!URL)('Postgres customer OIDC binding lifecycle', () => {
  let admin: Pool;
  let pool: Pool;
  let first: PostgresArtifactStore;
  let second: PostgresArtifactStore;

  beforeAll(async () => {
    admin = new Pool({ connectionString: URL, max: 1 });
    await admin.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    pool = new Pool({ connectionString: URL, max: 6, options: `-c search_path=${SCHEMA}` });
    first = new PostgresArtifactStore(pool);
    second = new PostgresArtifactStore(pool);
    await first.ensureSchema();
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE customer_auth_audience_bindings, deploy_records, environments, apps, orgs CASCADE',
    );
    await first.createOrg({ slug: 'acme', displayName: 'Acme' });
  });

  afterAll(async () => {
    await pool?.end();
    if (admin !== undefined) {
      await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await admin.end();
    }
  });

  it('refuses stale access writes and accepts an explicit matching version', async () => {
    const deployed = {
      ...ownerRecord('mixed-cas-11111111', PROD),
      schemaVersion: 2,
      accessMode: 'mixed' as const,
      serverAuth: AUTH,
    };
    await first.append(deployed);
    for (const expectedSchemaVersion of [undefined, 1]) {
      await expect(
        second.updateActiveAccess(PROD, deployed.deploymentId, {
          accessMode: 'public',
          expectedAccessMode: 'mixed',
          expectedOwnerSubject: 'owner',
          expectedSchemaVersion,
        }),
      ).resolves.toBeUndefined();
    }
    await expect(first.get(deployed.deploymentId)).resolves.toMatchObject({
      schemaVersion: 2,
      accessMode: 'mixed',
    });
    await expect(
      second.updateActiveAccess(PROD, deployed.deploymentId, {
        accessMode: 'public',
        expectedAccessMode: 'mixed',
        expectedOwnerSubject: 'owner',
        expectedSchemaVersion: 2,
      }),
    ).resolves.toMatchObject({ schemaVersion: 2, accessMode: 'public' });
  });

  it('prevents an old append from replacing or deactivating a newer policy', async () => {
    const deployed = {
      ...record('new-policy-11111111', PROD),
      schemaVersion: 2,
      accessMode: 'mixed' as const,
    };
    await first.append(deployed);
    for (const deploymentId of [deployed.deploymentId, 'old-writer-22222222']) {
      await expect(
        second.append({ ...deployed, deploymentId, schemaVersion: 1 }),
      ).rejects.toMatchObject({ code: 'unsupported_deployment_record_version' });
    }
    expect(await first.loadAll()).toHaveLength(1);
    await expect(first.get(deployed.deploymentId)).resolves.toMatchObject({
      schemaVersion: 2,
      active: true,
    });
  });

  it.each([
    false,
    true,
  ])('requires explicit v2 activation intent for automation (explicit: %s)', async (explicit) => {
    const target = {
      ...record('future-target-11111111', PROD),
      schemaVersion: 2,
      accessMode: 'mixed' as const,
      active: false,
    };
    // Pending automation can retain a v1 target ID while a newer writer upgrades its record.
    await first.append({ ...target, schemaVersion: 1 });
    await first.append(target);
    const result = await second.activateDeployment(
      PROD,
      target.deploymentId,
      explicit ? { expectedAccessMode: 'mixed', expectedSchemaVersion: 2 } : undefined,
      { automationId: 'pending-v1-automation' },
    );
    if (explicit) expect(result).toMatchObject({ active: { schemaVersion: 2, active: true } });
    else expect(result).toBeUndefined();
    await expect(first.get(target.deploymentId)).resolves.toMatchObject({ active: explicit });
  });

  it('prevents stale activation while permitting explicit historical rollback', async () => {
    const historical = { ...record('old-pending-11111111', PROD), active: false };
    const current = {
      ...record('new-policy-22222222', PROD),
      schemaVersion: 2,
      accessMode: 'mixed' as const,
    };
    await first.append(historical);
    await first.append(current);
    await expect(second.activateDeployment(PROD, historical.deploymentId)).rejects.toMatchObject({
      code: 'unsupported_deployment_record_version',
    });
    await expect(first.get(current.deploymentId)).resolves.toMatchObject({ active: true });
    await expect(
      second.activateDeployment(PROD, current.deploymentId, {
        expectedAccessMode: 'mixed',
        expectedSchemaVersion: 1,
      }),
    ).resolves.toBeUndefined();
    await expect(
      second.activateDeployment(PROD, historical.deploymentId, {
        expectedAccessMode: 'customers',
        expectedSchemaVersion: 1,
      }),
    ).resolves.toMatchObject({ active: { deploymentId: historical.deploymentId } });
  });

  it('updates the customer projection during same-mode v2 mixed access writes', async () => {
    const deployed = {
      ...ownerRecord('mixed-projection-11111111', PROD),
      schemaVersion: 2,
      accessMode: 'mixed' as const,
      serverAuth: AUTH,
    };
    await first.append(deployed);
    await expect(
      second.updateActiveAccess(PROD, deployed.deploymentId, {
        accessMode: 'mixed',
        expectedAccessMode: 'mixed',
        expectedOwnerSubject: 'owner',
        expectedSchemaVersion: 2,
        serverAuth: OTHER_AUTH,
      }),
    ).resolves.toMatchObject({ serverAuth: OTHER_AUTH });
    await expect(first.get(deployed.deploymentId)).resolves.toMatchObject({
      serverAuth: OTHER_AUTH,
    });
  });

  it('atomically grants one concurrent active deploy binding', async () => {
    const results = await Promise.allSettled([
      first.append(record('prod-deploy-11111111', PROD)),
      second.append(record('dev-deploy-22222222', DEV)),
    ]);

    expectOneConflict(results);
    expect(await activeCustomerCount()).toBe(1);
    expect(await bindingCount()).toBe(1);
  });

  it('serializes a current append against a preceding-revision raw activation without deadlock', async () => {
    await first.append({ ...record('old-revision-11111111', DEV), active: false });

    const results = await Promise.allSettled([
      first.append(record('current-revision-22222222', PROD)),
      pool.query('UPDATE deploy_records SET active = true WHERE deployment_id = $1', [
        'old-revision-11111111',
      ]),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected?.reason).not.toMatchObject({ code: '40P01' });
    expect(['NDA01', 'customer_auth_audience_conflict']).toContain(rejected?.reason?.code);
    expect(await activeCustomerCount()).toBe(1);
    expect(await bindingCount()).toBe(1);
  });

  it('acquires reversed federated bindings in one deterministic order', async () => {
    const forward = {
      kind: 'federatedOidc',
      issuers: [
        { issuer: 'https://idp-a.example', audience: 'acme-support-a' },
        { issuer: 'https://idp-b.example', audience: 'acme-support-b' },
      ],
    } as const;
    const reverse = {
      ...forward,
      issuers: [...forward.issuers].reverse(),
    } as const;

    const results = await Promise.allSettled([
      first.append({
        ...record('federated-forward-11111111', PROD),
        serverVersion: '1',
        serverAuth: forward,
      }),
      second.append({
        ...record('federated-reverse-22222222', PROD),
        serverVersion: '2',
        serverAuth: reverse,
      }),
    ]);

    expect(results).toEqual([
      expect.objectContaining({ status: 'fulfilled' }),
      expect.objectContaining({ status: 'fulfilled' }),
    ]);
    const { rows } = await pool.query<{ definition: string }>(
      `SELECT pg_get_functiondef('noodle_customer_auth_audience_row_trigger()'::regprocedure)
         AS definition`,
    );
    expect(rows[0]?.definition).toContain('ORDER BY issuer, audience');
    expect(await bindingCount()).toBe(2);
  });

  it('activates opposite audience swaps without an OLD-to-NEW binding deadlock', async () => {
    const audienceA = {
      issuer: 'https://swap-idp.example',
      audience: 'customer-audience-a',
    } as const;
    const audienceB = {
      issuer: 'https://swap-idp.example',
      audience: 'customer-audience-b',
    } as const;
    await first.append({
      ...record('swap-v1-active-b-11111111', PROD),
      serverVersion: '1',
      serverAuth: audienceB,
    });
    await first.append({
      ...record('swap-v1-target-a-22222222', PROD),
      serverVersion: '1',
      active: false,
      serverAuth: audienceA,
    });
    await first.append({
      ...record('swap-v2-active-a-33333333', PROD),
      serverVersion: '2',
      serverAuth: audienceA,
    });
    await first.append({
      ...record('swap-v2-target-b-44444444', PROD),
      serverVersion: '2',
      active: false,
      serverAuth: audienceB,
    });
    const barrier = twoPartyBarrier();
    const swapV1 = artifactStoreWithDeactivationBarrier(pool, barrier);
    const swapV2 = artifactStoreWithDeactivationBarrier(pool, barrier);

    const results = await Promise.allSettled([
      swapV1.activateDeployment(PROD, 'swap-v1-target-a-22222222'),
      swapV2.activateDeployment(PROD, 'swap-v2-target-b-44444444'),
    ]);

    expect(results).toEqual([
      expect.objectContaining({ status: 'fulfilled' }),
      expect.objectContaining({ status: 'fulfilled' }),
    ]);
    expect(await activeCustomerCount()).toBe(2);
    expect(await bindingCount()).toBe(2);
  });

  it('rolls back active customer appends without a valid auth projection', async () => {
    await expect(
      first.append({ ...record('missing-auth-11111111', PROD), serverAuth: undefined }),
    ).rejects.toMatchObject({ code: 'customer_auth_audience_conflict' });
    await expect(
      first.append({
        ...record('malformed-auth-22222222', PROD),
        serverAuth: { kind: 'federatedOidc', issuers: [] } as never,
      }),
    ).rejects.toMatchObject({ code: 'customer_auth_audience_conflict' });

    expect(await activeCustomerCount()).toBe(0);
    expect(await bindingCount()).toBe(0);
  });

  it('blocks conflicting and malformed writes from a revision that does not know the lifecycle lock', async () => {
    await first.append(record('current-revision-11111111', PROD));
    await pool.query(
      `INSERT INTO environments (org_slug, app_slug, name, is_production)
       VALUES ($1, $2, $3, false)`,
      [DEV.org, DEV.app, DEV.env],
    );

    await expect(
      pool.query(
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
        ['current-revision-11111111', 'old-revision-22222222', DEV.env],
      ),
    ).rejects.toThrow('customer auth audience conflict');
    await expect(
      pool.query('UPDATE deploy_records SET server_auth = NULL WHERE deployment_id = $1', [
        'current-revision-11111111',
      ]),
    ).rejects.toThrow('customer auth audience projection invalid');
    expect(await activeCustomerCount()).toBe(1);
    expect(await bindingCount()).toBe(1);
  });

  it('backfills pre-existing active customer bindings during schema installation', async () => {
    await first.append(record('preexisting-valid-11111111', PROD));
    await pool.query('DROP TRIGGER deploy_records_customer_auth_audience ON deploy_records');
    await pool.query('TRUNCATE customer_auth_audience_bindings');

    await first.ensureSchema();

    expect(await bindingCount()).toBe(1);
  });

  it('retains an inactive reservation until another boundary atomically takes it over', async () => {
    const active = record('prod-deploy-11111111', PROD);
    await first.append(active);

    await first.append({ ...active, active: false });

    expect(await activeCustomerCount()).toBe(0);
    expect(await bindingCount()).toBe(1);

    await second.append(record('takeover-deploy-22222222', OTHER));

    expect(await activeCustomerCount()).toBe(1);
    expect(await bindingCount()).toBe(1);
    await expect(
      pool.query(
        `SELECT org_slug, app_slug, environment
           FROM customer_auth_audience_bindings
          WHERE issuer = $1 AND audience = $2`,
        [AUTH.issuer, AUTH.audience],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          org_slug: OTHER.org,
          app_slug: OTHER.app,
          environment: OTHER.env,
        },
      ],
    });
  });

  it('atomically grants one concurrent customer-access transition', async () => {
    await first.append(ownerRecord('prod-owner-11111111', PROD));
    await first.append(ownerRecord('dev-owner-22222222', DEV));

    const results = await Promise.allSettled([
      first.updateActiveAccess(PROD, 'prod-owner-11111111', {
        accessMode: 'customers',
        expectedAccessMode: 'owner-only',
        expectedOwnerSubject: 'owner',
      }),
      second.updateActiveAccess(DEV, 'dev-owner-22222222', {
        accessMode: 'customers',
        expectedAccessMode: 'owner-only',
        expectedOwnerSubject: 'owner',
      }),
    ]);

    expectOneConflict(results);
    expect(await activeCustomerCount()).toBe(1);
    expect(await bindingCount()).toBe(1);
  });

  it('atomically persists compiler-authoritative auth while enabling customer access', async () => {
    await first.append({
      ...ownerRecord('recovered-owner-11111111', PROD),
      serverAuth: undefined,
    });

    await expect(
      first.updateActiveAccess(PROD, 'recovered-owner-11111111', {
        accessMode: 'customers',
        expectedAccessMode: 'owner-only',
        expectedOwnerSubject: 'owner',
        serverAuth: AUTH,
      }),
    ).resolves.toMatchObject({ accessMode: 'customers', serverAuth: AUTH });
    await expect(first.getActiveByTenant(PROD)).resolves.toMatchObject({
      accessMode: 'customers',
      serverAuth: AUTH,
    });
    expect(await bindingCount()).toBe(1);
  });

  it('atomically grants one concurrent rollback activation', async () => {
    for (const [tenant, prefix] of [
      [PROD, 'prod'],
      [DEV, 'dev'],
    ] as const) {
      await first.append({
        ...ownerRecord(`${prefix}-current-11111111`, tenant),
        deploymentVersion: 2,
      });
      await first.append({
        ...record(`${prefix}-rollback-22222222`, tenant),
        active: false,
        deploymentVersion: 1,
      });
    }

    const results = await Promise.allSettled([
      first.activateDeployment(PROD, 'prod-rollback-22222222'),
      second.activateDeployment(DEV, 'dev-rollback-22222222'),
    ]);

    expectOneConflict(results);
    expect(await activeCustomerCount()).toBe(1);
    expect(await bindingCount()).toBe(1);
  });

  it('rejects automated activation of a customer target with an omitted auth projection', async () => {
    const candidate = {
      ...record('github-candidate-11111111', PROD),
      active: false,
      serverAuth: undefined,
    };
    await first.append(candidate);
    await expect(
      first.activateDeployment(PROD, candidate.deploymentId, undefined, {
        automationId: 'customer-auth-automation',
      }),
    ).rejects.toMatchObject({ code: 'customer_auth_audience_conflict' });
    await expect(first.get(candidate.deploymentId)).resolves.toMatchObject({ active: false });
    expect(await bindingCount()).toBe(0);
  });

  it('rolls back a conflicting restore without clearing archive stamps', async () => {
    await first.append(record('archived-owner-11111111', PROD));
    await first.archiveApp(PROD.org, PROD.app, '2026-07-30T00:00:00.000Z');
    await second.append(record('current-owner-22222222', OTHER));

    await expect(first.restoreApp(PROD.org, PROD.app)).rejects.toMatchObject({
      code: 'customer_auth_audience_conflict',
    });
    await expect(first.getAppArchivedAt(PROD.org, PROD.app)).resolves.toBe(
      '2026-07-30T00:00:00.000Z',
    );
    expect(await bindingCount()).toBe(1);
  });

  it('fails a legacy restore closed when an active customer record lacks its auth projection', async () => {
    await first.append(record('legacy-restore-11111111', PROD));
    await first.archiveApp(PROD.org, PROD.app, '2026-07-30T00:00:00.000Z');
    await pool.query('UPDATE deploy_records SET server_auth = NULL WHERE deployment_id = $1', [
      'legacy-restore-11111111',
    ]);

    await expect(first.restoreApp(PROD.org, PROD.app)).rejects.toMatchObject({
      code: 'customer_auth_audience_conflict',
    });
    await expect(first.getAppArchivedAt(PROD.org, PROD.app)).resolves.toBe(
      '2026-07-30T00:00:00.000Z',
    );
  });

  it('rejects a semantically stale restore projection atomically', async () => {
    await first.append(record('stale-restore-11111111', PROD));
    await first.archiveApp(PROD.org, PROD.app, '2026-07-30T00:00:00.000Z');

    await expect(
      first.restoreApp(PROD.org, PROD.app, {
        customerAuthProjections: [
          {
            deploymentId: 'stale-restore-11111111',
            manifest: '{}',
            serverAuth: OTHER_AUTH,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'customer_auth_audience_conflict' });
    await expect(first.getAppArchivedAt(PROD.org, PROD.app)).resolves.toBe(
      '2026-07-30T00:00:00.000Z',
    );
  });

  it('accepts an exact compiler-authoritative restore projection', async () => {
    await first.append(record('exact-restore-11111111', PROD));
    await first.archiveApp(PROD.org, PROD.app, '2026-07-30T00:00:00.000Z');

    await expect(
      first.restoreApp(PROD.org, PROD.app, {
        customerAuthProjections: [
          {
            deploymentId: 'exact-restore-11111111',
            manifest: '{}',
            serverAuth: AUTH,
          },
        ],
      }),
    ).resolves.toEqual({ restoredDeployments: 1 });
  });

  async function activeCustomerCount(): Promise<number> {
    const { rows } = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM deploy_records
       WHERE active AND archived_at IS NULL AND access_mode = 'customers'`,
    );
    return rows[0]?.count ?? 0;
  }

  async function bindingCount(): Promise<number> {
    const { rows } = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM customer_auth_audience_bindings',
    );
    return rows[0]?.count ?? 0;
  }
});

function artifactStoreWithDeactivationBarrier(
  pool: Pool,
  barrier: () => Promise<void>,
): PostgresArtifactStore {
  const wrapped = {
    query: pool.query.bind(pool),
    connect: async () => {
      const client = await pool.connect();
      return new Proxy(client, {
        get(target, property, receiver) {
          if (property !== 'query') return Reflect.get(target, property, receiver);
          return async (sql: string, values?: readonly unknown[]) => {
            const result = await target.query(sql, values);
            if (sql.includes('SET active = false')) await barrier();
            return result;
          };
        },
      });
    },
  } as Pool;
  return new PostgresArtifactStore(wrapped);
}

function twoPartyBarrier(): () => Promise<void> {
  let arrivals = 0;
  let release = () => {};
  const reached = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrivals += 1;
    if (arrivals === 2) release();
    await reached;
  };
}

function expectOneConflict(results: readonly PromiseSettledResult<unknown>[]): void {
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const rejected = results.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  expect(rejected).toHaveLength(1);
  expect(rejected[0]?.reason).toMatchObject({ code: 'customer_auth_audience_conflict' });
}

function ownerRecord(deploymentId: string, tenant: TenantRef): DeployRecord {
  return {
    ...record(deploymentId, tenant),
    accessMode: 'owner-only',
    createdBySubject: 'owner',
  };
}

function record(deploymentId: string, tenant: TenantRef): DeployRecord {
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
    serverAuth: AUTH,
    manifest: '{}',
    secrets: { enc: 'none', values: {} },
  };
}
