import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { type DeployRecord, PostgresArtifactStore } from '../src/index.js';

const DEPLOYMENT_SOURCE_PARAM_INDEX = 20;

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
    return Promise.resolve({ rows: [], rowCount: 0 });
  }
}

function rowFromInsertParams(p: unknown[]): Record<string, unknown> {
  const json = (value: unknown) => (typeof value === 'string' ? JSON.parse(value) : null);
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
    hosted_assets: json(p[16]),
    secrets: json(p[17]),
    schema_version: p[18],
    archived_at: p[19],
    deployment_source: p[DEPLOYMENT_SOURCE_PARAM_INDEX],
  };
}

function record(deploymentSource?: DeployRecord['deploymentSource']): DeployRecord {
  return {
    schemaVersion: 1,
    deploymentId: 'dep-source-abc',
    orgSlug: 'acme',
    appSlug: 'site',
    environment: 'prod',
    deploymentVersion: 1718496000000,
    active: true,
    serverName: 'hello',
    createdAt: '2026-06-16T00:00:00.000Z',
    manifest: 'manifestVersion: "1"',
    secrets: { enc: 'none', values: {} },
    ...(deploymentSource !== undefined ? { deploymentSource } : {}),
  };
}

function newStore() {
  const pool = new FakePool();
  return { pool, store: new PostgresArtifactStore(pool as unknown as Pool) };
}

describe('PostgresArtifactStore deployment source persistence', () => {
  it('round-trips a typed deployment source through append and get', async () => {
    const { pool, store } = newStore();
    await store.append(record('cli'));

    expect(pool.lastInsertParams?.[DEPLOYMENT_SOURCE_PARAM_INDEX]).toBe('cli');
    expect((await store.get('dep-source-abc'))?.deploymentSource).toBe('cli');
  });

  it('keeps legacy records without a deployment source absent', async () => {
    const { pool, store } = newStore();
    await store.append(record());

    expect(pool.lastInsertParams?.[DEPLOYMENT_SOURCE_PARAM_INDEX]).toBeNull();
    expect((await store.get('dep-source-abc'))?.deploymentSource).toBeUndefined();
  });
});
