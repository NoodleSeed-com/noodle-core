import type { ArtifactState } from '@noodle-borg/compiler';
import { PostgresStateHandleStore } from '@noodle-borg/runtime/postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type DeployRecord,
  deploymentOwnerSubject,
  PostgresArtifactStore,
  serveService,
} from '../src/index.js';
import { registerPostgresProductionEnvironmentTests } from './postgres-environment-cases.js';

/**
 * Integration test for the relational store (ADR 0035). Runs only when `DATABASE_URL_TEST` points at a
 * disposable local Postgres (e.g. `docker run -e POSTGRES_PASSWORD=pw -p 5432:5432 postgres:16`, then
 * `DATABASE_URL_TEST=postgres://postgres:pw@localhost:5432/postgres`). Skipped otherwise so CI without a
 * database stays green — the cloud path is also exercised by the `--postgres` e2e mode and the GCP smoke.
 */
const URL = process.env.DATABASE_URL_TEST;
const SCHEMA = `artifact_store_test_${process.pid}`;

const NONE_RECORD: DeployRecord = {
  schemaVersion: 1,
  deploymentId: 'hello-abcd1234',
  orgSlug: 'acme',
  appSlug: 'hello',
  environment: 'prod',
  deploymentVersion: 1,
  active: true,
  serverName: 'hello',
  createdAt: '2026-06-03T00:00:00.000Z',
  createdBySubject: 'owner-sub',
  accessMode: 'owner-only',
  manifest: 'manifestVersion: "1"\n',
  secrets: { enc: 'none', values: { httpbin_token: 'tok-secret-123' } },
};

// A sealed (aes-256-gcm) envelope with connectors present — proves jsonb round-trips the nested union.
const SEALED_RECORD: DeployRecord = {
  schemaVersion: 1,
  deploymentId: 'partner-99887766',
  orgSlug: 'acme',
  appSlug: 'partner',
  environment: 'prod',
  deploymentVersion: 1,
  active: true,
  serverName: 'partner',
  createdAt: '2026-06-04T12:34:56.000Z',
  createdBySubject: 'owner-sub',
  accessMode: 'owner-only',
  manifest: 'manifestVersion: "1"\nserver:\n  name: partner\n',
  connectors: 'version: "1"\n',
  secrets: {
    enc: 'aes-256-gcm',
    sealed: { v: 1, algo: 'aes-256-gcm', keyId: 'static', iv: 'aXY=', tag: 'dGFn', ct: 'Y3Q=' },
  },
};

const STATE: ArtifactState = {
  handles: {
    draft: {
      kind: 'draft',
      version: 'v1',
      scope: 'caller',
      ttlSeconds: 60,
      schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          count: { type: 'integer' },
        },
      },
    },
  },
};

describe.skipIf(!URL)('PostgresArtifactStore (integration)', () => {
  let admin: Pool;
  let pool: Pool;
  let store: PostgresArtifactStore;
  let now = Date.parse('2026-06-11T00:00:00.000Z');

  beforeAll(async () => {
    admin = new Pool({ connectionString: URL, max: 1 });
    await admin.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    pool = new Pool({ connectionString: URL, max: 3, options: `-c search_path=${SCHEMA}` });
    store = new PostgresArtifactStore(pool, { now: () => new Date(now) });
    await store.ensureSchema();
    await store.ensureSchema(); // idempotent — a second call must not throw
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  });
  beforeEach(async () => {
    now = Date.parse('2026-06-11T00:00:00.000Z');
    await pool.query(
      'TRUNCATE state_handle_records, deploy_records, environments, apps, signup_allowlist, org_invitations, org_openai_apps_challenges, org_domains, welcome_email_outbox, org_members, orgs CASCADE',
    );
    await pool.query(`INSERT INTO orgs (slug) VALUES ('acme')`);
  });

  it('round-trips a "none" envelope record: append then get', async () => {
    await store.append(NONE_RECORD);
    expect(await store.get(NONE_RECORD.deploymentId)).toEqual(NONE_RECORD);
  });

  it('reads deployment summaries without transferring historical payload columns', async () => {
    await store.append({ ...NONE_RECORD, manifest: 'x'.repeat(1024 * 1024) });
    const query = vi.spyOn(pool, 'query');
    try {
      expect(await store.getApp('acme', 'hello')).toBeDefined();
      expect(await store.getEnvironment('acme', 'hello', 'prod')).toBeDefined();
      expect((await store.listApps('acme')).apps).toHaveLength(1);
      expect(await store.listEnvironments('acme', 'hello')).toHaveLength(1);
      expect(await store.listDeployments({ org: 'acme' })).toHaveLength(1);
      expect(await store.getDeployment('acme', NONE_RECORD.deploymentId)).toMatchObject({
        deploymentId: NONE_RECORD.deploymentId,
      });
      const projections = query.mock.calls
        .map(([sql]) => (typeof sql === 'string' ? sql : ''))
        .filter((sql) => /\bFROM deploy_records\b/.test(sql))
        .map((sql) => sql.slice(0, sql.indexOf('FROM')));
      expect(projections).toHaveLength(6);
      for (const projection of projections) {
        expect(projection).not.toContain('*');
        expect(projection).not.toMatch(
          /\b(manifest|connectors|secrets|hosted_assets|app_package_snapshot|server_auth)\b/,
        );
      }
    } finally {
      query.mockRestore();
    }
  });

  it('adds the nullable owner column idempotently and leaves legacy rows on creator fallback', async () => {
    await pool.query('ALTER TABLE deploy_records DROP COLUMN IF EXISTS owner_subject');

    await store.ensureSchema();
    await store.ensureSchema();

    const columns = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'deploy_records'
         AND column_name = 'owner_subject'`,
    );
    expect(columns.rows).toEqual([{ column_name: 'owner_subject', is_nullable: 'YES' }]);

    await store.append(NONE_RECORD);
    const persisted = await store.get(NONE_RECORD.deploymentId);
    expect(persisted).not.toHaveProperty('ownerSubject');
    expect(deploymentOwnerSubject(persisted as DeployRecord)).toBe(NONE_RECORD.createdBySubject);
    await expect(
      pool.query<{ owner_subject: string | null; schema_version: number }>(
        'SELECT owner_subject, schema_version FROM deploy_records WHERE deployment_id = $1',
        [NONE_RECORD.deploymentId],
      ),
    ).resolves.toMatchObject({ rows: [{ owner_subject: null, schema_version: 1 }] });
  });

  it('round-trips an explicit owner independently of the creator', async () => {
    await store.ensureSchema();
    const bound = { ...NONE_RECORD, ownerSubject: 'oauth-human' };

    await store.append(bound);

    await expect(store.get(bound.deploymentId)).resolves.toEqual(bound);
    expect(deploymentOwnerSubject((await store.get(bound.deploymentId)) as DeployRecord)).toBe(
      'oauth-human',
    );
  });

  it('does not create organizations implicitly while persisting a deployment', async () => {
    await expect(
      store.append({ ...NONE_RECORD, deploymentId: 'ghost-12345678', orgSlug: 'ghost' }),
    ).rejects.toThrow(/organization must be created before deploy/);
    expect(await store.getOrg('ghost')).toBeUndefined();
  });

  it('atomically provisions one personal workspace and one claimable welcome email', async () => {
    const input = {
      slug: 'u-alex-12345678',
      displayName: 'alex@example.com',
      subject: 'google-sub-alex',
      email: 'Alex@Example.com',
    };
    const [first, second] = await Promise.all([
      store.provisionPersonalWorkspace(input),
      store.provisionPersonalWorkspace(input),
    ]);

    expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
    const claimed = await store.claimWelcomeEmail({ now: new Date(now), leaseMs: 30_000 });
    expect(claimed).toMatchObject({
      subject: input.subject,
      email: 'alex@example.com',
      attemptCount: 1,
    });
    expect(await store.claimWelcomeEmail({ now: new Date(now), leaseMs: 30_000 })).toBeUndefined();
  });

  it('persists state handles with caller isolation and atomic revision checks', async () => {
    const stateStore = new PostgresStateHandleStore(pool, {
      deploymentId: 'stateful-12345678',
      state: STATE,
      now: () => new Date(now),
    });

    expect(await stateStore.read({ handle: 'draft', callerSubject: 'alice' })).toMatchObject({
      value: {},
      revision: 0,
      status: 'active',
    });
    expect(
      await stateStore.patch({
        handle: 'draft',
        callerSubject: 'alice',
        expectedRevision: 0,
        value: { title: 'One', count: 1 },
      }),
    ).toMatchObject({
      value: { title: 'One', count: 1 },
      revision: 1,
      status: 'active',
    });
    expect(await stateStore.read({ handle: 'draft', callerSubject: 'bob' })).toMatchObject({
      value: {},
      revision: 0,
    });
    await expect(
      stateStore.patch({
        handle: 'draft',
        callerSubject: 'alice',
        expectedRevision: 0,
        value: { title: 'stale' },
      }),
    ).rejects.toThrow(/revision conflict/);
  });

  it('keeps completed durable state handles read-only', async () => {
    const stateStore = new PostgresStateHandleStore(pool, {
      deploymentId: 'stateful-12345678',
      state: STATE,
      now: () => new Date(now),
    });
    await stateStore.patch({ handle: 'draft', expectedRevision: 0, value: { title: 'Done' } });
    expect(await stateStore.complete({ handle: 'draft', expectedRevision: 1 })).toMatchObject({
      revision: 2,
      status: 'completed',
    });
    await expect(
      stateStore.patch({ handle: 'draft', expectedRevision: 2, value: { title: 'Again' } }),
    ).rejects.toThrow(/read-only/);
  });

  it('fails closed on persisted state handle version mismatch', async () => {
    const v1 = new PostgresStateHandleStore(pool, {
      deploymentId: 'stateful-12345678',
      state: STATE,
      now: () => new Date(now),
    });
    await v1.patch({ handle: 'draft', expectedRevision: 0, value: { title: 'V1' } });

    const v2 = new PostgresStateHandleStore(pool, {
      deploymentId: 'stateful-12345678',
      state: {
        handles: {
          draft: { ...STATE.handles.draft, version: 'v2' },
        },
      },
      now: () => new Date(now),
    });
    await expect(v2.read({ handle: 'draft' })).rejects.toThrow(/version mismatch/);
    await expect(
      v2.patch({ handle: 'draft', expectedRevision: 1, value: { title: 'V2' } }),
    ).rejects.toThrow(/version mismatch/);
  });

  it('atomically recreates expired caller state without pruning or restarting', async () => {
    const stateStore = new PostgresStateHandleStore(pool, {
      deploymentId: 'stateful-12345678',
      state: STATE,
      now: () => new Date(now),
    });
    const initial = await stateStore.patch({
      handle: 'draft',
      callerSubject: 'alice',
      expectedRevision: 0,
      value: { title: 'Initial', count: 1 },
    });
    expect(await stateStore.read({ handle: 'draft', callerSubject: 'alice' })).toMatchObject({
      value: { title: 'Initial', count: 1 },
      revision: initial.revision,
      status: 'active',
    });
    const initialLifecycle = await pool.query<{ created_at: Date }>(
      `SELECT created_at
       FROM state_handle_records
       WHERE deployment_id = $1 AND handle_name = $2 AND owner_key = $3 AND state_key = $4`,
      ['stateful-12345678', 'draft', 'alice', 'default'],
    );
    expect(initialLifecycle.rows[0]?.created_at).toEqual(new Date(now));

    now += 61_000;
    const expired = await stateStore.read({ handle: 'draft', callerSubject: 'alice' });
    expect(expired).toMatchObject({
      revision: initial.revision + 1,
      status: 'expired',
    });
    await expect(
      stateStore.patch({
        handle: 'draft',
        callerSubject: 'alice',
        expectedRevision: initial.revision,
        value: { title: 'Stale' },
      }),
    ).rejects.toThrow(/revision conflict/);

    const attempts = await Promise.allSettled([
      stateStore.patch({
        handle: 'draft',
        callerSubject: 'alice',
        expectedRevision: expired.revision,
        value: { title: 'First fresh writer' },
      }),
      stateStore.patch({
        handle: 'draft',
        callerSubject: 'alice',
        expectedRevision: expired.revision,
        value: { title: 'Second fresh writer' },
      }),
    ]);
    const winners = attempts.flatMap((attempt) =>
      attempt.status === 'fulfilled' ? [attempt.value] : [],
    );
    expect(winners).toHaveLength(1);
    const rejection = attempts.find((attempt) => attempt.status === 'rejected');
    expect(String(rejection && rejection.status === 'rejected' ? rejection.reason : '')).toMatch(
      /revision conflict/,
    );

    const winner = winners[0];
    expect(winner).toBeDefined();
    if (winner === undefined) throw new Error('expected exactly one fresh state writer');
    const recreatedLifecycle = await pool.query<{ created_at: Date }>(
      `SELECT created_at
       FROM state_handle_records
       WHERE deployment_id = $1 AND handle_name = $2 AND owner_key = $3 AND state_key = $4`,
      ['stateful-12345678', 'draft', 'alice', 'default'],
    );
    expect(recreatedLifecycle.rows[0]?.created_at).toEqual(new Date(now));
    const patched = await stateStore.patch({
      handle: 'draft',
      callerSubject: 'alice',
      expectedRevision: winner.revision,
      value: { count: 2 },
    });
    expect(patched).toMatchObject({
      value: { title: winner.value.title, count: 2 },
      revision: winner.revision + 1,
      status: 'active',
    });
    expect(await stateStore.read({ handle: 'draft', callerSubject: 'bob' })).toMatchObject({
      value: {},
      revision: 0,
      status: 'active',
    });
    expect(await stateStore.pruneExpired()).toBe(0);
  });

  it('retains explicit expired-state pruning as optional cleanup', async () => {
    const stateStore = new PostgresStateHandleStore(pool, {
      deploymentId: 'stateful-12345678',
      state: STATE,
      now: () => new Date(now),
    });
    await stateStore.patch({ handle: 'draft', expectedRevision: 0, value: { title: 'Soon' } });
    now += 61_000;
    expect(await stateStore.pruneExpired()).toBe(1);
    expect(await stateStore.read({ handle: 'draft' })).toMatchObject({
      value: {},
      revision: 0,
      status: 'active',
    });
  });

  it('round-trips a sealed envelope + connectors faithfully through jsonb', async () => {
    await store.append(SEALED_RECORD);
    expect(await store.get(SEALED_RECORD.deploymentId)).toEqual(SEALED_RECORD);
  });

  it('round-trips org-member access mode', async () => {
    const record: DeployRecord = {
      ...NONE_RECORD,
      deploymentId: 'team-abcdef12',
      appSlug: 'team',
      accessMode: 'org-members',
    };
    await store.append(record);
    expect(await store.get(record.deploymentId)).toEqual(record);
  });

  it('get returns undefined for an unknown id', async () => {
    expect(await store.get('missing-00000000')).toBeUndefined();
  });

  it('append upserts on conflict (second write wins)', async () => {
    await store.append(NONE_RECORD);
    await store.append({ ...NONE_RECORD, serverName: 'hello-v2' });
    const got = await store.get(NONE_RECORD.deploymentId);
    expect(got?.serverName).toBe('hello-v2');
    expect(await store.loadAll()).toHaveLength(1);
  });

  it('loadAll returns every record', async () => {
    await store.append(NONE_RECORD);
    await store.append(SEALED_RECORD);
    const all = await store.loadAll();
    expect(all.map((r) => r.deploymentId).sort()).toEqual(
      [NONE_RECORD.deploymentId, SEALED_RECORD.deploymentId].sort(),
    );
  });

  it('returns the active record by tenant ref', async () => {
    await store.append(NONE_RECORD);
    expect(await store.getActiveByTenant({ org: 'acme', app: 'hello', env: 'prod' })).toEqual(
      NONE_RECORD,
    );
  });

  it('activates an older deployment for a tenant environment and deactivates the previous active row', async () => {
    const newer: DeployRecord = {
      ...NONE_RECORD,
      deploymentId: 'hello-newer1234',
      deploymentVersion: 2,
      serverName: 'hello-v2',
    };
    await store.append(NONE_RECORD);
    await store.append(newer);

    const result = await store.activateDeployment(
      { org: 'acme', app: 'hello', env: 'prod' },
      NONE_RECORD.deploymentId,
    );

    expect(result).toMatchObject({
      active: NONE_RECORD,
      previousActive: newer,
      alreadyActive: false,
    });
    expect(await store.getActiveByTenant({ org: 'acme', app: 'hello', env: 'prod' })).toEqual(
      NONE_RECORD,
    );
    expect((await store.get(newer.deploymentId))?.active).toBe(false);
    await expect(
      store.activateDeployment({ org: 'acme', app: 'hello', env: 'prod' }, newer.deploymentId, {
        expectedAccessMode: 'customers',
      }),
    ).resolves.toBeUndefined();
  });

  it('archives, hides, restores, and sweeps an app in parity with the local stores (ADR 0117)', async () => {
    const staging: DeployRecord = {
      ...NONE_RECORD,
      deploymentId: 'hello-stag1234',
      environment: 'staging',
      deploymentVersion: 2,
    };
    const other: DeployRecord = {
      ...NONE_RECORD,
      deploymentId: 'other-abcd1234',
      appSlug: 'other',
      serverName: 'other',
      deploymentVersion: 3,
    };
    await store.append(NONE_RECORD);
    await store.append(staging);
    await store.append(other);
    const at = '2026-07-04T00:00:00.000Z';

    // Archive stamps every record for the app, across environments.
    expect(await store.archiveApp('acme', 'hello', at)).toEqual({
      archivedAt: at,
      archivedDeployments: 2,
      alreadyArchived: false,
    });
    expect(await store.getAppArchivedAt('acme', 'hello')).toBe(at);
    expect((await store.get(NONE_RECORD.deploymentId))?.archivedAt).toBe(at);
    expect(await store.getAppArchivedAt('acme', 'other')).toBeUndefined();

    // Tenant lookup misses; the default list hides; includeArchived reveals with archivedAt.
    expect(
      await store.getActiveByTenant({ org: 'acme', app: 'hello', env: 'prod' }),
    ).toBeUndefined();
    expect((await store.listDeployments({ org: 'acme' })).map((d) => d.deploymentId)).toEqual([
      other.deploymentId,
    ]);
    const all = await store.listDeployments({ org: 'acme', includeArchived: true });
    expect(all).toHaveLength(3);
    expect(all.find((d) => d.deploymentId === staging.deploymentId)?.archivedAt).toBe(at);

    // Re-archive is a no-op preserving the original stamp; unknown app is undefined.
    expect(await store.archiveApp('acme', 'hello', '2026-07-10T00:00:00.000Z')).toEqual({
      archivedAt: at,
      archivedDeployments: 0,
      alreadyArchived: true,
    });
    expect(await store.archiveApp('acme', 'ghost', at)).toBeUndefined();

    // Restore clears the stamp and the app serves again.
    expect(await store.restoreApp('acme', 'hello')).toEqual({ restoredDeployments: 2 });
    expect(await store.getActiveByTenant({ org: 'acme', app: 'hello', env: 'prod' })).toEqual(
      NONE_RECORD,
    );

    // Sweep deletes a fully expired app as a unit, including its app/environment anchors. Apps with
    // either a live deployment or only newer archive stamps retain every row and anchor.
    await store.archiveApp('acme', 'hello', at);
    await store.archiveApp('acme', 'other', '2026-07-20T00:00:00.000Z');
    const mixedExpired: DeployRecord = {
      ...NONE_RECORD,
      deploymentId: 'mixed-old1234',
      appSlug: 'mixed',
      serverName: 'mixed',
      archivedAt: at,
      deploymentVersion: 4,
    };
    const mixedLive: DeployRecord = {
      ...mixedExpired,
      deploymentId: 'mixed-live1234',
      archivedAt: undefined,
      deploymentVersion: 5,
    };
    await store.append(mixedExpired);
    await store.append(mixedLive);
    const deleted = await store.sweepArchived('2026-07-10T00:00:00.000Z');
    expect(deleted.map((record) => record.deploymentId).sort()).toEqual(
      [NONE_RECORD.deploymentId, staging.deploymentId].sort(),
    );
    expect(await store.get(NONE_RECORD.deploymentId)).toBeUndefined();
    expect(await store.getApp('acme', 'hello')).toBeUndefined();
    expect(await store.listEnvironments('acme', 'hello')).toEqual([]);
    await expect(
      pool.query<{ apps: number; environments: number; deployments: number }>(
        `SELECT
           (SELECT count(*)::int FROM apps WHERE org_slug = $1 AND slug = $2) AS apps,
           (SELECT count(*)::int FROM environments WHERE org_slug = $1 AND app_slug = $2) AS environments,
           (SELECT count(*)::int FROM deploy_records WHERE org_slug = $1 AND app_slug = $2) AS deployments`,
        ['acme', 'hello'],
      ),
    ).resolves.toMatchObject({ rows: [{ apps: 0, environments: 0, deployments: 0 }] });

    expect(await store.getApp('acme', 'mixed')).toBeDefined();
    expect(await store.getApp('acme', 'other')).toBeDefined();
    await expect(
      pool.query<{ app_slug: string; apps: number; environments: number; deployments: number }>(
        `SELECT expected.app_slug,
                count(DISTINCT app.slug)::int AS apps,
                count(DISTINCT env.name)::int AS environments,
                count(DISTINCT deployment.deployment_id)::int AS deployments
         FROM (VALUES ('mixed'), ('other')) AS expected(app_slug)
         LEFT JOIN apps app ON app.org_slug = $1 AND app.slug = expected.app_slug
         LEFT JOIN environments env
           ON env.org_slug = app.org_slug AND env.app_slug = app.slug
         LEFT JOIN deploy_records deployment
           ON deployment.org_slug = app.org_slug AND deployment.app_slug = app.slug
         GROUP BY expected.app_slug
         ORDER BY expected.app_slug`,
        ['acme'],
      ),
    ).resolves.toMatchObject({
      rows: [
        { app_slug: 'mixed', apps: 1, environments: 1, deployments: 2 },
        { app_slug: 'other', apps: 1, environments: 1, deployments: 1 },
      ],
    });
    expect(await store.get(mixedExpired.deploymentId)).toBeDefined();
    expect(await store.get(mixedLive.deploymentId)).toBeDefined();
    expect((await store.get(other.deploymentId))?.archivedAt).toBe('2026-07-20T00:00:00.000Z');
  });

  it('serves no stranded resources after purge while a retained archive stays restorable', async () => {
    const expired: DeployRecord = {
      ...NONE_RECORD,
      deploymentId: 'expired-abcd1234',
      appSlug: 'expired-app',
      serverName: 'expired-app',
    };
    const retained: DeployRecord = {
      ...NONE_RECORD,
      deploymentId: 'retained-abcd1234',
      appSlug: 'retained-app',
      serverName: 'retained-app',
    };
    await store.append(expired);
    await store.append(retained);
    await store.archiveApp('acme', expired.appSlug, '2026-07-01T00:00:00.000Z');
    await store.archiveApp('acme', retained.appSlug, '2026-08-20T00:00:00.000Z');
    await expect(store.sweepArchived('2026-08-03T10:00:00.000Z')).resolves.toEqual([
      { ...expired, archivedAt: '2026-07-01T00:00:00.000Z' },
    ]);
    await store.addOrgMember({
      org: 'acme',
      subject: 'owner-sub',
      email: 'owner@acme.test',
      role: 'owner',
    });

    const service = await serveService({
      port: 0,
      postgresPool: { pool, close: () => Promise.resolve() },
      secretMasterKey: Buffer.alloc(32, 9).toString('base64'),
      archiveRetentionDays: 30,
      clock: () => new Date('2026-09-02T10:00:00.000Z'),
      buildInfo: {
        version: 'test',
        gitSha: 'b'.repeat(40),
        buildTime: '2026-09-02T10:00:00.000Z',
      },
      deployGate: {
        authorize: (req) => {
          const token = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
          if (token === 'admin-token') {
            return Promise.resolve({
              ok: true as const,
              identity: {
                subject: 'admin-sub',
                email: 'admin@noodleseed.test',
                superAdmin: true,
              },
            });
          }
          if (token === 'owner-token') {
            return Promise.resolve({
              ok: true as const,
              identity: {
                subject: 'owner-sub',
                email: 'owner@acme.test',
                superAdmin: false,
              },
            });
          }
          return Promise.resolve({
            ok: false as const,
            status: 401 as const,
            message: 'invalid bearer token',
          });
        },
      },
    });
    const ownerAuth = { authorization: 'Bearer owner-token' };
    try {
      const previewResponse = await fetch(
        `${service.url}/v1/service/app-purge-reconciliation/preview`,
        {
          method: 'POST',
          headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
          body: JSON.stringify({ schemaVersion: 1 }),
        },
      );
      expect(previewResponse.status).toBe(200);
      expect(await previewResponse.json()).toMatchObject({
        ok: true,
        artifact: { releaseSha: 'b'.repeat(40), candidateCount: 0, candidates: [] },
      });

      const defaultApps = await fetch(`${service.url}/v1/orgs/acme/apps`, {
        headers: ownerAuth,
      });
      expect(defaultApps.status).toBe(200);
      expect(
        (await defaultApps.json()).data.apps.map((app: { appSlug: string }) => app.appSlug),
      ).toEqual([]);

      const archivedApps = await fetch(`${service.url}/v1/orgs/acme/apps?archived=true`, {
        headers: ownerAuth,
      });
      expect(archivedApps.status).toBe(200);
      expect(
        (await archivedApps.json()).data.apps.map((app: { appSlug: string }) => app.appSlug),
      ).toEqual(['retained-app']);

      const purgedPaths = [
        `/v1/orgs/acme/apps/${expired.appSlug}`,
        `/v1/orgs/acme/apps/${expired.appSlug}/envs`,
        `/v1/orgs/acme/apps/${expired.appSlug}/envs/prod`,
        `/v1/orgs/acme/apps/${expired.appSlug}/envs/prod/status`,
        `/v1/orgs/acme/apps/${expired.appSlug}/envs/prod/inspect`,
      ];
      for (const path of purgedPaths) {
        expect((await fetch(`${service.url}${path}`, { headers: ownerAuth })).status, path).toBe(
          404,
        );
      }
      expect(
        (
          await fetch(`${service.url}/v1/orgs/acme/apps/${expired.appSlug}/restore`, {
            method: 'POST',
            headers: ownerAuth,
          })
        ).status,
      ).toBe(404);

      const restored = await fetch(`${service.url}/v1/orgs/acme/apps/${retained.appSlug}/restore`, {
        method: 'POST',
        headers: ownerAuth,
      });
      expect(restored.status).toBe(200);
      expect(await restored.json()).toMatchObject({ restore: { restoredDeployments: 1 } });
      const visibleAfterRestore = await fetch(`${service.url}/v1/orgs/acme/apps`, {
        headers: ownerAuth,
      });
      expect(
        (await visibleAfterRestore.json()).data.apps.map((app: { appSlug: string }) => app.appSlug),
      ).toEqual(['retained-app']);
    } finally {
      await service.close();
    }
  });

  it('creates orgs and manages org membership', async () => {
    const org = await store.createOrg({ slug: 'acme', displayName: 'Acme' });
    expect(org.slug).toBe('acme');
    expect(org.displayName).toBe('Acme');

    const member = await store.addOrgMember({
      org: 'acme',
      subject: 'sub-owner',
      email: 'owner@noodleseed.com',
      role: 'owner',
    });
    expect(member.email).toBe('owner@noodleseed.com');
    expect(await store.isOrgMember({ org: 'acme', subject: 'sub-owner' })).toBe(true);
    expect((await store.listOrgMembers('acme')).map((m) => m.subject)).toEqual(['sub-owner']);
    expect((await store.listOrgsForSubject('sub-owner')).map((o) => o.slug)).toEqual(['acme']);

    expect(await store.removeOrgMember({ org: 'acme', subject: 'sub-owner' })).toBe(true);
    expect(await store.isOrgMember({ org: 'acme', subject: 'sub-owner' })).toBe(false);
  });

  it('atomically creates or repairs an org owner without adding a second claimant', async () => {
    await store.createOrgWithOwner({
      slug: 'acme',
      displayName: 'Acme',
      owner: { subject: 'sub-first', email: 'First@Example.com' },
    });
    await store.createOrgWithOwner({
      slug: 'acme',
      owner: { subject: 'sub-second', email: 'second@example.com' },
    });
    expect(await store.listOrgMembers('acme')).toEqual([
      expect.objectContaining({ subject: 'sub-first', email: 'first@example.com', role: 'owner' }),
    ]);

    await store.createOrg({ slug: 'legacy' });
    await store.createOrgWithOwner({
      slug: 'legacy',
      owner: { subject: 'sub-admin', email: 'admin@example.com' },
    });
    expect(await store.listOrgMembers('legacy')).toEqual([
      expect.objectContaining({ subject: 'sub-admin', role: 'owner' }),
    ]);
  });

  it('renames orgs and changes member roles without creating rows (issue #267 parity)', async () => {
    await store.createOrg({ slug: 'acme', displayName: 'Acme' });
    expect(await store.updateOrg({ slug: 'acme', displayName: 'Acme Industries' })).toMatchObject({
      slug: 'acme',
      displayName: 'Acme Industries',
    });
    expect(await store.updateOrg({ slug: 'ghost', displayName: 'Ghost' })).toBeUndefined();
    expect((await store.listOrgs()).map((org) => org.slug)).toEqual(['acme']);

    await store.addOrgMember({
      org: 'acme',
      subject: 'sub-dev',
      email: 'dev@example.com',
      role: 'developer',
    });
    expect(
      await store.updateOrgMemberRole({ org: 'acme', subject: 'sub-dev', role: 'owner' }),
    ).toMatchObject({ orgSlug: 'acme', subject: 'sub-dev', role: 'owner' });
    expect(
      await store.updateOrgMemberRole({ org: 'acme', subject: 'sub-ghost', role: 'owner' }),
    ).toBeUndefined();
    expect((await store.listOrgMembers('acme')).map((member) => member.subject)).toEqual([
      'sub-dev',
    ]);
  });

  it('lists and revokes org invitations by email (issue #267 parity)', async () => {
    await store.createOrg({ slug: 'acme' });
    await store.createOrgInvitation({
      org: 'acme',
      email: 'pending@example.com',
      role: 'developer',
      tokenHash: 'hash-pending',
      createdBySubject: 'owner-sub',
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    });
    now += 1000;
    await store.createOrgInvitation({
      org: 'acme',
      email: 'joined@example.com',
      role: 'developer',
      tokenHash: 'hash-joined',
      createdBySubject: 'owner-sub',
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    });
    await store.consumeOrgInvitation({ tokenHash: 'hash-joined' });

    // Newest-first, accepted records included (callers derive status).
    const invitations = await store.listOrgInvitations('acme');
    expect(invitations.map((record) => record.email)).toEqual([
      'joined@example.com',
      'pending@example.com',
    ]);
    expect(invitations[0]?.acceptedAt).toBeDefined();

    expect(await store.revokeOrgInvitation({ org: 'acme', email: 'Pending@Example.COM' })).toBe(1);
    expect(await store.getOrgInvitation({ tokenHash: 'hash-pending' })).toBeUndefined();
    // Accepted invitations are history and survive revocation.
    expect(await store.revokeOrgInvitation({ org: 'acme', email: 'joined@example.com' })).toBe(0);
    expect((await store.listOrgInvitations('acme')).map((record) => record.email)).toEqual([
      'joined@example.com',
    ]);
  });

  it('stores explicit org invitations as hash-at-rest single-use records', async () => {
    await store.createOrg({ slug: 'acme' });
    const invitation = await store.createOrgInvitation({
      org: 'acme',
      email: 'New@Example.com',
      role: 'developer',
      tokenHash: 'hash-1',
      createdBySubject: 'owner-sub',
      createdByEmail: 'owner@noodleseed.com',
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    });
    expect(invitation).toMatchObject({
      orgSlug: 'acme',
      email: 'new@example.com',
      role: 'developer',
      tokenHash: 'hash-1',
      createdBySubject: 'owner-sub',
      createdByEmail: 'owner@noodleseed.com',
    });
    expect(await store.getOrgInvitation({ tokenHash: 'hash-1' })).toMatchObject({
      email: 'new@example.com',
    });
    expect(await store.consumeOrgInvitation({ tokenHash: 'hash-1' })).toMatchObject({
      acceptedAt: expect.any(String),
    });
    expect(await store.consumeOrgInvitation({ tokenHash: 'hash-1' })).toBeUndefined();
  });

  it('manages domain data-plane membership and signup allowlists', async () => {
    await store.createOrg({ slug: 'acme' });
    const domain = await store.addOrgDomain({
      org: 'acme',
      domain: 'Acme.com',
      challenge: 'proof',
    });
    expect(domain).toMatchObject({ orgSlug: 'acme', domain: 'acme.com', challenge: 'proof' });
    const employee = { org: 'acme', subject: 'employee-sub', email: 'employee@acme.com' };
    // Registration is the grant: no DNS proof is involved (ADR 0181).
    expect(await store.isDataPlaneOrgMember(employee)).toBe(true);
    expect(await store.isOrgMember({ org: 'acme', subject: 'employee-sub' })).toBe(false);

    // The dormant proof columns still round-trip, and still gate nothing.
    await store.markOrgDomainVerification({ org: 'acme', domain: 'acme.com', verified: false });
    expect((await store.listOrgDomains('acme'))[0]).toMatchObject({
      domain: 'acme.com',
      lastCheckedAt: expect.any(String),
    });
    expect(await store.isDataPlaneOrgMember(employee)).toBe(true);

    await store.addOrgDomain({ org: 'acme', domain: 'second.example' });
    expect(await store.listOrgDomains('acme')).toHaveLength(2);
    expect(
      await store.isDataPlaneOrgMember({ ...employee, email: 'employee@second.example' }),
    ).toBe(true);

    await expect(store.addOrgDomain({ org: 'acme', domain: 'gmail.com' })).rejects.toThrow(
      /--access authenticated/,
    );

    expect(await store.removeOrgDomain({ org: 'acme', domain: 'ACME.com' })).toBe(true);
    expect(await store.removeOrgDomain({ org: 'acme', domain: 'acme.com' })).toBe(false);
    expect(await store.isDataPlaneOrgMember(employee)).toBe(false);

    await store.allowSignup({ kind: 'domain', value: 'Partner.example' });
    await store.allowSignup({ kind: 'subject', value: 'Subject-A' });
    expect(await store.isSignupAllowed({ subject: 'nope', email: 'person@partner.example' })).toBe(
      true,
    );
    expect(await store.isSignupAllowed({ subject: 'subject-a', email: 'person@example.com' })).toBe(
      true,
    );
    expect(await store.isSignupAllowed({ subject: 'blocked', email: 'person@example.com' })).toBe(
      false,
    );
  });

  it('persists one OpenAI Apps challenge per org', async () => {
    await store.createOrg({ slug: 'acme' });
    const created = await store.setOrgOpenAIAppsChallenge({
      org: 'acme',
      challenge: '  openai-code  ',
      updatedBySubject: 'owner-sub',
      updatedByEmail: 'owner@noodleseed.com',
    });
    expect(created).toMatchObject({
      orgSlug: 'acme',
      challenge: 'openai-code',
      updatedBySubject: 'owner-sub',
      updatedByEmail: 'owner@noodleseed.com',
    });
    await store.setOrgOpenAIAppsChallenge({ org: 'acme', challenge: 'next-code' });
    expect(await store.getOrgOpenAIAppsChallenge('acme')).toMatchObject({
      orgSlug: 'acme',
      challenge: 'next-code',
      updatedBySubject: 'owner-sub',
      updatedByEmail: 'owner@noodleseed.com',
    });
    expect(await store.clearOrgOpenAIAppsChallenge('acme')).toBe(true);
    expect(await store.getOrgOpenAIAppsChallenge('acme')).toBeUndefined();
  });

  it('rejects an unsafe deploymentId on append', async () => {
    await expect(store.append({ ...NONE_RECORD, deploymentId: '../escape' })).rejects.toThrow(
      /invalid deploymentId/,
    );
  });

  it('getOrg reads a created org and is undefined for an unknown one', async () => {
    await store.createOrg({ slug: 'acme', displayName: 'Acme' });
    expect(await store.getOrg('acme')).toMatchObject({ slug: 'acme', displayName: 'Acme' });
    expect(await store.getOrg('ghost')).toBeUndefined();
  });

  it('lists an empty-anchor app (an `apps` row with zero deploy records)', async () => {
    // App anchors may be created deliberately before any deployment exists.
    await store.createOrg({ slug: 'acme' });
    await pool.query(`INSERT INTO apps (org_slug, slug, created_at) VALUES ($1, $2, $3)`, [
      'acme',
      'empty-app',
      '2025-06-01T00:00:00.000Z',
    ]);

    const { apps, truncated } = await store.listApps('acme');
    expect(truncated).toBe(false);
    expect(apps).toEqual([
      {
        orgSlug: 'acme',
        appSlug: 'empty-app',
        environments: [],
        active: false,
        createdAt: '2025-06-01T00:00:00.000Z',
      },
    ]);
    expect(await store.getApp('acme', 'empty-app')).toEqual(apps[0]);
    expect(await store.getApp('acme', 'ghost')).toBeUndefined();
  });

  it('groups deploy_records into an AppSummary per app, in parity with the local stores', async () => {
    const staging: DeployRecord = {
      ...NONE_RECORD,
      deploymentId: 'hello-stag5678',
      environment: 'staging',
      deploymentVersion: 2,
      createdAt: '2026-06-05T00:00:00.000Z',
    };
    await store.append(NONE_RECORD);
    await store.append(staging);

    const { apps } = await store.listApps('acme');
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({
      appSlug: 'hello',
      environments: ['prod', 'staging'],
      active: true,
      lastActivityAt: '2026-06-05T00:00:00.000Z',
    });
  });

  it('lists an empty-anchor env (an `environments` row with zero deploy records)', async () => {
    // Environment anchors may be created deliberately before any deployment exists.
    await store.createOrg({ slug: 'acme' });
    await pool.query(`INSERT INTO apps (org_slug, slug, created_at) VALUES ($1, $2, $3)`, [
      'acme',
      'hello',
      '2025-06-01T00:00:00.000Z',
    ]);
    await pool.query(
      `INSERT INTO environments (org_slug, app_slug, name, is_production, created_at)
       VALUES ($1, $2, $3, true, $4)`,
      ['acme', 'hello', 'empty-env', '2025-06-01T00:00:00.000Z'],
    );

    const envs = await store.listEnvironments('acme', 'hello');
    expect(envs).toEqual([
      {
        orgSlug: 'acme',
        appSlug: 'hello',
        envName: 'empty-env',
        isProduction: true,
        active: false,
        createdAt: '2025-06-01T00:00:00.000Z',
        deploymentCount: 0,
      },
    ]);
    expect(await store.getEnvironment('acme', 'hello', 'empty-env')).toEqual(envs[0]);
    expect(await store.getEnvironment('acme', 'hello', 'ghost')).toBeUndefined();
  });

  it('groups deploy_records into an EnvSummary per environment, in parity with the local stores', async () => {
    const staging: DeployRecord = {
      ...NONE_RECORD,
      deploymentId: 'hello-stag5678',
      environment: 'staging',
      deploymentVersion: 2,
      createdAt: '2026-06-05T00:00:00.000Z',
    };
    await store.append(NONE_RECORD);
    await store.append(staging);

    const envs = await store.listEnvironments('acme', 'hello');
    expect(envs.map((env) => env.envName)).toEqual(['prod', 'staging']);
    expect(envs[0]).toMatchObject({
      envName: 'prod',
      isProduction: true,
      active: true,
      deploymentCount: 1,
    });
    expect(envs[1]).toMatchObject({
      envName: 'staging',
      deploymentCount: 1,
      lastActivityAt: '2026-06-05T00:00:00.000Z',
    });

    expect(await store.getEnvironment('acme', 'hello', 'prod')).toEqual(envs[0]);
    expect(await store.getEnvironment('acme', 'ghost', 'prod')).toBeUndefined();
  });

  registerPostgresProductionEnvironmentTests(
    () => store,
    () => pool,
    NONE_RECORD,
  );

  it('getDeployment reads one deployment by id, scoped to org (never leaking cross-org)', async () => {
    await store.append(NONE_RECORD);

    const deployment = await store.getDeployment('acme', NONE_RECORD.deploymentId);
    expect(deployment).toMatchObject({
      deploymentId: NONE_RECORD.deploymentId,
      orgSlug: 'acme',
      appSlug: 'hello',
      environment: 'prod',
      active: true,
    });
    // The redacted summary must never include secrets.
    expect(deployment).not.toHaveProperty('secrets');

    expect(await store.getDeployment('acme', 'ghost-deadbeef')).toBeUndefined();
    // Belongs to `acme`, not `other` — cross-org existence must not leak.
    expect(await store.getDeployment('other', NONE_RECORD.deploymentId)).toBeUndefined();
  });
});
