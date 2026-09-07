import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { digestClientSecret } from '../src/oauth/service-principal-credentials.js';
import { PostgresServicePrincipalStore } from '../src/oauth/service-principal-store-postgres.js';

const URL = process.env.DATABASE_URL_TEST;
const SCHEMA = `oauth_service_principals_${process.pid}`;
const NOW = '2026-08-03T12:00:00.000Z';

describe.skipIf(!URL)('Postgres service-principal store', () => {
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: URL, max: 1 });
    await admin.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    pool = new Pool({ connectionString: URL, max: 8, options: `-c search_path=${SCHEMA}` });
    await pool.query(`
      CREATE TABLE oauth_clients (client_id text PRIMARY KEY, payload jsonb NOT NULL);
      CREATE TABLE oauth_refresh_tokens (token text PRIMARY KEY, payload jsonb NOT NULL);
      CREATE TABLE deploy_records (deployment_id text PRIMARY KEY, payload jsonb NOT NULL);
      INSERT INTO oauth_clients VALUES ('legacy-client', '{"kind":"dcr"}');
      INSERT INTO oauth_refresh_tokens VALUES ('legacy-refresh', '{"active":true}');
      INSERT INTO deploy_records VALUES ('legacy-deploy', '{"server":"todoist"}');
    `);
    const store = new PostgresServicePrincipalStore(pool);
    await store.ensureSchema();
    await store.ensureSchema();
  });

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE oauth_client_assertion_nonces,
        oauth_service_principal_credentials,
        oauth_service_principal_grants,
        oauth_service_principals CASCADE
    `);
  });

  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  });

  function store(): PostgresServicePrincipalStore {
    return new PostgresServicePrincipalStore(pool, { now: () => new Date(NOW) });
  }

  async function principal() {
    return store().createPrincipal({ org: 'acme', name: 'nightly sync', actorSubject: 'usr_1' });
  }

  async function secret(principalId: string, label: string) {
    return store().createCredential({
      principalId,
      org: 'acme',
      actorSubject: 'usr_1',
      kind: 'client_secret',
      label,
      secretDigest: digestClientSecret(label),
    });
  }

  it('adds four service-principal tables and indexes without changing legacy OAuth or deploy rows', async () => {
    const { rows: tables } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_name LIKE 'oauth_%'
       ORDER BY table_name`,
      [SCHEMA],
    );
    const { rows: indexes } = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1 ORDER BY indexname`,
      [SCHEMA],
    );

    expect(tables.map((row) => row.table_name)).toEqual(
      expect.arrayContaining([
        'oauth_service_principals',
        'oauth_service_principal_grants',
        'oauth_service_principal_credentials',
        'oauth_client_assertion_nonces',
      ]),
    );
    expect(indexes.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        'oauth_service_principal_active_grant_target_uq',
        'oauth_service_principal_active_credentials_idx',
        'oauth_client_assertion_nonces_expiry_idx',
      ]),
    );
    await expect(
      pool.query('SELECT payload FROM oauth_clients WHERE client_id = $1', ['legacy-client']),
    ).resolves.toMatchObject({ rows: [{ payload: { kind: 'dcr' } }] });
    await expect(
      pool.query('SELECT payload FROM deploy_records WHERE deployment_id = $1', ['legacy-deploy']),
    ).resolves.toMatchObject({ rows: [{ payload: { server: 'todoist' } }] });
  });

  it('enforces organization ownership in both the store and database foreign key', async () => {
    const created = await principal();
    await expect(
      store().createGrant({
        principalId: created.principalId,
        org: 'other',
        app: 'todoist',
        environment: 'prod',
        scopes: [],
        actorSubject: 'usr_2',
      }),
    ).rejects.toThrow(/organization/i);
    await expect(
      pool.query(
        `INSERT INTO oauth_service_principal_grants
          (grant_id, principal_id, org_slug, app_slug, environment, scopes, status,
           created_by_subject, created_at, updated_at)
         VALUES ('spg_11111111-1111-4111-8111-111111111111', $1, 'other', 'todoist', 'prod',
           ARRAY[]::text[], 'active', 'usr_2', $2, $2)`,
        [created.principalId, NOW],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('enforces one active grant per principal target with replacement after revocation', async () => {
    const created = await principal();
    const input = {
      principalId: created.principalId,
      org: 'acme',
      app: 'todoist',
      environment: 'prod',
      scopes: ['todos.read'],
      actorSubject: 'usr_1',
    };
    const original = await store().createGrant(input);

    await expect(store().createGrant(input)).rejects.toThrow(/active grant/i);
    await store().revokeGrant({
      principalId: created.principalId,
      grantId: original.grantId,
      org: 'acme',
      actorSubject: 'usr_1',
    });
    await expect(store().createGrant(input)).resolves.toMatchObject({ status: 'active' });
  });

  it('serializes the five-active-credential cap across store instances', async () => {
    const created = await principal();
    for (let index = 0; index < 4; index += 1) await secret(created.principalId, `secret-${index}`);

    const results = await Promise.allSettled([
      secret(created.principalId, 'secret-left'),
      secret(created.principalId, 'secret-right'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const active = await store().loadActiveClient(created.principalId, Date.parse(NOW));
    expect(active?.credentials).toHaveLength(5);
  });

  it('atomically consumes one assertion jti across concurrent store instances', async () => {
    const created = await principal();
    const credential = await secret(created.principalId, 'assertion-key');
    const input = {
      credentialId: credential.credentialId,
      jti: 'same-jti',
      expiresAt: Date.parse('2026-08-03T12:05:00.000Z'),
      now: Date.parse(NOW),
    };

    const results = await Promise.all([
      store().consumeAssertionJti(input),
      store().consumeAssertionJti(input),
    ]);
    expect(results.sort()).toEqual([false, true]);
  });

  it('keeps revoked credentials readable but removes them from active client loads', async () => {
    const created = await principal();
    const credential = await secret(created.principalId, 'old-secret');
    await store().revokeCredential({
      principalId: created.principalId,
      credentialId: credential.credentialId,
      org: 'acme',
      actorSubject: 'usr_1',
    });

    await expect(
      store().getPrincipal({ principalId: created.principalId, org: 'acme' }),
    ).resolves.toMatchObject({
      credentials: [
        expect.objectContaining({ credentialId: credential.credentialId, status: 'revoked' }),
      ],
    });
    await expect(
      store().loadActiveClient(created.principalId, Date.parse(NOW)),
    ).resolves.toMatchObject({
      credentials: [],
    });
  });

  it('fails closed when durable reads or replay writes are unavailable', async () => {
    const created = await principal();
    const credential = await secret(created.principalId, 'durable-secret');
    await pool.query('ALTER TABLE oauth_service_principals RENAME TO unavailable_principals');
    try {
      await expect(
        store().loadActiveClient(created.principalId, Date.parse(NOW)),
      ).rejects.toThrow();
    } finally {
      await pool.query('ALTER TABLE unavailable_principals RENAME TO oauth_service_principals');
    }

    await pool.query('ALTER TABLE oauth_client_assertion_nonces RENAME TO unavailable_nonces');
    try {
      await expect(
        store().consumeAssertionJti({
          credentialId: credential.credentialId,
          jti: 'fail-closed',
          expiresAt: Date.parse('2026-08-03T12:05:00.000Z'),
          now: Date.parse(NOW),
        }),
      ).rejects.toThrow();
    } finally {
      await pool.query('ALTER TABLE unavailable_nonces RENAME TO oauth_client_assertion_nonces');
    }
  });
});
