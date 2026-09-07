import type { JWTVerifyGetKey } from 'jose';
import { generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { createJwtVerifier } from '../src/index.js';

const ISSUER = 'https://as.noodle.test';
const RESOURCE = 'https://borg.test/o/acme/support/mcp';
const SERVICE_SUBJECT = 'spn_11111111-1111-4111-8111-111111111111';

let privateKey: CryptoKey;
let resolver: JWTVerifyGetKey;
let otherResolver: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair('ES256');
  privateKey = pair.privateKey;
  resolver = (async () => pair.publicKey) as JWTVerifyGetKey;
  const other = await generateKeyPair('ES256');
  otherResolver = (async () => other.publicKey) as JWTVerifyGetKey;
});

function mint(
  claims: Record<string, unknown>,
  opts: {
    issuer?: string;
    audience?: string | string[];
    subject?: string;
    expiresIn?: string;
  } = {},
): Promise<string> {
  let jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer(opts.issuer ?? ISSUER)
    .setSubject(opts.subject ?? 'google-sub-123')
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? '1h');
  if (opts.audience !== undefined) jwt = jwt.setAudience(opts.audience);
  return jwt.sign(privateKey);
}

describe('createJwtVerifier', () => {
  it('accepts a valid token and returns the identity', async () => {
    const verify = createJwtVerifier({ issuer: ISSUER, keyResolver: resolver });
    const authTime = Math.floor(Date.now() / 1_000) - 30;
    const token = await mint(
      {
        scope: 'read write',
        email: 'owner@noodleseed.com',
        locale: 'en-GB',
        zoneinfo: 'Europe/London',
        auth_time: authTime,
      },
      { audience: RESOURCE },
    );
    const id = (await verify(token, RESOURCE))?.caller;
    expect(id).not.toBeNull();
    expect(id?.subject).toBe('google-sub-123');
    expect(id?.scopes).toEqual(['read', 'write']);
    expect(id?.audience).toBe(RESOURCE);
    expect(id?.email).toBe('owner@noodleseed.com');
    expect(id?.locale).toBe('en-GB');
    expect(id?.timeZone).toBe('Europe/London');
    expect(id?.authTime).toBe(authTime);
    expect(typeof id?.expiresAt).toBe('number');
  });

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['string', '1700000000'],
    ['null', null],
    ['not finite', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
  ])('rejects a %s auth_time claim', async (_name, authTime) => {
    const verify = createJwtVerifier({ issuer: ISSUER, keyResolver: resolver });
    const token = await mint({ auth_time: authTime }, { audience: RESOURCE });
    await expect(verify(token, RESOURCE)).resolves.toBeNull();
  });

  it('rejects a future auth_time claim', async () => {
    const verify = createJwtVerifier({ issuer: ISSUER, keyResolver: resolver });
    const token = await mint(
      { auth_time: Math.floor(Date.now() / 1_000) + 60 },
      { audience: RESOURCE },
    );
    await expect(verify(token, RESOURCE)).resolves.toBeNull();
  });

  it('accepts a token without auth_time without fabricating freshness', async () => {
    const verify = createJwtVerifier({ issuer: ISSUER, keyResolver: resolver });
    const identity = (await verify(await mint({}, { audience: RESOURCE }), RESOURCE))?.caller;
    expect(identity).not.toBeNull();
    expect(identity).not.toHaveProperty('authTime');
  });

  it('projects only a string display name', async () => {
    const verify = createJwtVerifier({ issuer: ISSUER, keyResolver: resolver });
    const named = (
      await verify(await mint({ name: 'Pat Example' }, { audience: RESOURCE }), RESOURCE)
    )?.caller;
    const malformed = (
      await verify(await mint({ name: ['Pat Example'] }, { audience: RESOURCE }), RESOURCE)
    )?.caller;

    expect(named).toMatchObject({ name: 'Pat Example' });
    expect(malformed).not.toHaveProperty('name');
  });

  it('canonicalizes valid preferences and drops malformed identity preferences', async () => {
    const verify = createJwtVerifier({ issuer: ISSUER, keyResolver: resolver });
    const token = await mint(
      { locale: 'EN-gb', zoneinfo: 'Not/A_Time_Zone' },
      { audience: RESOURCE, subject: 'user-2' },
    );
    await expect(verify(token, RESOURCE)).resolves.toMatchObject({
      caller: { subject: 'user-2', locale: 'en-GB' },
    });
    const identity = (await verify(token, RESOURCE))?.caller;
    expect(identity).not.toHaveProperty('timeZone');
  });

  it('rejects a token signed by a different key', async () => {
    const verify = createJwtVerifier({ issuer: ISSUER, keyResolver: otherResolver });
    const token = await mint({}, { audience: RESOURCE });
    expect(await verify(token, RESOURCE)).toBeNull();
  });

  it('rejects a token from the wrong issuer', async () => {
    const verify = createJwtVerifier({ issuer: ISSUER, keyResolver: resolver });
    const token = await mint({}, { issuer: 'https://evil.test', audience: RESOURCE });
    expect(await verify(token, RESOURCE)).toBeNull();
  });

  it('rejects a token whose audience is not the requested resource', async () => {
    const verify = createJwtVerifier({ issuer: ISSUER, keyResolver: resolver });
    const token = await mint({}, { audience: 'https://borg.test/o/other/app/mcp' });
    expect(await verify(token, RESOURCE)).toBeNull();
  });

  it('requires every requested audience for a multi-audience verification', async () => {
    const customerAudience = 'customer-api';
    const verify = createJwtVerifier({
      issuer: ISSUER,
      keyResolver: resolver,
      requiredAudiences: [customerAudience],
    });
    const token = await mint({}, { audience: [customerAudience, RESOURCE] });
    const missingCustomerAudience = await mint({}, { audience: RESOURCE });
    const missingResourceAudience = await mint({}, { audience: customerAudience });

    await expect(verify(token, RESOURCE)).resolves.toMatchObject({
      caller: { audience: RESOURCE },
    });
    await expect(verify(missingCustomerAudience, RESOURCE)).resolves.toBeNull();
    await expect(verify(missingResourceAudience, RESOURCE)).resolves.toBeNull();
  });

  it('rejects an expired token', async () => {
    const verify = createJwtVerifier({ issuer: ISSUER, keyResolver: resolver });
    const token = await mint({}, { audience: RESOURCE, expiresIn: '-1m' });
    expect(await verify(token, RESOURCE)).toBeNull();
  });

  it('rejects a malformed token', async () => {
    const verify = createJwtVerifier({ issuer: ISSUER, keyResolver: resolver });
    expect(await verify('not-a-jwt', RESOURCE)).toBeNull();
  });

  it('parses array-form scopes and tolerates a missing scope claim', async () => {
    const verify = createJwtVerifier({ issuer: ISSUER, keyResolver: resolver });
    const arr = (await verify(await mint({ scopes: ['a', 'b'] }, { audience: RESOURCE }), RESOURCE))
      ?.caller;
    expect(arr?.scopes).toEqual(['a', 'b']);
    const none = (await verify(await mint({}, { audience: RESOURCE }), RESOURCE))?.caller;
    expect(none?.scopes).toEqual([]);
  });

  it('canonicalizes trusted Noodle roles without trusting a generic roles claim', async () => {
    const verify = createJwtVerifier({ issuer: ISSUER, keyResolver: resolver });
    const identity = (
      await verify(
        await mint(
          {
            roles: ['forged-admin'],
            noodle_roles: [' support ', 'admin', 'support'],
          },
          { audience: RESOURCE },
        ),
        RESOURCE,
      )
    )?.caller;

    expect(identity?.roles).toEqual(['admin', 'support']);
  });

  it('projects only explicitly configured nested role and scope claims', async () => {
    const verify = createJwtVerifier({
      issuer: ISSUER,
      keyResolver: resolver,
      claims: {
        roles: 'entitlements.roles',
        scopes: 'permissions',
      },
    });
    const identity = (
      await verify(
        await mint(
          {
            roles: ['forged-admin'],
            permissions: 'tickets.write tickets.read tickets.write',
            entitlements: { roles: ['support', ' admin ', 'support'] },
          },
          { audience: RESOURCE },
        ),
        RESOURCE,
      )
    )?.caller;

    expect(identity?.roles).toEqual(['admin', 'support']);
    expect(identity?.scopes).toEqual(['tickets.read', 'tickets.write']);
  });

  it.each([
    ['a mixed-type mapped role array', ['admin', 42]],
    ['too many mapped roles', Array.from({ length: 129 }, (_, index) => `role-${index}`)],
    ['an overlong mapped role', ['r'.repeat(201)]],
  ])('fails closed for %s', async (_name, roles) => {
    const verify = createJwtVerifier({
      issuer: ISSUER,
      keyResolver: resolver,
      claims: { roles: 'entitlements.roles' },
    });
    const identity = (
      await verify(await mint({ entitlements: { roles } }, { audience: RESOURCE }), RESOURCE)
    )?.caller;

    expect(identity?.roles).toEqual([]);
  });

  it('ignores malformed developer grant and OAuth client claims', async () => {
    const verify = createJwtVerifier({ issuer: ISSUER, keyResolver: resolver });
    const nonStrings = (
      await verify(
        await mint({ noodle_grant_id: ['grant-1'], client_id: 42 }, { audience: RESOURCE }),
        RESOURCE,
      )
    )?.caller;
    expect(nonStrings).not.toHaveProperty('developerGrantId');
    expect(nonStrings).not.toHaveProperty('oauthClientId');

    const outOfBounds = (
      await verify(
        await mint({ noodle_grant_id: '', client_id: 'x'.repeat(201) }, { audience: RESOURCE }),
        RESOURCE,
      )
    )?.caller;
    expect(outOfBounds).not.toHaveProperty('developerGrantId');
    expect(outOfBounds).not.toHaveProperty('oauthClientId');
  });

  it('projects a service caller while keeping lifecycle bindings private', async () => {
    const verify = createJwtVerifier({ issuer: ISSUER, keyResolver: resolver });
    const token = await mint(
      {
        scope: 'todos.read',
        client_id: SERVICE_SUBJECT,
        noodle_identity: 'service',
        noodle_service_grant_id: 'spg_1',
        noodle_service_credential_id: 'spc_1',
      },
      { audience: RESOURCE, subject: SERVICE_SUBJECT },
    );

    const verified = await verify(token, RESOURCE);
    expect(verified).toMatchObject({
      caller: {
        subject: SERVICE_SUBJECT,
        scopes: ['todos.read'],
        roles: [],
        identityKind: 'service',
        oauthClientId: SERVICE_SUBJECT,
      },
      servicePrincipal: { grantId: 'spg_1', credentialId: 'spc_1' },
    });
    expect(verified?.caller).not.toHaveProperty('servicePrincipalGrantId');
    expect(verified?.caller).not.toHaveProperty('servicePrincipalCredentialId');
  });

  /**
   * `anonymous` is a real principal kind (ADR 0201 §5) but it is minted **server-side only**, for a
   * public website assistant session. A bearer token must never be able to claim it: doing so would let
   * a caller present itself as the one principal that skips customer routing and delegated exchange.
   * The verifier's allowlist is what makes that unrepresentable rather than merely unlikely.
   */
  it('drops an anonymous identity claimed by a token', async () => {
    const verify = createJwtVerifier({ issuer: ISSUER, keyResolver: resolver });
    const token = await mint(
      { noodle_identity: 'anonymous' },
      { audience: RESOURCE, subject: 'someone' },
    );

    const verified = await verify(token, RESOURCE);
    expect(verified?.caller.subject).toBe('someone');
    expect(verified?.caller).not.toHaveProperty('identityKind');
  });

  it('projects a canonical customer issuer only on the private token envelope', async () => {
    const verify = createJwtVerifier({ issuer: ISSUER, keyResolver: resolver });
    const token = await mint(
      {
        noodle_identity: 'customer',
        noodle_customer_issuer: 'https://login.microsoftonline.com/tenant-1/v2.0/',
      },
      { audience: RESOURCE, subject: 'customer-subject-1' },
    );

    const verified = await verify(token, RESOURCE);
    expect(verified).toMatchObject({
      caller: { subject: 'customer-subject-1', identityKind: 'customer' },
      customerIssuer: 'https://login.microsoftonline.com/tenant-1/v2.0',
    });
    expect(verified?.caller).not.toHaveProperty('customerIssuer');
  });

  it('keeps customer issuer claims from external IdP verifiers', async () => {
    const verify = createJwtVerifier({
      issuer: ISSUER,
      keyResolver: resolver,
      trustNoodlePrivateClaims: false,
    });
    const token = await mint(
      {
        noodle_identity: 'customer',
        noodle_customer_issuer: 'https://issuer.customer.example',
      },
      { audience: RESOURCE, subject: 'customer-subject-1' },
    );

    const verified = await verify(token, RESOURCE);
    expect(verified?.caller.subject).toBe('customer-subject-1');
    expect(verified).not.toHaveProperty('customerIssuer');
  });

  it.each([
    ['a platform identity', 'platform', 'https://issuer.customer.example'],
    ['a service identity', 'service', 'https://issuer.customer.example'],
    ['an HTTP issuer', 'customer', 'http://issuer.customer.example'],
    ['an issuer with credentials', 'customer', 'https://user:pass@issuer.customer.example'],
    ['an issuer with a query', 'customer', 'https://issuer.customer.example?tenant=1'],
    ['an issuer with a fragment', 'customer', 'https://issuer.customer.example#tenant'],
    ['an array issuer', 'customer', ['https://issuer.customer.example']],
  ])('rejects a private customer issuer on %s', async (_name, identityKind, customerIssuer) => {
    const verify = createJwtVerifier({ issuer: ISSUER, keyResolver: resolver });
    const token = await mint(
      {
        noodle_identity: identityKind,
        noodle_customer_issuer: customerIssuer,
        ...(identityKind === 'service'
          ? {
              client_id: SERVICE_SUBJECT,
              noodle_service_grant_id: 'spg_1',
              noodle_service_credential_id: 'spc_1',
            }
          : {}),
      },
      {
        audience: RESOURCE,
        subject: identityKind === 'service' ? SERVICE_SUBJECT : 'customer-subject-1',
      },
    );

    await expect(verify(token, RESOURCE)).resolves.toBeNull();
  });

  it('keeps issuer-less customer tokens compatible without fabricating provenance', async () => {
    const verify = createJwtVerifier({ issuer: ISSUER, keyResolver: resolver });
    const token = await mint(
      { noodle_identity: 'customer' },
      { audience: RESOURCE, subject: 'customer-subject-1' },
    );

    const verified = await verify(token, RESOURCE);
    expect(verified?.caller.identityKind).toBe('customer');
    expect(verified).not.toHaveProperty('customerIssuer');
  });

  it('rejects a service token whose OAuth client differs from its subject', async () => {
    const verify = createJwtVerifier({ issuer: ISSUER, keyResolver: resolver });
    const token = await mint(
      {
        client_id: 'spn_22222222-2222-4222-8222-222222222222',
        noodle_identity: 'service',
        noodle_service_grant_id: 'spg_1',
        noodle_service_credential_id: 'spc_1',
      },
      { audience: RESOURCE, subject: SERVICE_SUBJECT },
    );

    await expect(verify(token, RESOURCE)).resolves.toBeNull();
  });

  it.each([
    ['grant', { noodle_service_credential_id: 'spc_1' }],
    ['credential', { noodle_service_grant_id: 'spg_1' }],
  ])('rejects a service token missing its %s binding', async (_binding, lifecycleClaims) => {
    const verify = createJwtVerifier({ issuer: ISSUER, keyResolver: resolver });
    const token = await mint(
      {
        client_id: SERVICE_SUBJECT,
        noodle_identity: 'service',
        ...lifecycleClaims,
      },
      { audience: RESOURCE, subject: SERVICE_SUBJECT },
    );

    await expect(verify(token, RESOURCE)).resolves.toBeNull();
  });

  it('rejects service roles instead of silently stripping them', async () => {
    const verify = createJwtVerifier({ issuer: ISSUER, keyResolver: resolver });
    const token = await mint(
      {
        client_id: SERVICE_SUBJECT,
        noodle_identity: 'service',
        noodle_roles: ['admin'],
        noodle_service_grant_id: 'spg_1',
        noodle_service_credential_id: 'spc_1',
      },
      { audience: RESOURCE, subject: SERVICE_SUBJECT },
    );

    await expect(verify(token, RESOURCE)).resolves.toBeNull();
  });

  it.each([
    'platform',
    'customer',
    undefined,
  ])('rejects service-only bindings on a %s human identity', async (identityKind) => {
    const verify = createJwtVerifier({ issuer: ISSUER, keyResolver: resolver });
    const token = await mint(
      {
        ...(identityKind === undefined ? {} : { noodle_identity: identityKind }),
        noodle_service_grant_id: 'spg_1',
        noodle_service_credential_id: 'spc_1',
      },
      { audience: RESOURCE },
    );

    await expect(verify(token, RESOURCE)).resolves.toBeNull();
  });

  it.each([
    ['grant', { noodle_service_grant_id: 'g'.repeat(201) }],
    ['credential', { noodle_service_credential_id: 'c'.repeat(201) }],
  ])('rejects an overlong service %s binding', async (_binding, invalidClaim) => {
    const verify = createJwtVerifier({ issuer: ISSUER, keyResolver: resolver });
    const token = await mint(
      {
        client_id: SERVICE_SUBJECT,
        noodle_identity: 'service',
        noodle_service_grant_id: 'spg_1',
        noodle_service_credential_id: 'spc_1',
        ...invalidClaim,
      },
      { audience: RESOURCE, subject: SERVICE_SUBJECT },
    );

    await expect(verify(token, RESOURCE)).resolves.toBeNull();
  });

  it('skips audience validation when no resource is supplied', async () => {
    const verify = createJwtVerifier({ issuer: ISSUER, keyResolver: resolver });
    const token = await mint({}, { audience: RESOURCE });
    expect((await verify(token))?.caller.subject).toBe('google-sub-123');
  });

  it('keeps audience-less tokens valid without a resource or configured audience requirement', async () => {
    const verify = createJwtVerifier({ issuer: ISSUER, keyResolver: resolver });

    await expect(verify(await mint({}))).resolves.toMatchObject({
      caller: { subject: 'google-sub-123' },
    });
  });

  it('throws at construction when neither jwksUri nor keyResolver is given', () => {
    expect(() => createJwtVerifier({ issuer: ISSUER })).toThrow(/jwksUri or a keyResolver/);
  });
});
