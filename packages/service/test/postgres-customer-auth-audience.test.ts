import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { findActiveCustomerAuthAudienceConflictRow } from '../src/store/postgres-customer-auth-audience.js';

const TENANT = { org: 'acme', app: 'support', env: 'prod' } as const;
const AUTH = { issuer: 'https://idp.example', audience: 'acme-support' } as const;

class FakePool {
  constructor(readonly rows: readonly Record<string, unknown>[]) {}

  lastQuery: { text: string; params: readonly unknown[] } | undefined;

  query(text: string, params: readonly unknown[]): Promise<{ rows: readonly unknown[] }> {
    this.lastQuery = { text, params };
    return Promise.resolve({ rows: this.rows });
  }
}

describe('Postgres customer OIDC audience isolation lookup', () => {
  it('returns another app/environment whose direct binding overlaps', async () => {
    const pool = new FakePool([
      {
        org_slug: 'acme',
        app_slug: 'support',
        environment: 'dev',
        server_auth: AUTH,
      },
    ]);

    await expect(
      findActiveCustomerAuthAudienceConflictRow(pool as unknown as Pool, TENANT, AUTH),
    ).resolves.toEqual({ org: 'acme', app: 'support', env: 'dev' });
    expect(pool.lastQuery?.params).toEqual(['acme', 'support', 'prod']);
    expect(pool.lastQuery?.text).toContain(
      'NOT (org_slug = $1 AND app_slug = $2 AND environment = $3)',
    );
  });

  it('skips malformed unrelated rows and still detects a later valid overlap', async () => {
    const pool = new FakePool([
      {
        org_slug: 'acme',
        app_slug: 'invalid',
        environment: 'dev',
        server_auth: { kind: 'federatedOidc', issuers: [] },
      },
      {
        org_slug: 'partner',
        app_slug: 'portal',
        environment: 'prod',
        server_auth: {
          kind: 'federatedOidc',
          issuers: [
            { issuer: 'https://other.example', audience: 'other' },
            { issuer: 'https://idp.example/', audience: 'acme-support' },
          ],
        },
      },
    ]);

    await expect(
      findActiveCustomerAuthAudienceConflictRow(pool as unknown as Pool, TENANT, AUTH),
    ).resolves.toEqual({ org: 'partner', app: 'portal', env: 'prod' });
  });

  it('does not deny a distinct candidate because another projection is malformed', async () => {
    const pool = new FakePool([
      {
        org_slug: 'acme',
        app_slug: 'invalid',
        environment: 'dev',
        server_auth: { kind: 'federatedOidc', issuers: [] },
      },
    ]);

    await expect(
      findActiveCustomerAuthAudienceConflictRow(pool as unknown as Pool, TENANT, AUTH),
    ).resolves.toBeUndefined();
  });

  it('returns no conflict for distinct issuer/audience pairs', async () => {
    const pool = new FakePool([
      {
        org_slug: 'acme',
        app_slug: 'support',
        environment: 'dev',
        server_auth: { issuer: 'https://idp.example', audience: 'acme-support-dev' },
      },
    ]);

    await expect(
      findActiveCustomerAuthAudienceConflictRow(pool as unknown as Pool, TENANT, AUTH),
    ).resolves.toBeUndefined();
  });
});
