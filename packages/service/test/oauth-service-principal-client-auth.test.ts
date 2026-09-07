import { generateKeyPairSync } from 'node:crypto';
import { exportJWK, type KeyLike, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  authenticateServicePrincipalClient,
  ServicePrincipalClientAuthError,
  type ServicePrincipalClientAuthRequest,
} from '../src/oauth/service-principal-client-auth.js';
import { digestClientSecret } from '../src/oauth/service-principal-credentials.js';
import {
  InMemoryServicePrincipalStore,
  type ServicePrincipalStore,
} from '../src/oauth/service-principal-store.js';

const NOW = 1_785_715_200;
const NOW_MS = NOW * 1000;
const ISSUER = 'https://cloud.noodleseed.dev';
const TOKEN_ENDPOINT = `${ISSUER}/token`;
const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const SECRET = 'abcdefghijklmnopqrstuvwxyzABCDEFGH123456789';

let rsaPrivateKey: KeyLike;
let rsaPublicJwk: Record<string, unknown>;
let otherRsaPrivateKey: KeyLike;
let esPrivateKey: KeyLike;
let esPublicJwk: Record<string, unknown>;

beforeAll(async () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  rsaPrivateKey = rsa.privateKey;
  rsaPublicJwk = { ...(await exportJWK(rsa.publicKey)), alg: 'RS256', kid: 'rsa-primary' };
  otherRsaPrivateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  esPrivateKey = ec.privateKey;
  esPublicJwk = { ...(await exportJWK(ec.publicKey)), alg: 'ES256', kid: 'ec-primary' };
});

describe('service-principal client authentication', () => {
  it.each([
    ['RS256', () => rsaPrivateKey, () => rsaPublicJwk, 'rsa-primary'],
    ['ES256', () => esPrivateKey, () => esPublicJwk, 'ec-primary'],
  ] as const)('accepts a valid %s assertion with an exact matching kid', async (alg, key, jwk, kid) => {
    const fixture = await publicKeyFixture(alg, jwk());
    const assertion = await signAssertion(fixture.principalId, key(), alg, { kid });

    await expect(authenticate(assertionRequest(assertion), fixture.store)).resolves.toEqual({
      principalId: fixture.principalId,
      org: 'acme',
      credentialId: fixture.credentialId,
      assertion: { jti: 'assertion-1', expiresAt: NOW + 300 },
    });
  });

  it('accepts official-provider assertions that omit client_id and kid and use the issuer audience', async () => {
    const fixture = await publicKeyFixture('RS256', rsaPublicJwk);
    const assertion = await signAssertion(fixture.principalId, rsaPrivateKey, 'RS256', {
      omitKid: true,
      audience: ISSUER,
    });

    await expect(authenticate(assertionRequest(assertion), fixture.store)).resolves.toMatchObject({
      principalId: fixture.principalId,
      credentialId: fixture.credentialId,
    });
  });

  it('accepts client_secret_basic and compares against the bounded active-secret set', async () => {
    const fixture = await secretFixture();
    await fixture.store.createCredential({
      principalId: fixture.principalId,
      org: 'acme',
      actorSubject: 'human-1',
      kind: 'client_secret',
      label: 'rotation candidate',
      secretDigest: digestClientSecret('123456789abcdefghijklmnopqrstuvwxyzABCDEFGH'),
    });

    await expect(
      authenticate(
        request({}, `Basic ${Buffer.from(`${fixture.principalId}:${SECRET}`).toString('base64')}`),
        fixture.store,
      ),
    ).resolves.toMatchObject({
      principalId: fixture.principalId,
      org: 'acme',
      credentialId: fixture.credentialId,
    });
  });

  it.each([
    [
      'wrong signature',
      async (fixture: PublicFixture) =>
        signAssertion(fixture.principalId, otherRsaPrivateKey, 'RS256'),
    ],
    [
      'wrong algorithm/key',
      async (fixture: PublicFixture) => signAssertion(fixture.principalId, esPrivateKey, 'ES256'),
    ],
    [
      'wrong issuer and subject',
      async () => signAssertion('spn_00000000-0000-4000-8000-000000000099', rsaPrivateKey, 'RS256'),
    ],
    [
      'mismatched subject',
      async (fixture: PublicFixture) =>
        signAssertion(fixture.principalId, rsaPrivateKey, 'RS256', {
          subject: 'spn_00000000-0000-4000-8000-000000000099',
        }),
    ],
    [
      'wrong audience',
      async (fixture: PublicFixture) =>
        signAssertion(fixture.principalId, rsaPrivateKey, 'RS256', {
          audience: 'https://attacker.example/token',
        }),
    ],
    [
      'fractional iat',
      async (fixture: PublicFixture) =>
        signAssertion(fixture.principalId, rsaPrivateKey, 'RS256', { issuedAt: NOW + 0.5 }),
    ],
    [
      'future iat',
      async (fixture: PublicFixture) =>
        signAssertion(fixture.principalId, rsaPrivateKey, 'RS256', {
          issuedAt: NOW + 61,
          expiresAt: NOW + 300,
        }),
    ],
    [
      'expired assertion',
      async (fixture: PublicFixture) =>
        signAssertion(fixture.principalId, rsaPrivateKey, 'RS256', {
          issuedAt: NOW - 301,
          expiresAt: NOW - 1,
        }),
    ],
    [
      'overlong lifetime',
      async (fixture: PublicFixture) =>
        signAssertion(fixture.principalId, rsaPrivateKey, 'RS256', { expiresAt: NOW + 301 }),
    ],
    [
      'missing jti',
      async (fixture: PublicFixture) =>
        signAssertion(fixture.principalId, rsaPrivateKey, 'RS256', { omitJti: true }),
    ],
    [
      'overlong jti',
      async (fixture: PublicFixture) =>
        signAssertion(fixture.principalId, rsaPrivateKey, 'RS256', { jti: 'j'.repeat(201) }),
    ],
    [
      'unknown kid',
      async (fixture: PublicFixture) =>
        signAssertion(fixture.principalId, rsaPrivateKey, 'RS256', { kid: 'unknown' }),
    ],
    [
      'oversized assertion',
      async (fixture: PublicFixture) =>
        signAssertion(fixture.principalId, rsaPrivateKey, 'RS256', {
          padding: 'x'.repeat(17 * 1024),
        }),
    ],
  ] as const)('rejects %s with the same generic invalid_client error', async (_name, buildAssertion) => {
    const fixture = await publicKeyFixture('RS256', rsaPublicJwk);
    const assertion = await buildAssertion(fixture);
    await expectInvalidClient(authenticate(assertionRequest(assertion), fixture.store));
  });

  it('rejects a mismatched explicit client_id without trusting the assertion payload', async () => {
    const fixture = await publicKeyFixture('RS256', rsaPublicJwk);
    const assertion = await signAssertion(fixture.principalId, rsaPrivateKey, 'RS256');
    await expectInvalidClient(
      authenticate(
        assertionRequest(assertion, {
          client_id: 'spn_00000000-0000-4000-8000-000000000099',
        }),
        fixture.store,
      ),
    );
  });

  it.each([
    ['client_secret_post', request({ client_id: 'client', client_secret: SECRET })],
    ['malformed Basic', request({}, 'Basic !!!')],
    ['oversized Basic', request({}, `Basic ${'A'.repeat(4097)}`)],
    ['duplicate Basic', request({}, ['Basic YTpi', 'Basic Yzpk'])],
    ['unsupported auth scheme', request({}, 'Bearer token')],
    ['missing authentication', request({})],
  ] as const)('rejects %s generically before credential disclosure', async (_name, authRequest) => {
    const fixture = await secretFixture();
    await expectInvalidClient(authenticate(authRequest, fixture.store));
  });

  it('rejects conflicting Basic and assertion authentication', async () => {
    const fixture = await publicKeyFixture('RS256', rsaPublicJwk);
    const assertion = await signAssertion(fixture.principalId, rsaPrivateKey, 'RS256');
    await expectInvalidClient(
      authenticate(
        assertionRequest(
          assertion,
          {},
          `Basic ${Buffer.from(`${fixture.principalId}:${SECRET}`).toString('base64')}`,
        ),
        fixture.store,
      ),
    );
  });

  it('rejects unknown, revoked, and expired clients and credentials with one error surface', async () => {
    const unknown = request(
      {},
      `Basic ${Buffer.from(`spn_00000000-0000-4000-8000-000000000099:${SECRET}`).toString('base64')}`,
    );
    await expectInvalidClient(authenticate(unknown, new InMemoryServicePrincipalStore()));

    const revokedCredential = await secretFixture();
    await revokedCredential.store.revokeCredential({
      principalId: revokedCredential.principalId,
      credentialId: revokedCredential.credentialId,
      org: 'acme',
      actorSubject: 'human-1',
    });
    await expectInvalidClient(
      authenticate(basicRequest(revokedCredential.principalId), revokedCredential.store),
    );

    const revokedPrincipal = await secretFixture();
    await revokedPrincipal.store.revokePrincipal({
      principalId: revokedPrincipal.principalId,
      org: 'acme',
      actorSubject: 'human-1',
    });
    await expectInvalidClient(
      authenticate(basicRequest(revokedPrincipal.principalId), revokedPrincipal.store),
    );

    const expired = await secretFixture(
      new Date(NOW_MS - 2_000),
      new Date(NOW_MS - 1_000).toISOString(),
    );
    await expectInvalidClient(authenticate(basicRequest(expired.principalId), expired.store));
  });

  it('collapses store failures to invalid_client without exposing storage details', async () => {
    const store = {
      loadActiveClient: () => Promise.reject(new Error('postgres secret detail')),
    } as ServicePrincipalStore;
    await expectInvalidClient(
      authenticate(basicRequest('spn_00000000-0000-4000-8000-000000000001'), store),
    );
  });
});

interface PublicFixture {
  readonly store: InMemoryServicePrincipalStore;
  readonly principalId: string;
  readonly credentialId: string;
}

async function publicKeyFixture(
  algorithm: 'RS256' | 'ES256',
  publicJwk: Record<string, unknown>,
): Promise<PublicFixture> {
  const store = new InMemoryServicePrincipalStore({ now: () => new Date(NOW_MS) });
  const principal = await store.createPrincipal({
    org: 'acme',
    name: 'nightly',
    actorSubject: 'human-1',
  });
  const credential = await store.createCredential({
    principalId: principal.principalId,
    org: 'acme',
    actorSubject: 'human-1',
    kind: 'public_jwk',
    label: 'primary',
    algorithm,
    publicJwk,
  });
  return { store, principalId: principal.principalId, credentialId: credential.credentialId };
}

async function secretFixture(
  storeNow = new Date(NOW_MS),
  expiresAt?: string,
): Promise<PublicFixture> {
  const store = new InMemoryServicePrincipalStore({ now: () => storeNow });
  const principal = await store.createPrincipal({
    org: 'acme',
    name: 'nightly',
    actorSubject: 'human-1',
  });
  const credential = await store.createCredential({
    principalId: principal.principalId,
    org: 'acme',
    actorSubject: 'human-1',
    kind: 'client_secret',
    label: 'primary',
    secretDigest: digestClientSecret(SECRET),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  });
  return { store, principalId: principal.principalId, credentialId: credential.credentialId };
}

function authenticate(
  authRequest: ServicePrincipalClientAuthRequest,
  store: ServicePrincipalStore,
) {
  return authenticateServicePrincipalClient(authRequest, store, TOKEN_ENDPOINT, NOW);
}

function request(
  body: Readonly<Record<string, unknown>>,
  authorization?: string | readonly string[],
): ServicePrincipalClientAuthRequest {
  return { body, ...(authorization === undefined ? {} : { authorization }) };
}

function assertionRequest(
  assertion: string,
  extra: Readonly<Record<string, unknown>> = {},
  authorization?: string,
): ServicePrincipalClientAuthRequest {
  return request(
    {
      client_assertion_type: ASSERTION_TYPE,
      client_assertion: assertion,
      ...extra,
    },
    authorization,
  );
}

function basicRequest(principalId: string): ServicePrincipalClientAuthRequest {
  return request({}, `Basic ${Buffer.from(`${principalId}:${SECRET}`).toString('base64')}`);
}

interface AssertionOverrides {
  readonly audience?: string;
  readonly subject?: string;
  readonly issuedAt?: number;
  readonly expiresAt?: number;
  readonly jti?: string;
  readonly kid?: string;
  readonly omitKid?: boolean;
  readonly omitJti?: boolean;
  readonly padding?: string;
}

async function signAssertion(
  principalId: string,
  key: KeyLike,
  algorithm: 'RS256' | 'ES256',
  overrides: AssertionOverrides = {},
): Promise<string> {
  const issuedAt = overrides.issuedAt ?? NOW;
  let jwt = new SignJWT(overrides.padding === undefined ? {} : { padding: overrides.padding })
    .setProtectedHeader({
      alg: algorithm,
      ...(!overrides.omitKid && overrides.kid !== undefined ? { kid: overrides.kid } : {}),
    })
    .setIssuer(principalId)
    .setSubject(overrides.subject ?? principalId)
    .setAudience(overrides.audience ?? TOKEN_ENDPOINT)
    .setIssuedAt(issuedAt)
    .setExpirationTime(overrides.expiresAt ?? NOW + 300);
  if (!overrides.omitJti) jwt = jwt.setJti(overrides.jti ?? 'assertion-1');
  return jwt.sign(key);
}

async function expectInvalidClient(value: Promise<unknown>): Promise<void> {
  const error = await value.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ServicePrincipalClientAuthError);
  expect(error).toMatchObject({
    oauthError: 'invalid_client',
    status: 401,
    message: 'invalid client authentication',
  });
  expect(String(error)).not.toContain('postgres');
  expect(String(error)).not.toContain(PRINCIPAL_MATERIAL_SENTINEL);
}

const PRINCIPAL_MATERIAL_SENTINEL = SECRET;
