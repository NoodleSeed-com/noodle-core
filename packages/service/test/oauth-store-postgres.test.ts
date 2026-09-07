import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { deviceRowToRecord } from '../src/oauth/device-store-postgres-types.js';
import { FRESH_AUTH_SCOPE } from '../src/oauth/fresh-auth.js';
import { PostgresOAuthStore } from '../src/oauth/store-postgres.js';
import { ensureOAuthStoreSchema } from '../src/oauth/store-postgres-schema.js';

const AUTH_TIME = 1_700_000_000;
const AUTH_TIME_DATE = new Date(AUTH_TIME * 1_000);
const EXPIRES_AT = 2_000_000_000;
const EXPIRES_AT_DATE = new Date(EXPIRES_AT * 1_000);

describe('Postgres OAuth verified identity persistence', () => {
  it('creates verified-claim columns and additively upgrades both existing tables', async () => {
    const statements: string[] = [];
    const pool = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        return { rows: [], rowCount: 0 };
      }),
    } as unknown as Pool;

    await ensureOAuthStoreSchema(pool);

    const sql = statements.join('\n');
    expect(sql).toMatch(/oauth_authorization_codes[\s\S]*auth_time\s+timestamptz/);
    expect(sql).toMatch(/oauth_refresh_tokens[\s\S]*auth_time\s+timestamptz/);
    expect(sql).toMatch(/oauth_authorization_codes[\s\S]*roles\s+jsonb/);
    expect(sql).toMatch(/oauth_refresh_tokens[\s\S]*roles\s+jsonb/);
    expect(sql).toMatch(/oauth_authorization_codes[\s\S]*upstream_expires_at\s+timestamptz/);
    expect(sql).toMatch(/oauth_refresh_tokens[\s\S]*upstream_expires_at\s+timestamptz/);
    expect(sql).toMatch(/oauth_authorization_codes[\s\S]*customer_issuer\s+text/);
    expect(sql).toMatch(/oauth_refresh_tokens[\s\S]*customer_issuer\s+text/);
    expect(sql).toMatch(/oauth_device_authorizations[\s\S]*customer_issuer\s+text/);
    expect(statements).toContain(
      'ALTER TABLE oauth_authorization_codes ADD COLUMN IF NOT EXISTS auth_time timestamptz',
    );
    expect(statements).toContain(
      'ALTER TABLE oauth_refresh_tokens ADD COLUMN IF NOT EXISTS auth_time timestamptz',
    );
    expect(statements).toContain(
      'ALTER TABLE oauth_authorization_codes ADD COLUMN IF NOT EXISTS roles jsonb',
    );
    expect(statements).toContain(
      'ALTER TABLE oauth_refresh_tokens ADD COLUMN IF NOT EXISTS roles jsonb',
    );
    expect(statements).toContain(
      'ALTER TABLE oauth_authorization_codes ADD COLUMN IF NOT EXISTS upstream_expires_at timestamptz',
    );
    expect(statements).toContain(
      'ALTER TABLE oauth_refresh_tokens ADD COLUMN IF NOT EXISTS upstream_expires_at timestamptz',
    );
    expect(statements).toContain(
      'ALTER TABLE oauth_authorization_codes ADD COLUMN IF NOT EXISTS customer_issuer text',
    );
    expect(statements).toContain(
      'ALTER TABLE oauth_refresh_tokens ADD COLUMN IF NOT EXISTS customer_issuer text',
    );
    expect(statements).toContain(
      'ALTER TABLE oauth_device_authorizations ADD COLUMN IF NOT EXISTS customer_issuer text',
    );
  });

  it('maps authentication metadata and fails closed for malformed stored roles', async () => {
    const writes: { readonly sql: string; readonly values: readonly unknown[] }[] = [];
    const pool = {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        if (sql.startsWith('INSERT')) {
          writes.push({ sql, values });
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('FROM oauth_authorization_codes')) {
          return {
            rows: [
              {
                code: 'code-hash',
                client_id: 'console-client',
                code_challenge: 'challenge',
                redirect_uri: 'https://console.test/callback',
                resource: 'https://cloud.test',
                owner_subject: 'principal-1',
                owner_email: null,
                owner_locale: null,
                owner_time_zone: null,
                scope: null,
                identity_kind: null,
                identity_provider: null,
                customer_issuer: 'https://login.microsoftonline.com/tenant-1/v2.0',
                developer_grant_id: null,
                auth_time: AUTH_TIME_DATE,
                roles: ['admin', '   '],
                upstream_expires_at: EXPIRES_AT_DATE,
                expires_at: EXPIRES_AT_DATE,
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes('FROM oauth_refresh_tokens')) {
          return {
            rows: [refreshRow()],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }),
    } as unknown as Pool;
    const store = new PostgresOAuthStore(pool);

    await store.createAuthorizationCode({
      code: 'code-hash',
      clientId: 'console-client',
      codeChallenge: 'challenge',
      redirectUri: 'https://console.test/callback',
      resource: 'https://cloud.test',
      ownerSubject: 'principal-1',
      authTime: AUTH_TIME,
      roles: ['admin', 'support'],
      upstreamExpiresAt: EXPIRES_AT,
      customerIssuer: 'https://login.microsoftonline.com/tenant-1/v2.0',
      expiresAt: EXPIRES_AT,
    });
    await expect(store.getAuthorizationCode('code-hash')).resolves.toMatchObject({
      authTime: AUTH_TIME,
      roles: [],
      customerIssuer: 'https://login.microsoftonline.com/tenant-1/v2.0',
    });

    await store.createRefreshToken({
      token: 'refresh-hash',
      clientId: 'console-client',
      ownerSubject: 'principal-1',
      resource: 'https://cloud.test',
      authTime: AUTH_TIME,
      roles: ['admin', 'support'],
      upstreamExpiresAt: EXPIRES_AT,
      customerIssuer: 'https://login.microsoftonline.com/tenant-1/v2.0',
      expiresAt: EXPIRES_AT,
      familyId: 'family-1',
    });
    await expect(store.getRefreshToken('refresh-hash')).resolves.toMatchObject({
      authTime: AUTH_TIME,
      roles: ['admin', 'support'],
      upstreamExpiresAt: EXPIRES_AT,
      customerIssuer: 'https://login.microsoftonline.com/tenant-1/v2.0',
    });

    expect(writes).toHaveLength(2);
    expect(writes[0]?.sql).toContain('auth_time');
    expect(writes[0]?.sql).toContain('upstream_expires_at');
    expect(writes[0]?.values).toContain(AUTH_TIME);
    expect(writes[0]?.values).toContain('https://login.microsoftonline.com/tenant-1/v2.0');
    expect(writes[1]?.sql).toContain('auth_time');
    expect(writes[1]?.sql).toContain('upstream_expires_at');
    expect(writes[1]?.values).toContain(AUTH_TIME);
    expect(writes[1]?.values).toContain('https://login.microsoftonline.com/tenant-1/v2.0');
  });

  it('sanitizes a migrated scope while preserving authentication time in a rotated successor', async () => {
    const dirtyRow = {
      ...refreshRow(),
      scope: `openid email ${FRESH_AUTH_SCOPE}`,
      roles: ['admin', 'support'],
      upstream_expires_at: EXPIRES_AT_DATE,
    };
    let retainedScopeWrite:
      | { readonly sql: string; readonly values: readonly unknown[] }
      | undefined;
    let successorWrite: { readonly sql: string; readonly values: readonly unknown[] } | undefined;
    const client = {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        if (sql.includes('SET rotated_at')) {
          return { rows: [dirtyRow], rowCount: 1 };
        }
        if (sql.includes('SET scope = $2')) {
          retainedScopeWrite = { sql, values };
          return { rows: [], rowCount: 1 };
        }
        if (sql.startsWith('INSERT INTO oauth_refresh_tokens')) {
          successorWrite = { sql, values };
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    } as unknown as PoolClient;
    const pool = {
      connect: vi.fn(async () => client),
    } as unknown as Pool;
    const store = new PostgresOAuthStore(pool);

    const rotated = await store.rotateRefreshToken({
      oldTokenHash: 'refresh-hash',
      clientId: 'console-client',
      newTokenHash: 'refresh-successor',
      newExpiresAt: EXPIRES_AT,
      graceSeconds: 30,
      recoverySeconds: 300,
      nowSeconds: AUTH_TIME + 120,
    });

    expect(rotated).toMatchObject({
      status: 'rotated',
      identity: { scope: 'openid email', authTime: AUTH_TIME },
    });
    expect(retainedScopeWrite?.values).toEqual(['refresh-hash', 'openid email']);
    expect(successorWrite?.sql).toContain('auth_time');
    expect(successorWrite?.sql).toContain('upstream_expires_at');
    expect(successorWrite?.values).toContain(JSON.stringify(['admin', 'support']));
    expect(successorWrite?.values[7]).toBe('openid email');
    expect(successorWrite?.values).not.toContain(FRESH_AUTH_SCOPE);
    expect(successorWrite?.values).toContain(AUTH_TIME_DATE);
    expect(successorWrite?.values).toContain('https://login.microsoftonline.com/tenant-1/v2.0');
  });

  it('maps a nullable device customer issuer without exposing a fallback value', () => {
    const base = {
      device_code: 'device-code',
      user_code: 'user-code',
      client_id: 'mcp-client',
      resource: 'https://cloud.test',
      scope: null,
      status: 'approved' as const,
      owner_subject: 'customer-1',
      owner_email: null,
      owner_locale: null,
      owner_time_zone: null,
      identity_kind: 'customer' as const,
      identity_provider: 'firebase',
      developer_grant_id: null,
      expires_at: EXPIRES_AT_DATE,
      next_poll_at: AUTH_TIME_DATE,
      interval_seconds: 5,
    };

    expect(
      deviceRowToRecord({
        ...base,
        customer_issuer: 'https://securetoken.google.com/customer-project',
      }),
    ).toMatchObject({ customerIssuer: 'https://securetoken.google.com/customer-project' });
    expect(deviceRowToRecord({ ...base, customer_issuer: null })).not.toHaveProperty(
      'customerIssuer',
    );
  });
});

function refreshRow() {
  return {
    token: 'refresh-hash',
    client_id: 'console-client',
    owner_subject: 'principal-1',
    owner_email: null,
    owner_locale: null,
    owner_time_zone: null,
    resource: 'https://cloud.test',
    scope: null,
    identity_kind: null,
    identity_provider: null,
    customer_issuer: 'https://login.microsoftonline.com/tenant-1/v2.0',
    developer_grant_id: null,
    auth_time: AUTH_TIME_DATE,
    roles: ['admin', 'support'],
    upstream_expires_at: EXPIRES_AT_DATE,
    expires_at: EXPIRES_AT_DATE,
    family_id: 'family-1',
    rotated_at: null,
    superseded_by: null,
  };
}
