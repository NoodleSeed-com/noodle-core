import { describe, expect, it } from 'vitest';
import { type DeployRow, isTenantAuthConfig, rowToRecord } from '../src/store/postgres-rows.js';

describe('PostgreSQL deployment server-auth mapping', () => {
  it('preserves a valid federated OIDC configuration after a JSONB-shaped row read', () => {
    const serverAuth = {
      kind: 'federatedOidc',
      issuers: [
        {
          issuer: 'https://idp-a.example',
          audience: 'https://api.example/mcp',
        },
        {
          issuer: 'https://idp-b.example',
          audience: 'https://api.example/mcp',
        },
      ],
    } as const;

    expect(rowToRecord(rowWithServerAuth(serverAuth)).serverAuth).toEqual(serverAuth);
  });

  it.each([
    {
      name: 'direct OIDC',
      serverAuth: {
        issuer: 'https://tenant.example',
        audience: 'https://api.example/mcp',
      },
    },
    {
      name: 'managed bridge',
      serverAuth: {
        kind: 'bridge',
        provider: 'firebase',
        projectId: 'customer-project',
        apiKey: 'public-web-api-key',
        authDomain: 'customer-project.firebaseapp.com',
      },
    },
  ])('preserves the existing $name configuration', ({ serverAuth }) => {
    expect(rowToRecord(rowWithServerAuth(serverAuth)).serverAuth).toEqual(serverAuth);
  });

  it.each([
    { kind: 'federatedOidc', issuers: [] },
    { kind: 'federatedOidc', issuers: 'not-an-array' },
    {
      kind: 'federatedOidc',
      issuers: [{ issuer: '', audience: 'https://api.example/mcp' }],
    },
    {
      kind: 'federatedOidc',
      issuers: [{ issuer: 'https://tenant.example', audience: '' }],
    },
    {
      kind: 'federatedOidc',
      issuers: [{ issuer: 'https://tenant.example' }],
    },
    { kind: 'bridge', provider: '' },
    { kind: 'unknown', issuer: 'https://tenant.example', audience: 'api://support' },
    { issuer: '', audience: 'api://support' },
    { issuer: 'https://tenant.example', audience: '' },
  ])('rejects malformed persisted auth %#', (serverAuth) => {
    expect(isTenantAuthConfig(serverAuth)).toBe(false);
    expect(rowToRecord(rowWithServerAuth(serverAuth)).serverAuth).toBeUndefined();
  });
});

function rowWithServerAuth(serverAuth: unknown): DeployRow {
  return {
    deployment_id: 'deployment-1',
    org_slug: 'acme',
    app_slug: 'support',
    environment: 'prod',
    server_version: '1',
    deployment_version: '1',
    active: true,
    server_name: 'support',
    created_at: new Date('2026-07-28T00:00:00.000Z'),
    created_by_subject: 'owner-sub',
    created_by_email: 'owner@example.com',
    access_mode: 'customers',
    server_auth: serverAuth,
    caller_key_hash: null,
    manifest: '{}',
    connectors: null,
    hosted_assets: null,
    secrets: { enc: 'none', values: {} },
    schema_version: 1,
    archived_at: null,
    deployment_source: 'cli',
    org_membership_sources: null,
  };
}
