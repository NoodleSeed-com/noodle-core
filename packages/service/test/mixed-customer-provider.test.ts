import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createCustomerVerifierFactory,
  createHostedCustomerVerifierFactory,
} from '../src/customer-verifier.js';
import { InMemoryArtifactStore, ServerRegistry, type TenantAuthConfig } from '../src/index.js';

const resource = 'https://service.example/o/mixed-provider/app/mcp';
const first = 'https://first.example';
const second = 'https://second.example';
let key: CryptoKey | Uint8Array;
let jwks: Awaited<ReturnType<typeof exportJWK>>;
beforeAll(async () => {
  const keys = await generateKeyPair('RS256', { extractable: true });
  key = keys.privateKey;
  jwks = { ...(await exportJWK(keys.publicKey)), kid: 'test', alg: 'RS256' };
});
async function target(
  auth: TenantAuthConfig,
  factory = createCustomerVerifierFactory({
    fetchImpl: async (input) => {
      const url = input.toString();
      return Response.json(
        url.endsWith('/jwks')
          ? { keys: [jwks] }
          : { issuer: new URL(url).origin, jwks_uri: `${new URL(url).origin}/jwks` },
      );
    },
    lookup: async () => [{ address: '93.184.215.14', family: 4 }],
  }),
) {
  const registry = new ServerRegistry(new InMemoryArtifactStore(), undefined, undefined, {
    customerVerifierFactory: factory,
  });
  const tenant = { org: 'mixed-provider', app: 'app', env: 'prod' };
  const manifest = JSON.stringify({
    manifestVersion: '2',
    server: { name: 'provider', title: 'Provider', version: '1.0.0', auth },
    tools: [
      {
        name: 'ping',
        description: 'Ping',
        inputSchema: { type: 'object' },
        fulfilment: { steps: [], output: {} },
      },
    ],
  });
  const deployed = await registry.deploy(tenant, manifest, {
    accessMode: 'mixed',
    actor: { subject: 'owner', email: 'owner@example.com', superAdmin: false },
  });
  expect(deployed.ok).toBe(true);
  const served = await registry.getActiveByTenant(tenant);
  expect(served?.authentication?.kind).toBe('customer');
  return served?.authentication?.verifyToken;
}
function token(issuer: string, grants: unknown, audience = 'customer-api') {
  return new SignJWT({ grants })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject('same-subject')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key);
}
describe('mixed customer provider parity', () => {
  it.each([
    'tickets.read tickets.write',
    ['tickets.read', 'tickets.write'],
  ])('binds direct OIDC mapped grants and roles to the request resource: %j', async (scopes) => {
    const verify = await target({
      issuer: first,
      audience: 'customer-api',
      claims: { scopes: 'grants.scopes', roles: 'grants.roles' },
    });
    const signed = await token(first, { scopes, roles: ['support'] });
    await expect(verify?.(signed, resource)).resolves.toMatchObject({
      customerIssuer: first,
      caller: {
        identityKind: 'customer',
        subject: 'same-subject',
        audience: resource,
        scopes: ['tickets.read', 'tickets.write'],
        roles: ['support'],
      },
    });
    await expect(verify?.(await token(second, { scopes }), resource)).resolves.toBeNull();
    await expect(
      verify?.(await token(first, { scopes }, 'wrong-audience'), resource),
    ).resolves.toBeNull();
  });
  it.each([
    undefined,
    { scopes: [42], roles: { admin: true } },
  ])('does not manufacture missing or malformed grants: %j', async (grants) => {
    const verify = await target({
      issuer: first,
      audience: 'customer-api',
      claims: { scopes: 'grants.scopes', roles: 'grants.roles' },
    });
    await expect(verify?.(await token(first, grants), resource)).resolves.toMatchObject({
      caller: { scopes: [], roles: [] },
    });
  });
  it('keeps same-subject federated identities bound to their verified issuer and mapped grants', async () => {
    const verify = await target({
      kind: 'federatedOidc',
      issuers: [
        { issuer: first, audience: 'customer-api', claims: { scopes: 'grants.first' } },
        { issuer: second, audience: 'customer-api', claims: { scopes: 'grants.second' } },
      ],
    });
    for (const [issuer, scopes] of [
      [first, ['a.read']],
      [second, ['b.read']],
    ] as const) {
      await expect(
        verify?.(await token(issuer, { first: ['a.read'], second: ['b.read'] }), resource),
      ).resolves.toMatchObject({
        customerIssuer: issuer,
        caller: { subject: 'same-subject', audience: resource, scopes },
      });
    }
  });
  it.each([
    'firebase',
    'microsoft',
  ] as const)('uses the managed %s wrapper and rejects platform humans', async (provider) => {
    const auth: TenantAuthConfig =
      provider === 'firebase'
        ? { kind: 'bridge', provider, projectId: 'project' }
        : {
            kind: 'bridge',
            provider,
            tenantId: 'tenant',
            clientId: 'client',
            scopes: ['User.Read'],
          };
    const factory = createHostedCustomerVerifierFactory(
      () => async () => null,
      async (value, requestResource) =>
        value === 'customer'
          ? {
              caller: {
                subject: 'customer',
                identityKind: 'customer',
                identityProvider: provider,
                audience: requestResource,
              },
            }
          : { caller: { subject: 'owner', identityKind: 'platform' } },
    );
    const verify = await target(auth, factory);
    await expect(verify?.('customer', resource)).resolves.toMatchObject({
      caller: { identityKind: 'customer', identityProvider: provider, audience: resource },
    });
    await expect(verify?.('platform-human', resource)).resolves.toBeNull();
  });
});
