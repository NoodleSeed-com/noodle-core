import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createCustomerVerifierFactory,
  createHostedCustomerVerifierFactory,
  createLocalDevtoolsCustomerVerifierFactory,
} from '../src/customer-verifier.js';
import type { TenantAuthConfig, TenantBridgeAuthConfig } from '../src/store.js';

const MCP_RESOURCE = 'https://acme.cloud.noodleseed.dev/support/prod/mcp';
const ISSUER_A = 'https://tenant-a-idp.noodleseed.dev';
const ISSUER_B = 'https://tenant-b-idp.noodleseed.dev';

let privateKey: CryptoKey | Uint8Array;
let jwks: unknown;

beforeAll(async () => {
  const keys = await generateKeyPair('RS256', { extractable: true });
  privateKey = keys.privateKey;
  jwks = { keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'routing-key', alg: 'RS256' }] };
});

function factory(onFetch?: (url: string) => void) {
  return createCustomerVerifierFactory({
    fetchImpl: async (input) => {
      const url = input.toString();
      onFetch?.(url);
      for (const issuer of [ISSUER_A, ISSUER_B]) {
        if (url === `${issuer}/.well-known/openid-configuration`) {
          return Response.json({ issuer, jwks_uri: `${issuer}/jwks.json` });
        }
        if (url === `${issuer}/jwks.json`) return Response.json(jwks);
      }
      return new Response('not found', { status: 404 });
    },
  });
}

async function token(
  input: { issuer?: string; audience?: string; claims?: Record<string, unknown> } = {},
): Promise<string> {
  return new SignJWT(input.claims ?? {})
    .setProtectedHeader({ alg: 'RS256', kid: 'routing-key' })
    .setIssuer(input.issuer ?? ISSUER_A)
    .setSubject('customer-123')
    .setAudience(input.audience ?? 'customer-api')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

describe('customer verifier routing', () => {
  it('projects the direct OIDC endpoint claim outside the caller', async () => {
    const verifier = factory()({
      issuer: ISSUER_A,
      audience: 'customer-api',
      routing: { endpoints: { customer_api: { claim: 'tenant.api_base_url' } } },
    });

    const result = await verifier(
      await token({
        claims: { tenant: { api_base_url: 'https://acme.api.noodleseed.dev/v1' } },
      }),
      MCP_RESOURCE,
    );

    expect(result).toEqual(
      expect.objectContaining({
        caller: expect.objectContaining({
          subject: 'customer-123',
          audience: MCP_RESOURCE,
          identityKind: 'customer',
        }),
        customerIssuer: ISSUER_A,
        customerRouting: {
          customer_api: 'https://acme.api.noodleseed.dev/v1',
        },
      }),
    );
    expect(JSON.stringify(result?.caller)).not.toContain('acme.api.noodleseed.dev');
  });

  it('uses only the selected federated issuer endpoint claim paths', async () => {
    const verifier = factory()({
      kind: 'federatedOidc',
      issuers: [
        {
          issuer: ISSUER_A,
          audience: 'tenant-a-api',
          routing: { endpoints: { customer_api: { claim: 'tenant_a.url' } } },
        },
        {
          issuer: ISSUER_B,
          audience: 'tenant-b-api',
          routing: { endpoints: { customer_api: { claim: 'tenant_b.url' } } },
        },
      ],
    });

    const result = await verifier(
      await token({
        issuer: ISSUER_B,
        audience: 'tenant-b-api',
        claims: {
          tenant_a: { url: 'https://wrong.api.noodleseed.dev' },
          tenant_b: { url: 'https://right.api.noodleseed.dev/base' },
        },
      }),
      MCP_RESOURCE,
    );

    expect(result?.customerRouting).toEqual({
      customer_api: 'https://right.api.noodleseed.dev/base',
    });
    expect(result?.customerIssuer).toBe(ISSUER_B);
  });

  it.each([
    ['missing', {}],
    ['empty', { tenant: { url: '' } }],
    ['non-string', { tenant: { url: false } }],
    ['oversized', { tenant: { url: '🙂'.repeat(513) } }],
  ])('keeps a valid identity when a mapped route is %s', async (_name, claims) => {
    const verifier = factory()({
      issuer: ISSUER_A,
      audience: 'customer-api',
      routing: { endpoints: { customer_api: { claim: 'tenant.url' } } },
    });

    const result = await verifier(await token({ claims }), MCP_RESOURCE);

    expect(result?.caller).toMatchObject({
      subject: 'customer-123',
      identityKind: 'customer',
    });
    expect(result).not.toHaveProperty('customerRouting');
  });

  it('includes endpoint maps in the verifier cache identity', async () => {
    const create = factory();
    const first = create({
      issuer: ISSUER_A,
      audience: 'customer-api',
      routing: { endpoints: { customer_api: { claim: 'first.url' } } },
    });
    const second = create({
      issuer: ISSUER_A,
      audience: 'customer-api',
      routing: { endpoints: { customer_api: { claim: 'second.url' } } },
    });
    const signed = await token({
      claims: {
        first: { url: 'https://first.api.noodleseed.dev' },
        second: { url: 'https://second.api.noodleseed.dev' },
      },
    });

    await expect(first(signed, MCP_RESOURCE)).resolves.toMatchObject({
      customerRouting: { customer_api: 'https://first.api.noodleseed.dev' },
    });
    await expect(second(signed, MCP_RESOURCE)).resolves.toMatchObject({
      customerRouting: { customer_api: 'https://second.api.noodleseed.dev' },
    });
  });

  it('keeps cache identity stable across endpoint insertion order', async () => {
    const fetches = vi.fn();
    const create = factory(fetches);
    const endpoints = {
      customer_api: { claim: 'tenant.primary' },
      audit_api: { claim: 'tenant.audit' },
    };
    const first = create({
      issuer: ISSUER_A,
      audience: 'customer-api',
      routing: { endpoints },
    });
    const second = create({
      issuer: ISSUER_A,
      audience: 'customer-api',
      routing: {
        endpoints: {
          audit_api: endpoints.audit_api,
          customer_api: endpoints.customer_api,
        },
      },
    });
    const signed = await token({
      claims: {
        tenant: {
          primary: 'https://primary.api.noodleseed.dev',
          audit: 'https://audit.api.noodleseed.dev',
        },
      },
    });

    await expect(first(signed, MCP_RESOURCE)).resolves.toMatchObject({
      customerRouting: {
        customer_api: 'https://primary.api.noodleseed.dev',
        audit_api: 'https://audit.api.noodleseed.dev',
      },
    });
    await expect(second(signed, MCP_RESOURCE)).resolves.toMatchObject({
      customerRouting: {
        customer_api: 'https://primary.api.noodleseed.dev',
        audit_api: 'https://audit.api.noodleseed.dev',
      },
    });
    expect(fetches).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['null endpoint map', { routing: { endpoints: null } }],
    ['array endpoint map', { routing: { endpoints: [] } }],
    ['scalar endpoint map', { routing: { endpoints: 'tenant.url' } }],
    ['null entry', { routing: { endpoints: { customer_api: null } } }],
    ['array entry', { routing: { endpoints: { customer_api: [] } } }],
    ['missing claim', { routing: { endpoints: { customer_api: {} } } }],
    ['non-string claim', { routing: { endpoints: { customer_api: { claim: 42 } } } }],
  ])('treats a malformed persisted %s as routing-free without throwing', async (_name, malformed) => {
    const verifier = factory()({
      issuer: ISSUER_A,
      audience: 'customer-api',
      ...malformed,
    } as unknown as TenantAuthConfig);
    const signed = await token({
      claims: { tenant: { url: 'https://tenant.api.noodleseed.dev' } },
    });

    const result = await verifier(signed, MCP_RESOURCE);

    expect(result?.caller).toMatchObject({
      subject: 'customer-123',
      identityKind: 'customer',
    });
    expect(result).not.toHaveProperty('customerRouting');
  });

  it('strips malicious private routing from bridge verifier results', async () => {
    const customerIssuer = 'https://securetoken.google.com/project';
    const platformVerifier = vi.fn(async () => ({
      caller: {
        subject: 'customer-123',
        identityKind: 'customer' as const,
        identityProvider: 'firebase',
      },
      customerRouting: { customer_api: 'https://must-not-survive.invalid' },
      customerIssuer,
    }));
    const resolveBridgeAuth = vi.fn(async () => ({
      kind: 'bridge' as const,
      provider: 'firebase' as const,
      projectId: 'project',
    }));
    const hosted = createHostedCustomerVerifierFactory(() => async () => null, platformVerifier, {
      resolveBridgeAuth,
    });
    const verifier = hosted({ kind: 'bridge', provider: 'firebase', projectId: 'project' });

    await expect(verifier('token', MCP_RESOURCE)).resolves.toEqual({
      caller: {
        subject: 'customer-123',
        identityKind: 'customer',
        identityProvider: 'firebase',
      },
      customerIssuer,
    });
    expect(resolveBridgeAuth).toHaveBeenCalledWith(
      { kind: 'bridge', provider: 'firebase', projectId: 'project' },
      MCP_RESOURCE,
    );
  });

  it('keeps issuer-less bridge sessions compatible without inferring from current configuration', async () => {
    const platformVerifier = vi.fn(async () => ({
      caller: {
        subject: 'legacy-customer-123',
        identityKind: 'customer' as const,
        identityProvider: 'firebase',
      },
    }));
    const resolveBridgeAuth = vi.fn(async () => ({
      kind: 'bridge' as const,
      provider: 'firebase' as const,
      projectId: 'project',
    }));
    const verifier = createHostedCustomerVerifierFactory(() => async () => null, platformVerifier, {
      resolveBridgeAuth,
    })({ kind: 'bridge', provider: 'firebase', projectId: 'project' });

    await expect(verifier('legacy-token', MCP_RESOURCE)).resolves.toEqual({
      caller: {
        subject: 'legacy-customer-123',
        identityKind: 'customer',
        identityProvider: 'firebase',
      },
    });
    expect(resolveBridgeAuth).not.toHaveBeenCalled();
  });

  it.each([
    [
      'the current issuer differs',
      async () => ({ kind: 'bridge' as const, provider: 'firebase' as const, projectId: 'other' }),
      MCP_RESOURCE,
    ],
    [
      'the current provider differs',
      async () => ({
        kind: 'bridge' as const,
        provider: 'microsoft' as const,
        tenantId: 'tenant-1',
      }),
      MCP_RESOURCE,
    ],
    [
      'configuration resolution fails',
      async () => Promise.reject(new Error('unavailable')),
      MCP_RESOURCE,
    ],
    [
      'the exact resource is absent',
      async () => ({
        kind: 'bridge' as const,
        provider: 'firebase' as const,
        projectId: 'project',
      }),
      undefined,
    ],
  ])('rejects an issuer-bearing bridge token when %s', async (_name, resolveBridgeAuth, resource) => {
    const platformVerifier = vi.fn(async () => ({
      caller: {
        subject: 'customer-123',
        identityKind: 'customer' as const,
        identityProvider: 'firebase',
      },
      customerIssuer: 'https://securetoken.google.com/project',
    }));
    const verifier = createHostedCustomerVerifierFactory(() => async () => null, platformVerifier, {
      resolveBridgeAuth,
    })({ kind: 'bridge', provider: 'firebase', projectId: 'project' });

    await expect(verifier('token', resource)).resolves.toBeNull();
  });

  it('accepts a raw Firebase token only through the explicit local Devtools boundary', async () => {
    const rawVerifier = vi.fn(async () => ({
      caller: {
        subject: 'firebase-customer-123',
        audience: 'firebase-project',
        scopes: ['orders:read'],
      },
      customerRouting: { customer_api: 'https://must-not-survive.invalid' },
      customerIssuer: 'https://must-not-survive.invalid',
    }));
    const rawFactory = vi.fn(() => rawVerifier);
    const local = createLocalDevtoolsCustomerVerifierFactory(rawFactory);
    const verifier = local({
      kind: 'bridge',
      provider: 'firebase',
      projectId: 'firebase-project',
    });

    await expect(verifier('firebase-id-token', MCP_RESOURCE)).resolves.toEqual({
      caller: {
        subject: 'firebase-customer-123',
        audience: MCP_RESOURCE,
        scopes: ['orders:read'],
        identityKind: 'customer',
        identityProvider: 'firebase',
      },
    });
    expect(rawVerifier).toHaveBeenCalledWith('firebase-id-token', 'firebase-project');
    expect(rawFactory).toHaveBeenCalledOnce();
  });

  it('verifies and resource-binds a Microsoft ID token only through local Devtools', async () => {
    const tenantId = '11111111-2222-3333-4444-555555555555';
    const clientId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
    const fetches = vi.fn();
    const rawFactory = createCustomerVerifierFactory({
      fetchImpl: async (input) => {
        const url = input.toString();
        fetches(url);
        if (url === `${issuer}/.well-known/openid-configuration`) {
          return Response.json({ issuer, jwks_uri: `${issuer}/discovery/v2.0/keys` });
        }
        if (url === `${issuer}/discovery/v2.0/keys`) return Response.json(jwks);
        return new Response('not found', { status: 404 });
      },
    });
    const local = createLocalDevtoolsCustomerVerifierFactory(rawFactory);
    const verifier = local({
      kind: 'bridge',
      provider: 'microsoft',
      tenantId,
      clientId,
      clientSecret: 'managed-secret-name',
      user: { roles: 'app_roles' },
    });
    const idToken = await token({
      issuer,
      audience: clientId,
      claims: {
        preferred_username: 'ada@example.test',
        name: 'Ada Lovelace',
        app_roles: ['support.reader'],
      },
    });

    await expect(verifier(idToken, MCP_RESOURCE)).resolves.toEqual({
      caller: expect.objectContaining({
        subject: 'customer-123',
        email: 'ada@example.test',
        name: 'Ada Lovelace',
        roles: ['support.reader'],
        audience: MCP_RESOURCE,
        identityKind: 'customer',
        identityProvider: 'microsoft',
      }),
    });
    await expect(verifier(idToken, MCP_RESOURCE)).resolves.toMatchObject({
      caller: { subject: 'customer-123' },
    });
    expect(fetches).toHaveBeenCalledTimes(2);

    const hosted = createHostedCustomerVerifierFactory(
      rawFactory,
      undefined,
    )({
      kind: 'bridge',
      provider: 'microsoft',
      tenantId,
      clientId,
      clientSecret: 'managed-secret-name',
    });
    await expect(hosted(idToken, MCP_RESOURCE)).resolves.toBeNull();
  });

  it('resolves managed Microsoft bridge variables inside the loopback verifier boundary', async () => {
    const rawVerifier = vi.fn(async () => ({
      caller: { subject: 'microsoft-customer-123', audience: 'resolved-client-id' },
    }));
    const rawFactory = vi.fn(() => rawVerifier);
    const resolveBridgeAuth = vi.fn(async (auth: TenantBridgeAuthConfig, _resource: string) => ({
      ...auth,
      kind: 'bridge' as const,
      tenantId: 'resolved-tenant-id',
      clientId: 'resolved-client-id',
    }));
    const local = createLocalDevtoolsCustomerVerifierFactory(rawFactory, {
      allowedProviders: ['microsoft'],
      resolveBridgeAuth,
    });
    const unresolved = {
      kind: 'bridge' as const,
      provider: 'microsoft',
      tenantId: '${env.MICROSOFT_TENANT_ID}',
      clientId: '${env.MICROSOFT_CLIENT_ID}',
      clientSecret: 'MICROSOFT_CLIENT_SECRET',
    };
    const verifier = local(unresolved);

    await expect(verifier('microsoft-id-token', MCP_RESOURCE)).resolves.toEqual({
      caller: {
        subject: 'microsoft-customer-123',
        audience: MCP_RESOURCE,
        identityKind: 'customer',
        identityProvider: 'microsoft',
      },
    });
    expect(resolveBridgeAuth).toHaveBeenCalledWith(unresolved, MCP_RESOURCE);
    expect(rawFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'resolved-tenant-id',
        clientId: 'resolved-client-id',
      }),
    );
    expect(rawVerifier).toHaveBeenCalledWith('microsoft-id-token', 'resolved-client-id');
  });
});
