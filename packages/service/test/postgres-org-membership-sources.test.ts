import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { type DeployRecord, PostgresArtifactStore } from '../src/index.js';

/**
 * Bind ordering for `org_membership_sources` (ADR 0183). `pg` binds are `unknown[]`, so a bind inserted
 * anywhere but last silently shifts `$12..$21` and writes the manifest into `server_auth`. TypeScript
 * cannot see it; only positional assertions can. The sibling deployment-source suite pins index 20, and
 * this one pins the bind at 21 plus the total length, including the later lock metadata and app-package
 * snapshot and owner binds, so a removed or shifted bind is caught too.
 */

const DEPLOYMENT_SOURCE_PARAM_INDEX = 20;
const ORG_MEMBERSHIP_SOURCES_PARAM_INDEX = 21;
const OWNER_SUBJECT_PARAM_INDEX = 26;
const EXPECTED_PARAM_COUNT = 27;

class FakePool {
  readonly rows = new Map<string, Record<string, unknown>>();
  lastInsertParams: unknown[] | undefined;

  connect(): Promise<{ query: FakePool['query']; release: () => void }> {
    return Promise.resolve({ query: this.query.bind(this), release: () => undefined });
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
    org_membership_sources: p[ORG_MEMBERSHIP_SOURCES_PARAM_INDEX],
    owner_subject: p[OWNER_SUBJECT_PARAM_INDEX],
  };
}

function record(sources?: DeployRecord['orgMembershipSources']): DeployRecord {
  return {
    schemaVersion: 1,
    deploymentId: 'dep-sources-abc',
    orgSlug: 'acme',
    appSlug: 'vault',
    environment: 'prod',
    deploymentVersion: 1718496000000,
    active: true,
    serverName: 'hello',
    createdAt: '2026-06-16T00:00:00.000Z',
    accessMode: 'org-members',
    ownerSubject: 'oauth-owner',
    deploymentSource: 'cli',
    manifest: 'manifestVersion: "1"',
    secrets: { enc: 'none', values: {} },
    ...(sources !== undefined ? { orgMembershipSources: sources } : {}),
  };
}

function newStore() {
  const pool = new FakePool();
  return { pool, store: new PostgresArtifactStore(pool as unknown as Pool) };
}

describe('PostgresArtifactStore org membership source persistence', () => {
  it('keeps membership-source and prior bind positions stable as fields are appended', async () => {
    const { pool, store } = newStore();
    await store.append(record(['explicit']));

    expect(pool.lastInsertParams).toHaveLength(EXPECTED_PARAM_COUNT);
    expect(pool.lastInsertParams?.[ORG_MEMBERSHIP_SOURCES_PARAM_INDEX]).toEqual(['explicit']);
    expect(pool.lastInsertParams?.[OWNER_SUBJECT_PARAM_INDEX]).toBe('oauth-owner');
    // The bind that used to be last must not have moved.
    expect(pool.lastInsertParams?.[DEPLOYMENT_SOURCE_PARAM_INDEX]).toBe('cli');
  });

  it('round-trips a narrowed membership source list through append and get', async () => {
    const { store } = newStore();
    await store.append(record(['explicit']));

    expect((await store.get('dep-sources-abc'))?.orgMembershipSources).toEqual(['explicit']);
  });

  it('binds a text[] rather than a JSON string', async () => {
    const { pool, store } = newStore();
    await store.append(record(['explicit', 'domain']));

    expect(Array.isArray(pool.lastInsertParams?.[ORG_MEMBERSHIP_SOURCES_PARAM_INDEX])).toBe(true);
  });

  it('keeps a legacy record without a membership source list absent, not empty', async () => {
    const { pool, store } = newStore();
    await store.append(record());

    // `[]` here would turn an ordinary deployment into deny-all on the next idempotent re-append.
    expect(pool.lastInsertParams?.[ORG_MEMBERSHIP_SOURCES_PARAM_INDEX]).toBeNull();
    expect((await store.get('dep-sources-abc'))?.orgMembershipSources).toBeUndefined();
  });

  it('fails closed when a persisted list names only sources this build does not know', async () => {
    const { pool, store } = newStore();
    await store.append(record(['explicit']));
    const row = pool.rows.get('dep-sources-abc') as Record<string, unknown>;
    row.org_membership_sources = ['group'];

    // Deny-all, never admit-all: rolling back past a future source must not re-open the deployment.
    expect((await store.get('dep-sources-abc'))?.orgMembershipSources).toEqual([]);
  });
});
