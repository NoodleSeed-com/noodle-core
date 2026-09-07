import type { HostedPackagedAsset } from '@noodle-borg/compiler';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { type DeployRecord, PostgresArtifactStore } from '../src/index.js';

/**
 * Closes the P1.5 B2 recovery gap: deploy_records must persist `hostedAssets` (the recovery source
 * of truth for compiled asset URLs) through the Postgres store, not just the in-memory one. This
 * drives the real append/INSERT + get/rowToRecord paths offline via a fake Pool that round-trips
 * jsonb params the way `pg` does (full Postgres coverage runs under `pnpm e2e:postgres`).
 */

/** Index of the hosted_assets jsonb bind in the deploy_records INSERT param array. */
const HOSTED_ASSETS_PARAM_INDEX = 16;

class FakePool {
  readonly rows = new Map<string, Record<string, unknown>>();
  lastInsertParams: unknown[] | undefined;

  connect(): Promise<{ query: FakePool['query']; release: () => void }> {
    return Promise.resolve({
      query: this.query.bind(this),
      release: () => undefined,
    });
  }

  query(text: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
    if (/SELECT slug FROM orgs/.test(text)) {
      return Promise.resolve({ rows: [{ slug: 'acme' }], rowCount: 1 });
    }
    if (/INSERT INTO deploy_records/.test(text) && params) {
      this.lastInsertParams = params;
      this.rows.set(String(params[0]), rowFromInsertParams(params));
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    if (/SELECT \* FROM deploy_records WHERE deployment_id/.test(text) && params) {
      const row = this.rows.get(String(params[0]));
      return Promise.resolve({ rows: row ? [row] : [], rowCount: row ? 1 : 0 });
    }
    // BEGIN / COMMIT / ROLLBACK / org-app-env upserts / DDL — all no-ops for this test.
    return Promise.resolve({ rows: [], rowCount: 0 });
  }
}

/** Reconstruct a deploy_records row from INSERT params, parsing jsonb binds the way `pg` returns them. */
function rowFromInsertParams(p: unknown[]): Record<string, unknown> {
  const json = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : null);
  return {
    deployment_id: p[0],
    org_slug: p[1],
    app_slug: p[2],
    environment: p[3],
    server_version: p[4],
    deployment_version: String(p[5]),
    active: p[6],
    server_name: p[7],
    created_at: new Date(p[8] as string),
    created_by_subject: p[9],
    created_by_email: p[10],
    access_mode: p[11],
    server_auth: json(p[12]),
    caller_key_hash: p[13],
    manifest: p[14],
    connectors: p[15],
    hosted_assets: json(p[HOSTED_ASSETS_PARAM_INDEX]),
    secrets: json(p[17]),
    schema_version: p[18],
  };
}

const ASSET: HostedPackagedAsset = {
  logicalId: 'logo',
  sourcePath: 'assets/logo.png',
  contentHash: `sha256:${'a'.repeat(64)}`,
  mimeType: 'image/png',
  byteLength: 1024,
  width: 64,
  height: 64,
  objectKey: 'blinded/scope/hash/logo',
  publicUrl: 'https://assets.noodleseed.com/opaquetoken',
};

function record(overrides: Partial<DeployRecord> = {}): DeployRecord {
  return {
    schemaVersion: 1,
    deploymentId: 'dep-abc',
    orgSlug: 'acme',
    appSlug: 'site',
    environment: 'prod',
    deploymentVersion: 1718496000000,
    active: true,
    serverName: 'hello',
    createdAt: '2026-06-16T00:00:00.000Z',
    manifest: 'manifestVersion: "1"',
    secrets: { enc: 'none', values: {} },
    ...overrides,
  };
}

function newStore() {
  const pool = new FakePool();
  return { pool, store: new PostgresArtifactStore(pool as unknown as Pool) };
}

describe('PostgresArtifactStore — hostedAssets persistence (P1.5 B2)', () => {
  it('round-trips hostedAssets through append → get', async () => {
    const { store } = newStore();
    await store.append(record({ hostedAssets: [ASSET] }));
    const loaded = await store.get('dep-abc');
    expect(loaded?.hostedAssets).toEqual([ASSET]);
  });

  it('binds the serialized hosted assets at the hosted_assets jsonb position', async () => {
    const { pool, store } = newStore();
    await store.append(record({ hostedAssets: [ASSET] }));
    expect(pool.lastInsertParams?.[HOSTED_ASSETS_PARAM_INDEX]).toBe(JSON.stringify([ASSET]));
  });

  it('persists null (no hostedAssets key) when a deploy has no packaged assets', async () => {
    const { pool, store } = newStore();
    await store.append(record());
    expect(pool.lastInsertParams?.[HOSTED_ASSETS_PARAM_INDEX]).toBeNull();
    const loaded = await store.get('dep-abc');
    expect(loaded?.hostedAssets).toBeUndefined();
  });
});
