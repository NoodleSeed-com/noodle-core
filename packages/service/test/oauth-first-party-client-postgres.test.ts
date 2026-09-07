import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { reconcileFirstPartyOAuthClient } from '../src/oauth/first-party-client.js';
import { PostgresOAuthStore } from '../src/oauth/store-postgres.js';

const URL = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
const SCHEMA = `oauth_first_party_client_${process.pid}`;
const INPUT = {
  owner: 'console',
  clientId: 'noodle-console-v1',
  redirectUri: 'https://console.noodleseed.dev/api/console/auth/callback',
  resource: 'https://cloud.noodleseed.dev',
} as const;

describe.skipIf(!URL)('Postgres first-party OAuth client reservation', () => {
  let admin: Pool;
  let pool: Pool;
  let store: PostgresOAuthStore;

  beforeAll(async () => {
    admin = new Pool({ connectionString: URL, max: 1 });
    await admin.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    pool = new Pool({ connectionString: URL, max: 4, options: `-c search_path=${SCHEMA}` });
    store = new PostgresOAuthStore(pool);
    await store.ensureSchema();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE oauth_clients');
  });

  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  });

  it('atomically refuses to take over an existing dynamic registration', async () => {
    const dynamic = dcrClient();
    await store.putClient(dynamic);

    await expect(reconcileFirstPartyOAuthClient(store, INPUT)).rejects.toThrow(
      /already registered/i,
    );
    await expect(store.getClient(INPUT.clientId)).resolves.toEqual(dynamic);
  });

  it('atomically prevents DCR from replacing the reserved Console registration', async () => {
    await reconcileFirstPartyOAuthClient(store, INPUT);

    await expect(store.putClient(dcrClient())).rejects.toThrow(/reserved/i);
    await expect(store.getClient(INPUT.clientId)).resolves.toMatchObject({
      client_id: INPUT.clientId,
      redirect_uris: [INPUT.redirectUri],
    });
  });

  it('preserves old Portal purpose across client rotation and distinguishes DCR from missing rows', async () => {
    for (const clientId of ['old-portal', 'new-portal'])
      await reconcileFirstPartyOAuthClient(store, {
        ...INPUT,
        owner: 'portal',
        clientId,
        redirectUri: 'https://portal.example/api/portal/auth/callback',
      });
    await store.putClient({
      ...dcrClient(),
      client_name: 'Noodle Business Portal',
      ...{ first_party_owner: 'portal' },
    });
    const restarted = new PostgresOAuthStore(pool);
    expect(await restarted.getClientPurpose('old-portal')).toBe('portal');
    expect(await restarted.getClientPurpose('new-portal')).toBe('portal');
    expect(await restarted.getClientPurpose(INPUT.clientId)).toBe('dynamic');
    await pool.query('DELETE FROM oauth_clients WHERE client_id=$1', ['old-portal']);
    expect(await restarted.getClientPurpose('old-portal')).toBeUndefined();
  });

  it('has exactly one winner when Console reservation races DCR', async () => {
    const outcomes = await Promise.allSettled([
      reconcileFirstPartyOAuthClient(store, INPUT),
      store.putClient(dcrClient()),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    await expect(store.getClient(INPUT.clientId)).resolves.toBeDefined();
  });
});

function dcrClient(): OAuthClientInformationFull {
  return {
    client_id: INPUT.clientId,
    redirect_uris: ['https://mcp-client.example/callback'],
    token_endpoint_auth_method: 'none',
  } as OAuthClientInformationFull;
}
