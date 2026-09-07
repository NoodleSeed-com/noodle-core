import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { activeDeveloperGrant } from '../src/oauth/developer-grant.js';
import { PostgresDeveloperGrantStore } from '../src/oauth/developer-grant-store-postgres.js';

const URL = process.env.DATABASE_URL_TEST;
const NOW = '2026-07-17T12:00:00.000Z';
const SCHEMA = `developer_grants_${process.pid}`;

function input() {
  return {
    clientId: 'client-1',
    subject: 'developer@example.com',
    resource: 'https://cloud.noodleseed.com/developer/cli',
    capabilities: ['deployments:write', 'cloud:read', 'cloud:read'] as const,
  };
}

describe.skipIf(!URL)('PostgresDeveloperGrantStore', () => {
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: URL, max: 1 });
    await admin.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    pool = new Pool({ connectionString: URL, max: 6, options: `-c search_path=${SCHEMA}` });
    const store = new PostgresDeveloperGrantStore(pool);
    await store.initialize();
    await store.initialize();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE developer_access_grants');
  });

  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  });

  it('persists a normalized live-user grant through a JSONB round trip', async () => {
    const store = new PostgresDeveloperGrantStore(pool, {
      now: () => NOW,
      id: () => 'grant-jsonb',
    });

    const created = await store.getOrCreateActive(input());
    expect(created).toMatchObject({
      version: 2,
      id: 'grant-jsonb',
      resource: input().resource,
      accessModel: 'live_user',
      capabilities: ['cloud:read', 'deployments:write'],
    });
    await expect(store.get('grant-jsonb')).resolves.toEqual(created);
  });

  it('retains exactly one timestamp across concurrent revocation', async () => {
    const store = new PostgresDeveloperGrantStore(pool, {
      now: () => NOW,
      id: () => 'grant-revoke',
    });
    await store.getOrCreateActive(input());

    const results = await Promise.all([
      store.revoke('grant-revoke', '2026-07-17T13:00:00.000Z'),
      store.revoke('grant-revoke', '2026-07-17T14:00:00.000Z'),
    ]);

    expect(new Set(results.map((result) => result?.revokedAt)).size).toBe(1);
    expect(results[0]?.updatedAt).toBe(results[0]?.revokedAt);
    expect(results[1]?.updatedAt).toBe(results[1]?.revokedAt);
  });

  it('keeps expired grants readable for audit while marking them inactive', async () => {
    const store = new PostgresDeveloperGrantStore(pool, {
      now: () => NOW,
      id: () => 'grant-expired',
    });
    await store.getOrCreateActive({ ...input(), expiresAt: '2026-07-17T13:00:00.000Z' });

    const grant = await store.get('grant-expired');
    expect(grant).toBeDefined();
    expect(
      grant === undefined
        ? true
        : activeDeveloperGrant(grant, {
            subject: 'developer@example.com',
            clientId: 'client-1',
            resource: input().resource,
            at: '2026-07-17T13:00:00.000Z',
          }),
    ).toBe(false);
  });

  it('replaces an expired tuple while retaining the expired grant for audit', async () => {
    const first = new PostgresDeveloperGrantStore(pool, {
      now: () => NOW,
      id: () => 'grant-expired-first',
    });
    await first.getOrCreateActive({ ...input(), expiresAt: '2026-07-17T13:00:00.000Z' });

    const replacement = new PostgresDeveloperGrantStore(pool, {
      now: () => '2026-07-17T14:00:00.000Z',
      id: () => 'grant-expired-replacement',
    });
    await expect(replacement.getOrCreateActive(input())).resolves.toMatchObject({
      id: 'grant-expired-replacement',
    });
    await expect(first.get('grant-expired-first')).resolves.toMatchObject({
      revokedAt: '2026-07-17T14:00:00.000Z',
    });
  });

  it('reads an existing grant after a store restart', async () => {
    const first = new PostgresDeveloperGrantStore(pool, {
      now: () => NOW,
      id: () => 'grant-restart',
    });
    await first.getOrCreateActive(input());

    const restarted = new PostgresDeveloperGrantStore(pool);
    await restarted.initialize();
    await expect(restarted.get('grant-restart')).resolves.toMatchObject({
      id: 'grant-restart',
      resource: input().resource,
      accessModel: 'live_user',
    });
  });

  it('reuses the active tuple without inserting a duplicate generated ID', async () => {
    const store = new PostgresDeveloperGrantStore(pool, {
      now: () => NOW,
      id: () => 'same-id',
    });
    const first = await store.getOrCreateActive(input());

    await expect(store.getOrCreateActive(input())).resolves.toEqual(first);
  });

  it('revokes legacy v1 grants during initialization and never loads them as active v2 grants', async () => {
    await pool.query(
      `INSERT INTO developer_access_grants
         (id, client_id, subject, org_slug, environments, capabilities,
          created_at, updated_at, expires_at, revoked_at)
       VALUES ('legacy-v1', 'legacy-client', 'legacy-subject', 'acme', '["dev"]'::jsonb,
               '["cloud:read"]'::jsonb, $1, $1, NULL, NULL)`,
      [NOW],
    );

    const restarted = new PostgresDeveloperGrantStore(pool);
    await restarted.initialize();

    await expect(restarted.get('legacy-v1')).resolves.toBeUndefined();
    const result = await pool.query(
      'SELECT grant_version, resource, access_model, revoked_at FROM developer_access_grants WHERE id = $1',
      ['legacy-v1'],
    );
    expect(result.rows[0]).toMatchObject({
      grant_version: 1,
      resource: null,
      access_model: null,
      revoked_at: expect.any(Date),
    });
  });
});
