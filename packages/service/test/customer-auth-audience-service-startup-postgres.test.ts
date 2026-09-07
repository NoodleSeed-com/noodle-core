import { noopLogger } from '@noodle-borg/transport-http';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type DeployRecord,
  PostgresArtifactStore,
  type RunningService,
  serveService,
} from '../src/index.js';

const URL = process.env.DATABASE_URL_TEST;
const SCHEMA = `customer_auth_startup_quarantine_${process.pid}`;
const ORG = 'leaky-org';
const APP = 'leaky-app';
const ISSUER = 'https://leaky-idp.example';
const AUDIENCE = 'leaky-audience';
const AUTH = { issuer: ISSUER, audience: AUDIENCE } as const;

describe.skipIf(!URL)('Postgres customer auth quarantine service startup', () => {
  let admin: Pool;
  let databaseUrl: string;

  beforeAll(async () => {
    admin = new Pool({ connectionString: URL, max: 1 });
    await admin.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    databaseUrl = databaseUrlForSchema(URL ?? '', SCHEMA);
  });

  afterAll(async () => {
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });

  it('starts ready and emits one aggregate-only warning for a legacy collision', async () => {
    const setup = new Pool({ connectionString: databaseUrl, max: 4 });
    const store = new PostgresArtifactStore(setup);
    await store.ensureSchema();
    await store.createOrg({ slug: ORG, displayName: 'Leaky Org' });
    await store.append(record('legacy-prod-owner-11111111', 'prod'));
    await setup.query(
      `INSERT INTO environments (org_slug, app_slug, name, is_production)
       VALUES ($1, $2, 'dev', false)`,
      [ORG, APP],
    );
    await setup.query('DROP TRIGGER deploy_records_customer_auth_audience ON deploy_records');
    await setup.query(
      `INSERT INTO deploy_records
       (deployment_id, org_slug, app_slug, environment, server_version, deployment_version,
        active, server_name, created_at, created_by_subject, created_by_email, access_mode,
        server_auth, caller_key_hash, manifest, connectors, hosted_assets, secrets,
        schema_version, archived_at, deployment_source, org_membership_sources)
       SELECT 'legacy-dev-owner-22222222', org_slug, app_slug, 'dev', server_version,
              deployment_version + 1, true, server_name, created_at, created_by_subject,
              created_by_email, access_mode, server_auth, caller_key_hash, manifest, connectors,
              hosted_assets, secrets, schema_version, archived_at, deployment_source,
              org_membership_sources
       FROM deploy_records
       WHERE deployment_id = 'legacy-prod-owner-11111111'`,
    );
    await setup.end();

    const warnings: Array<{ readonly event: string; readonly fields?: unknown }> = [];
    let running: RunningService | undefined;
    try {
      running = await serveService({
        host: '127.0.0.1',
        port: 0,
        databaseUrl,
        secretMasterKey: Buffer.alloc(32, 5).toString('base64'),
        logger: {
          ...noopLogger,
          warn: (event, fields) => warnings.push({ event, ...(fields ? { fields } : {}) }),
        },
      });

      expect((await fetch(`${running.url}/readyz`)).status).toBe(200);
      const quarantineWarnings = warnings.filter(
        ({ event }) => event === 'customer_auth.audience_quarantine',
      );
      expect(quarantineWarnings).toEqual([
        {
          event: 'customer_auth.audience_quarantine',
          fields: {
            invalidBoundaries: 0,
            conflictingBindings: 1,
            conflictingBoundaries: 2,
          },
        },
      ]);
      const serialized = JSON.stringify(quarantineWarnings);
      for (const sensitive of [ORG, APP, 'prod', 'dev', ISSUER, AUDIENCE]) {
        expect(serialized).not.toContain(sensitive);
      }
    } finally {
      await running?.close();
    }
  });
});

function databaseUrlForSchema(databaseUrl: string, schema: string): string {
  const parsed = new globalThis.URL(databaseUrl);
  parsed.searchParams.set('options', `-c search_path=${schema}`);
  return parsed.toString();
}

function record(deploymentId: string, environment: string): DeployRecord {
  return {
    schemaVersion: 1,
    deploymentId,
    orgSlug: ORG,
    appSlug: APP,
    environment,
    serverVersion: '1',
    deploymentVersion: 1,
    active: true,
    serverName: 'support',
    createdAt: '2026-07-30T00:00:00.000Z',
    accessMode: 'customers',
    serverAuth: AUTH,
    manifest: JSON.stringify({
      manifestVersion: '2',
      server: {
        name: 'support',
        title: 'Support',
        version: '1.0.0',
        auth: AUTH,
      },
      tools: [],
    }),
    secrets: { enc: 'none', values: {} },
  };
}
