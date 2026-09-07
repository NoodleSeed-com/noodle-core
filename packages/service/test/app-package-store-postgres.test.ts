import { compileManifest } from '@noodle-borg/compiler';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createAppPackageSnapshot } from '../src/app-package-snapshot.js';
import { type DeployRecord, PostgresArtifactStore } from '../src/index.js';

const URL = process.env.DATABASE_URL_TEST;
const SCHEMA = `app_package_store_test_${process.pid}`;
const GUIDED = `
manifestVersion: '2'
server:
  name: postgres_package
  title: Postgres Package
  version: 1.0.0
  agentGuide:
    description: Use Postgres Package to inspect records.
    useWhen: [A user asks to inspect records.]
    workflows:
      - id: inspect_records
        title: Inspect records
        steps: [{ capability: { kind: tool, name: inspect_records } }]
    boundaries: [Keep record identifiers exact.]
    examples: [{ prompt: Inspect records., workflow: inspect_records }]
tools:
  - name: inspect_records
    description: Inspect records.
    inputSchema: { type: object, properties: {}, additionalProperties: false }
    fulfilment: { steps: [], output: { records: [] } }
`;
const compiled = compileManifest(parse(GUIDED));
if (!compiled.ok || compiled.appPackage === undefined) throw new Error('fixture must compile');
const SNAPSHOT = createAppPackageSnapshot(compiled.appPackage);
const RECORD: DeployRecord = {
  schemaVersion: 1,
  deploymentId: 'postgres-package-00000001',
  orgSlug: 'acme',
  appSlug: 'postgres-package',
  environment: 'prod',
  serverVersion: '1',
  deploymentVersion: 1,
  active: false,
  serverName: 'postgres_package',
  createdAt: '2026-08-08T00:00:00.000Z',
  accessMode: 'owner-only',
  manifest: GUIDED,
  secrets: { enc: 'none', values: {} },
  appPackageSnapshot: SNAPSHOT,
};

describe.skipIf(!URL)('Postgres App Package snapshots', () => {
  let admin: Pool;
  let pool: Pool;
  let store: PostgresArtifactStore;

  beforeAll(async () => {
    admin = new Pool({ connectionString: URL, max: 1 });
    await admin.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    pool = new Pool({ connectionString: URL, max: 3, options: `-c search_path=${SCHEMA}` });
    store = new PostgresArtifactStore(pool);
    await store.ensureSchema();
    await store.ensureSchema();
  });

  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE orgs CASCADE');
    await pool.query(`INSERT INTO orgs (slug) VALUES ('acme')`);
  });

  it('adds the nullable jsonb column idempotently and round-trips every package byte', async () => {
    const column = await pool.query<{ data_type: string; is_nullable: string }>(
      `SELECT data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'deploy_records'
         AND column_name = 'app_package_snapshot'`,
    );
    expect(column.rows).toEqual([{ data_type: 'jsonb', is_nullable: 'YES' }]);

    await store.append(RECORD);
    const stored = await store.get(RECORD.deploymentId);
    expect(stored?.appPackageSnapshot).toEqual(SNAPSHOT);
    expect(stored?.appPackageSnapshot?.files.map((file) => file.content)).toEqual(
      SNAPSHOT.files.map((file) => file.content),
    );

    const restarted = new PostgresArtifactStore(pool);
    expect((await restarted.get(RECORD.deploymentId))?.appPackageSnapshot).toEqual(SNAPSHOT);
  });

  it('loads a legacy NULL snapshot and rejects a conflicting replay without changing the row', async () => {
    const legacy = { ...RECORD, deploymentId: 'postgres-package-00000002' };
    delete (legacy as { appPackageSnapshot?: unknown }).appPackageSnapshot;
    await store.append(legacy);
    await pool.query(
      'UPDATE deploy_records SET app_package_snapshot = NULL WHERE deployment_id = $1',
      [legacy.deploymentId],
    );
    expect(await store.get(legacy.deploymentId)).toEqual(legacy);

    await store.append(RECORD);
    const conflict = {
      ...RECORD,
      appPackageSnapshot: { ...SNAPSHOT, snapshotSha256: 'f'.repeat(64) },
    };
    await expect(store.append(conflict)).rejects.toThrow(
      `app package snapshot conflict for deployment ${RECORD.deploymentId}`,
    );
    expect((await store.get(RECORD.deploymentId))?.appPackageSnapshot).toEqual(SNAPSHOT);
  });

  it('migrates a populated pre-snapshot deploy table without losing its legacy row', async () => {
    const legacySchema = `${SCHEMA}_legacy`;
    await admin.query(`CREATE SCHEMA ${legacySchema}`);
    const legacyPool = new Pool({
      connectionString: URL,
      max: 3,
      options: `-c search_path=${legacySchema}`,
    });
    try {
      await legacyPool.query(`
        CREATE TABLE orgs (
          slug text PRIMARY KEY,
          display_name text,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE apps (
          org_slug text NOT NULL REFERENCES orgs(slug) ON DELETE CASCADE,
          slug text NOT NULL,
          display_name text,
          created_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (org_slug, slug)
        );
        CREATE TABLE environments (
          org_slug text NOT NULL,
          app_slug text NOT NULL,
          name text NOT NULL,
          is_production boolean NOT NULL DEFAULT false,
          created_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (org_slug, app_slug, name),
          FOREIGN KEY (org_slug, app_slug) REFERENCES apps(org_slug, slug) ON DELETE CASCADE
        );
        CREATE TABLE deploy_records (
          deployment_id text PRIMARY KEY,
          org_slug text NOT NULL,
          app_slug text NOT NULL,
          environment text NOT NULL,
          deployment_version bigint NOT NULL,
          active boolean NOT NULL,
          server_name text NOT NULL,
          created_at timestamptz NOT NULL,
          created_by_subject text,
          created_by_email text,
          access_mode text NOT NULL DEFAULT 'owner-only',
          server_auth jsonb,
          caller_key_hash text,
          manifest text NOT NULL,
          connectors text,
          hosted_assets jsonb,
          secrets jsonb NOT NULL,
          schema_version int NOT NULL,
          deployment_source text,
          FOREIGN KEY (org_slug, app_slug, environment)
            REFERENCES environments(org_slug, app_slug, name) ON DELETE CASCADE
        );
        INSERT INTO orgs (slug) VALUES ('acme');
        INSERT INTO apps (org_slug, slug) VALUES ('acme', 'postgres-package');
        INSERT INTO environments (org_slug, app_slug, name, is_production)
          VALUES ('acme', 'postgres-package', 'prod', true);
        INSERT INTO deploy_records (
          deployment_id, org_slug, app_slug, environment, deployment_version, active,
          server_name, created_at, access_mode, manifest, secrets, schema_version
        ) VALUES (
          'postgres-package-legacy', 'acme', 'postgres-package', 'prod', 1, true,
          'postgres_package', '2026-08-07T00:00:00.000Z', 'owner-only',
          'manifestVersion: "1"', '{"enc":"none","values":{}}'::jsonb, 1
        )
      `);

      const legacyStore = new PostgresArtifactStore(legacyPool);
      await legacyStore.ensureSchema();

      const column = await legacyPool.query<{ data_type: string; is_nullable: string }>(
        `SELECT data_type, is_nullable
         FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'deploy_records'
           AND column_name = 'app_package_snapshot'`,
      );
      expect(column.rows).toEqual([{ data_type: 'jsonb', is_nullable: 'YES' }]);
      const migratedLegacy = await legacyStore.get('postgres-package-legacy');
      expect(migratedLegacy).toMatchObject({
        deploymentId: 'postgres-package-legacy',
        orgSlug: 'acme',
        appSlug: 'postgres-package',
        environment: 'prod',
        manifest: 'manifestVersion: "1"',
      });
      expect(migratedLegacy?.appPackageSnapshot).toBeUndefined();

      const snapshotRecord = {
        ...RECORD,
        deploymentId: 'postgres-package-migrated',
        deploymentVersion: 2,
      };
      await legacyStore.append(snapshotRecord);
      expect((await legacyStore.get(snapshotRecord.deploymentId))?.appPackageSnapshot).toEqual(
        SNAPSHOT,
      );
      expect(await legacyStore.get('postgres-package-legacy')).toBeDefined();
    } finally {
      await legacyPool.end();
      await admin.query(`DROP SCHEMA ${legacySchema} CASCADE`);
    }
  });
});
