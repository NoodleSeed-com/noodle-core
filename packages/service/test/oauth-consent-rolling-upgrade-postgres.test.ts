import type { Response } from 'express';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgresOAuthStore } from '../src/oauth/store-postgres.js';
import { renderUpstreamConsent } from '../src/oauth/upstream-consent.js';

const URL = process.env.DATABASE_URL_TEST;
const RESOURCE = 'https://borg.test/o/acme/continuity/mcp';
const SCHEMA = `oauth_consent_rolling_upgrade_${process.pid}`;

describe.skipIf(!URL)('Postgres OAuth remembered-consent rolling upgrade', () => {
  let admin: Pool;
  let pool: Pool;
  let store: PostgresOAuthStore;

  beforeAll(async () => {
    admin = new Pool({ connectionString: URL, max: 1 });
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new Pool({
      connectionString: URL,
      max: 2,
      options: `-c search_path=${SCHEMA},public`,
    });
    await pool.query(`
      CREATE TABLE oauth_consent_grants (
        client_id     text NOT NULL,
        owner_subject text NOT NULL,
        resource      text NOT NULL,
        granted_at    timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (client_id, owner_subject, resource)
      )
    `);
    await pool.query(
      `INSERT INTO oauth_consent_grants (client_id, owner_subject, resource)
       VALUES ('legacy-dcr-client', 'legacy-platform-subject', $1)`,
      [RESOURCE],
    );
    store = new PostgresOAuthStore(pool);
    await store.ensureSchema();
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });

  it('classifies pre-schema and old-writer legacy tuples as platform-only grants', async () => {
    await expect(
      store.hasConsentGrant('legacy-dcr-client', 'legacy-platform-subject', RESOURCE, 'platform'),
    ).resolves.toBe(true);
    await expect(
      store.hasConsentGrant('legacy-dcr-client', 'legacy-platform-subject', RESOURCE, 'customer'),
    ).resolves.toBe(false);

    await pool.query(
      `INSERT INTO oauth_consent_grants (client_id, owner_subject, resource)
       VALUES ('old-writer-client', 'old-writer-subject', $1)`,
      [RESOURCE],
    );

    await expect(
      store.hasConsentGrant('old-writer-client', 'old-writer-subject', RESOURCE, 'platform'),
    ).resolves.toBe(true);
    await expect(
      store.hasConsentGrant('old-writer-client', 'old-writer-subject', RESOURCE, 'customer'),
    ).resolves.toBe(false);
  });

  it('does not manufacture a platform grant for a typed customer-only tuple on schema rerun', async () => {
    await store.createConsentGrant({
      clientId: 'customer-only-client',
      ownerSubject: 'same-text-subject',
      resource: RESOURCE,
      identityKind: 'customer',
    });

    await store.ensureSchema();
    await store.ensureSchema();

    await expect(
      store.hasConsentGrant('customer-only-client', 'same-text-subject', RESOURCE, 'customer'),
    ).resolves.toBe(true);
    await expect(
      store.hasConsentGrant('customer-only-client', 'same-text-subject', RESOURCE, 'platform'),
    ).resolves.toBe(false);
    await expect(
      pool.query<{
        readonly legacy_kind: string;
        readonly platform_provenance_count: number;
      }>(
        `SELECT legacy.identity_kind AS legacy_kind,
                count(provenance.*) FILTER (
                  WHERE provenance.identity_kind = 'platform'
                )::int AS platform_provenance_count
           FROM oauth_consent_grants legacy
           LEFT JOIN oauth_consent_grant_provenance provenance
             USING (client_id, owner_subject, resource)
          WHERE legacy.client_id = 'customer-only-client'
          GROUP BY legacy.identity_kind`,
      ),
    ).resolves.toMatchObject({
      rows: [{ legacy_kind: 'customer', platform_provenance_count: 0 }],
    });
  });

  it('keeps platform and customer typed grants independently on the same tuple', async () => {
    await store.createConsentGrant({
      clientId: 'coexisting-client',
      ownerSubject: 'coexisting-subject',
      resource: RESOURCE,
      identityKind: 'customer',
    });
    await store.createConsentGrant({
      clientId: 'coexisting-client',
      ownerSubject: 'coexisting-subject',
      resource: RESOURCE,
      identityKind: 'platform',
    });

    await expect(
      store.hasConsentGrant('coexisting-client', 'coexisting-subject', RESOURCE, 'customer'),
    ).resolves.toBe(true);
    await expect(
      store.hasConsentGrant('coexisting-client', 'coexisting-subject', RESOURCE, 'platform'),
    ).resolves.toBe(true);
  });

  it('lets an existing DCR authorization reuse pre-schema platform consent without an interstitial', async () => {
    await store.putClient({
      client_id: 'legacy-dcr-client',
      client_name: 'Existing DCR client',
      redirect_uris: ['https://client.example.test/callback'],
      token_endpoint_auth_method: 'none',
    });
    const issueAuthorizationCode = vi.fn().mockResolvedValue(undefined);
    const signConsent = vi.fn(() => Promise.reject(new Error('consent should not be rendered')));

    await renderUpstreamConsent({
      pending: {
        state: 'state-hash',
        clientId: 'legacy-dcr-client',
        redirectUri: 'https://client.example.test/callback',
        codeChallenge: 'pkce-challenge',
        upstreamProvider: 'workos',
        resource: RESOURCE,
        expiresAt: Math.floor(Date.now() / 1_000) + 600,
      },
      identity: { email: 'platform-user@example.test' },
      ownerSubject: 'legacy-platform-subject',
      issuer: 'https://as.noodle.test',
      store,
      tokenIssuer: { issueAuthorizationCode } as never,
      signConsent,
      res: {} as Response,
    });

    expect(issueAuthorizationCode).toHaveBeenCalledOnce();
    expect(signConsent).not.toHaveBeenCalled();
  });
});
