import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCustomerVerifierFactory } from '../src/customer-verifier.js';

let idp: Server;
let issuer: string;
let jwks: unknown;
let privateKey: CryptoKey | Uint8Array;
let metadataFailuresRemaining: number;
const MCP_RESOURCE = 'https://cloud.example/o/acme/support/prod/mcp';

beforeEach(async () => {
  metadataFailuresRemaining = 0;
  const keys = await generateKeyPair('RS256', { extractable: true });
  privateKey = keys.privateKey;
  jwks = { keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'test-key', alg: 'RS256' }] };
  idp = createServer((req, res) => {
    if (req.url === '/.well-known/openid-configuration') {
      if (metadataFailuresRemaining > 0) {
        metadataFailuresRemaining -= 1;
        res.statusCode = 503;
        res.end('temporarily unavailable');
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks.json` }));
      return;
    }
    if (req.url === '/jwks.json') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(jwks));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise<void>((resolve) => idp.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    idp.close((error) => (error ? reject(error) : resolve())),
  );
});

describe('customer IdP verifier factory', () => {
  it('retries direct OIDC verifier construction after a transient discovery failure', async () => {
    metadataFailuresRemaining = 1;
    const factory = createCustomerVerifierFactory({
      allowInsecureLocalhost: true,
      cacheTtlMs: 30_000,
    });
    const verifier = factory({ issuer, audience: 'customer-api' });
    const token = await signToken({ audience: 'customer-api' });

    await expect(verifier(token, MCP_RESOURCE)).resolves.toBe(null);
    await expect(verifier(token, MCP_RESOURCE)).resolves.toMatchObject({
      caller: { subject: 'customer-123' },
    });
  });

  it('retries Firebase verifier construction after a transient JWKS failure', async () => {
    const projectId = 'retry-firebase';
    let attempts = 0;
    const fetchImpl = vi.fn(async () => {
      attempts += 1;
      return attempts === 1
        ? new Response('temporarily unavailable', { status: 503 })
        : Response.json(jwks);
    });
    const factory = createCustomerVerifierFactory({
      firebaseJwksUri: 'https://keys.firebase.example/jwks.json',
      fetchImpl,
      cacheTtlMs: 30_000,
    });
    const verifier = factory({ kind: 'bridge', provider: 'firebase', projectId });
    const token = await signToken({
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
      subject: 'firebase-retry-user',
    });

    await expect(verifier(token, MCP_RESOURCE)).resolves.toBe(null);
    await expect(verifier(token, MCP_RESOURCE)).resolves.toMatchObject({
      caller: { subject: 'firebase-retry-user' },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries Microsoft verifier construction after a transient metadata failure', async () => {
    const tenantId = 'retry-tenant';
    const clientId = 'retry-client';
    const microsoftIssuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
    let metadataAttempts = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();
      if (url === `${microsoftIssuer}/.well-known/openid-configuration`) {
        metadataAttempts += 1;
        return metadataAttempts === 1
          ? new Response('temporarily unavailable', { status: 503 })
          : Response.json({ issuer: microsoftIssuer, jwks_uri: `${microsoftIssuer}/jwks` });
      }
      if (url === `${microsoftIssuer}/jwks`) return Response.json(jwks);
      return new Response('not found', { status: 404 });
    });
    const factory = createCustomerVerifierFactory({ fetchImpl, cacheTtlMs: 30_000 });
    const verifier = factory({
      kind: 'bridge',
      provider: 'microsoft',
      tenantId,
      clientId,
      clientSecret: 'managed-test-secret',
    });
    const token = await signToken({
      issuer: microsoftIssuer,
      audience: clientId,
      subject: 'microsoft-retry-user',
    });

    await expect(verifier(token, MCP_RESOURCE)).resolves.toBe(null);
    await expect(verifier(token, MCP_RESOURCE)).resolves.toMatchObject({
      caller: { subject: 'microsoft-retry-user' },
    });
    expect(metadataAttempts).toBe(2);
  });

  it('discovers issuer metadata and verifies tenant JWTs against server.auth audience', async () => {
    const factory = createCustomerVerifierFactory({
      allowInsecureLocalhost: true,
      cacheTtlMs: 30_000,
    });
    const verifier = factory({ issuer, audience: 'customer-api' });
    const token = await signToken({ audience: 'customer-api' });

    await expect(verifier(token, MCP_RESOURCE)).resolves.toMatchObject({
      caller: {
        subject: 'customer-123',
        email: 'customer@example.com',
        scopes: ['read', 'write'],
        identityKind: 'customer',
      },
    });

    await expect(verifier(await signToken({ audience: 'wrong-api' }), MCP_RESOURCE)).resolves.toBe(
      null,
    );
  });

  it('maps a direct OIDC stable audience to the exact requested MCP resource', async () => {
    const resources = [
      'https://cloud.example/o/acme/support/prod/mcp',
      'https://cloud.example/o/acme/support/prod/v1/mcp',
      'https://cloud.example/o/acme/support/prod/v2/mcp',
    ] as const;
    const factory = createCustomerVerifierFactory({
      allowInsecureLocalhost: true,
      cacheTtlMs: 30_000,
    });
    const verifier = factory({ issuer, audience: 'customer-api' });
    const stableAudienceToken = await signToken({ audience: 'customer-api' });

    for (const resource of resources) {
      await expect(verifier(stableAudienceToken, resource)).resolves.toMatchObject({
        caller: { audience: resource, identityKind: 'customer' },
      });
    }
    await expect(
      verifier(await signToken({ audience: ['customer-api', resources[1]] }), resources[1]),
    ).resolves.toMatchObject({
      caller: { audience: resources[1], identityKind: 'customer' },
    });
    await expect(verifier(await signToken({ audience: resources[0] }), resources[0])).resolves.toBe(
      null,
    );
    await expect(verifier(stableAudienceToken, undefined)).resolves.toBe(null);
  });

  it('accepts a single audience when the configured audience is the MCP resource', async () => {
    const factory = createCustomerVerifierFactory({
      allowInsecureLocalhost: true,
      cacheTtlMs: 30_000,
    });
    const verifier = factory({ issuer, audience: MCP_RESOURCE });

    await expect(
      verifier(await signToken({ audience: MCP_RESOURCE }), MCP_RESOURCE),
    ).resolves.toMatchObject({
      caller: { audience: MCP_RESOURCE, identityKind: 'customer' },
    });
  });

  it('projects only configured direct OIDC role and scope claim paths', async () => {
    const factory = createCustomerVerifierFactory({
      allowInsecureLocalhost: true,
      cacheTtlMs: 30_000,
    });
    const verifier = factory({
      issuer,
      audience: 'customer-api',
      claims: {
        roles: 'entitlements.roles',
        scopes: 'entitlements.scopes',
      },
    });
    const token = await signToken({
      audience: ['customer-api', MCP_RESOURCE],
      extraClaims: {
        roles: ['forged-admin'],
        entitlements: {
          roles: ['support', ' admin ', 'support'],
          scopes: ['tickets.write', 'tickets.read', 'tickets.write'],
        },
      },
    });

    await expect(verifier(token, MCP_RESOURCE)).resolves.toMatchObject({
      caller: {
        roles: ['admin', 'support'],
        scopes: ['tickets.read', 'tickets.write'],
      },
    });
  });

  it('accepts bounded string values at explicitly mapped claim paths', async () => {
    const factory = createCustomerVerifierFactory({
      allowInsecureLocalhost: true,
      cacheTtlMs: 30_000,
    });
    const verifier = factory({
      issuer,
      audience: 'customer-api',
      claims: {
        roles: 'entitlements.role',
        scopes: 'entitlements.scope',
      },
    });
    const token = await signToken({
      audience: ['customer-api', MCP_RESOURCE],
      extraClaims: {
        entitlements: {
          role: ' support ',
          scope: ' tickets.read ',
        },
      },
    });

    await expect(verifier(token, MCP_RESOURCE)).resolves.toMatchObject({
      caller: {
        roles: ['support'],
        scopes: ['tickets.read'],
      },
    });
  });

  it('ignores Noodle-private roles on direct external OIDC tokens without a mapping', async () => {
    const factory = createCustomerVerifierFactory({
      allowInsecureLocalhost: true,
      cacheTtlMs: 30_000,
    });
    const verifier = factory({ issuer, audience: 'customer-api' });
    const token = await signToken({
      audience: ['customer-api', MCP_RESOURCE],
      extraClaims: {
        roles: ['forged-generic-admin'],
        noodle_roles: ['forged-private-admin'],
      },
    });

    await expect(verifier(token, MCP_RESOURCE)).resolves.toMatchObject({
      caller: { roles: [] },
    });
  });

  it('fails closed when a configured direct OIDC role claim is malformed', async () => {
    const factory = createCustomerVerifierFactory({
      allowInsecureLocalhost: true,
      cacheTtlMs: 30_000,
    });
    const verifier = factory({
      issuer,
      audience: 'customer-api',
      claims: { roles: 'entitlements.roles' },
    });
    const token = await signToken({
      audience: ['customer-api', MCP_RESOURCE],
      extraClaims: { entitlements: { roles: ['support', 42] } },
    });

    await expect(verifier(token, MCP_RESOURCE)).resolves.toMatchObject({
      caller: { roles: [] },
    });
  });

  it('normalizes verified direct OIDC identities as customers and ignores issuer classification claims', async () => {
    const factory = createCustomerVerifierFactory({
      allowInsecureLocalhost: true,
      cacheTtlMs: 30_000,
    });
    const verifier = factory({ issuer, audience: 'customer-api' });
    const token = await signToken({
      audience: ['customer-api', MCP_RESOURCE],
      extraClaims: {
        noodle_identity: 'platform',
        noodle_identity_provider: 'forged-provider',
      },
    });

    await expect(verifier(token, MCP_RESOURCE)).resolves.toMatchObject({
      caller: {
        subject: 'customer-123',
        identityKind: 'customer',
      },
    });
    await expect(verifier(token, MCP_RESOURCE)).resolves.not.toHaveProperty(
      'caller.identityProvider',
    );
  });

  it('selects only an allowlisted federated OIDC issuer', async () => {
    const factory = createCustomerVerifierFactory({
      allowInsecureLocalhost: true,
      cacheTtlMs: 30_000,
    });
    const verifier = factory({
      kind: 'federatedOidc',
      issuers: [
        { issuer, audience: 'customer-api' },
        { issuer: 'https://partner.example.com', audience: 'partner-api' },
      ],
    });

    await expect(
      verifier(await signToken({ audience: 'customer-api' }), MCP_RESOURCE),
    ).resolves.toMatchObject({
      caller: { subject: 'customer-123', identityKind: 'customer' },
    });
    await expect(
      verifier(
        await signToken({ issuer: 'https://rogue.example.com', audience: 'customer-api' }),
        'ignored-resource',
      ),
    ).resolves.toBe(null);
  });

  it('maps the selected federated OIDC stable audience to the exact requested MCP resource', async () => {
    const resources = [
      'https://cloud.example/o/acme/support/prod/mcp',
      'https://cloud.example/o/acme/support/prod/v1/mcp',
      'https://cloud.example/o/acme/support/prod/v2/mcp',
    ] as const;
    const factory = createCustomerVerifierFactory({
      allowInsecureLocalhost: true,
      cacheTtlMs: 30_000,
    });
    const verifier = factory({
      kind: 'federatedOidc',
      issuers: [
        { issuer, audience: 'customer-api' },
        { issuer: 'https://partner.example.com', audience: 'partner-api' },
      ],
    });
    const stableAudienceToken = await signToken({ audience: 'customer-api' });

    for (const resource of resources) {
      await expect(verifier(stableAudienceToken, resource)).resolves.toMatchObject({
        caller: { audience: resource, identityKind: 'customer' },
      });
    }
    await expect(
      verifier(await signToken({ audience: 'partner-api' }), resources[0]),
    ).resolves.toBe(null);
    await expect(verifier(stableAudienceToken, undefined)).resolves.toBe(null);
  });

  it('uses only the claim mapping configured for the verified federated issuer', async () => {
    const tenantAIssuer = 'https://tenant-a.example.com';
    const tenantBIssuer = 'https://tenant-b.example.com';
    const factory = createCustomerVerifierFactory({
      cacheTtlMs: 30_000,
      fetchImpl: async (input) => {
        const url = input.toString();
        for (const configuredIssuer of [tenantAIssuer, tenantBIssuer]) {
          if (url === `${configuredIssuer}/.well-known/openid-configuration`) {
            return Response.json({
              issuer: configuredIssuer,
              jwks_uri: `${configuredIssuer}/jwks.json`,
            });
          }
          if (url === `${configuredIssuer}/jwks.json`) return Response.json(jwks);
        }
        return new Response('not found', { status: 404 });
      },
    });
    const verifier = factory({
      kind: 'federatedOidc',
      issuers: [
        {
          issuer: tenantAIssuer,
          audience: 'tenant-a-api',
          claims: { roles: 'tenant_a.roles', scopes: 'tenant_a.scopes' },
        },
        {
          issuer: tenantBIssuer,
          audience: 'tenant-b-api',
          claims: { roles: 'tenant_b.roles', scopes: 'tenant_b.scopes' },
        },
      ],
    });
    const token = await signToken({
      issuer: tenantBIssuer,
      audience: ['tenant-b-api', MCP_RESOURCE],
      extraClaims: {
        tenant_a: { roles: ['admin'], scopes: ['tenant-a.write'] },
        tenant_b: { roles: ['support'], scopes: ['tenant-b.read'] },
      },
    });

    await expect(verifier(token, MCP_RESOURCE)).resolves.toMatchObject({
      caller: {
        roles: ['support'],
        scopes: ['tenant-b.read'],
      },
    });
  });

  it('fails closed for insecure non-local issuer URLs', async () => {
    const factory = createCustomerVerifierFactory({ cacheTtlMs: 1 });
    const verifier = factory({ issuer: 'http://idp.example.com', audience: 'customer-api' });

    await expect(verifier('not-a-jwt', 'customer-api')).resolves.toBe(null);
  });

  it('keeps insecure localhost customer issuers disabled unless explicitly allowed', async () => {
    const factory = createCustomerVerifierFactory({ cacheTtlMs: 1 });
    const verifier = factory({ issuer, audience: 'customer-api' });
    const token = await signToken({ audience: 'customer-api' });

    await expect(verifier(token, 'customer-api')).resolves.toBe(null);
  });

  it('allows localhost spelling for explicit local issuer tests', async () => {
    issuer = issuer.replace('127.0.0.1', 'localhost');
    const factory = createCustomerVerifierFactory({
      allowInsecureLocalhost: true,
      cacheTtlMs: 1,
    });
    const verifier = factory({ issuer, audience: 'customer-api' });
    const token = await signToken({ audience: 'customer-api' });

    await expect(verifier(token, 'customer-api')).resolves.toMatchObject({
      caller: { subject: 'customer-123' },
    });
  });

  it('allows HTTPS loopback issuers when the explicit localhost test escape hatch is enabled', async () => {
    const httpsIssuer = 'https://127.0.0.1:9443';
    const factory = createCustomerVerifierFactory({
      allowInsecureLocalhost: true,
      cacheTtlMs: 1,
      fetchImpl: async (input) => {
        const url = input.toString();
        if (url === `${httpsIssuer}/.well-known/openid-configuration`) {
          return Response.json({ issuer: httpsIssuer, jwks_uri: `${httpsIssuer}/jwks.json` });
        }
        if (url === `${httpsIssuer}/jwks.json`) return Response.json(jwks);
        return new Response('not found', { status: 404 });
      },
    });
    const verifier = factory({ issuer: httpsIssuer, audience: 'customer-api' });
    const token = await signToken({ issuer: httpsIssuer, audience: 'customer-api' });

    await expect(verifier(token, 'customer-api')).resolves.toMatchObject({
      caller: { subject: 'customer-123' },
    });
  });

  it('verifies Firebase ID tokens against the configured project id', async () => {
    const projectId = 'noodleseed-prod';
    const firebaseIssuer = `https://securetoken.google.com/${projectId}`;
    const factory = createCustomerVerifierFactory({
      firebaseJwks: jwks,
      cacheTtlMs: 30_000,
    });
    const verifier = factory({
      kind: 'bridge',
      provider: 'firebase',
      projectId,
      user: { roles: 'claims.roles', scopes: 'claims.scopes' },
    });
    const token = await signToken({
      issuer: firebaseIssuer,
      audience: projectId,
      subject: 'firebase-user-123',
      extraClaims: {
        email: 'firebase@example.com',
        name: 'Firebase User',
        locale: 'fr-fr',
        zoneinfo: 'Invalid/Zone',
        firebase: { sign_in_provider: 'password' },
        roles: ['forged-admin'],
        claims: {
          roles: ['support', ' admin ', 'support'],
          scopes: ['tickets.write', 'tickets.read'],
        },
      },
    });

    await expect(verifier(token, 'ignored-resource')).resolves.toMatchObject({
      caller: {
        subject: 'firebase-user-123',
        email: 'firebase@example.com',
        name: 'Firebase User',
        audience: projectId,
        locale: 'fr-FR',
        roles: ['admin', 'support'],
        scopes: ['tickets.read', 'tickets.write'],
      },
    });
    expect((await verifier(token, 'ignored-resource'))?.caller.expiresAt).toBeTypeOf('number');
    expect(await verifier(token, 'ignored-resource')).not.toHaveProperty('caller.timeZone');

    await expect(
      verifier(
        await signToken({
          issuer: 'https://securetoken.google.com/wrong-project',
          audience: projectId,
          subject: 'firebase-user-123',
        }),
        'ignored-resource',
      ),
    ).resolves.toBe(null);
    await expect(
      verifier(
        await signToken({
          issuer: firebaseIssuer,
          audience: 'wrong-project',
          subject: 'firebase-user-123',
        }),
        'ignored-resource',
      ),
    ).resolves.toBe(null);
    await expect(
      verifier(
        await signToken({
          issuer: firebaseIssuer,
          audience: projectId,
          subject: '',
        }),
        'ignored-resource',
      ),
    ).resolves.toBe(null);
    await expect(
      verifier(
        await signToken({
          issuer: firebaseIssuer,
          audience: projectId,
          subject: 'firebase-user-123',
          kid: 'unknown-key',
        }),
        'ignored-resource',
      ),
    ).resolves.toBe(null);
    await expect(
      verifier(
        await signHsToken({
          issuer: firebaseIssuer,
          audience: projectId,
          subject: 'firebase-user-123',
        }),
        'ignored-resource',
      ),
    ).resolves.toBe(null);
  });
});

async function signToken(input: {
  audience: string | string[];
  issuer?: string;
  subject?: string;
  kid?: string;
  extraClaims?: Record<string, unknown>;
}): Promise<string> {
  return new SignJWT({
    email: 'customer@example.com',
    scope: 'read write',
    ...input.extraClaims,
  })
    .setProtectedHeader({
      alg: 'RS256',
      kid: input.kid ?? 'test-key',
    })
    .setIssuer(input.issuer ?? issuer)
    .setSubject(input.subject === undefined ? 'customer-123' : input.subject)
    .setAudience(input.audience)
    .setExpirationTime('5m')
    .setIssuedAt()
    .sign(privateKey);
}

async function signHsToken(input: {
  audience: string;
  issuer: string;
  subject: string;
}): Promise<string> {
  return new SignJWT({ email: 'customer@example.com' })
    .setProtectedHeader({ alg: 'HS256', kid: 'test-key' })
    .setIssuer(input.issuer)
    .setSubject(input.subject)
    .setAudience(input.audience)
    .setExpirationTime('5m')
    .setIssuedAt()
    .sign(new TextEncoder().encode('not-the-rsa-key'));
}
