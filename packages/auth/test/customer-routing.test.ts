import type { JWTVerifyGetKey } from 'jose';
import { generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { createJwtVerifier } from '../src/index.js';

const ISSUER = 'https://idp.noodleseed.dev';
const RESOURCE = 'https://acme.cloud.noodleseed.dev/support/prod/mcp';

let privateKey: CryptoKey;
let keyResolver: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair('ES256');
  privateKey = pair.privateKey;
  keyResolver = (async () => pair.publicKey) as JWTVerifyGetKey;
});

async function mint(
  claims: Record<string, unknown>,
  audience: string | string[] = RESOURCE,
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer(ISSUER)
    .setSubject('customer-123')
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}

describe('JWT customer routing projection', () => {
  it('projects an exact own-property nested string outside the public caller', async () => {
    const verify = createJwtVerifier({
      issuer: ISSUER,
      keyResolver,
      customerRoutingClaims: { customer_api: 'tenant.api_base_url' },
    });
    const result = await verify(
      await mint({ tenant: { api_base_url: ' https://tenant.api.noodleseed.dev/v1 ' } }),
      RESOURCE,
    );

    expect(result).not.toBeNull();
    expect(result?.customerRouting).toEqual({
      customer_api: ' https://tenant.api.noodleseed.dev/v1 ',
    });
    expect(result?.caller).toMatchObject({
      subject: 'customer-123',
      audience: RESOURCE,
    });
    expect(JSON.stringify(result?.caller)).not.toContain('tenant.api.noodleseed.dev');
  });

  it.each([
    ['missing', {}],
    ['empty', { tenant: { api_base_url: '' } }],
    ['non-string', { tenant: { api_base_url: 42 } }],
    ['oversized UTF-8', { tenant: { api_base_url: '🙂'.repeat(513) } }],
    ['inherited', { tenant: Object.create({ api_base_url: 'https://evil.invalid' }) }],
  ])('omits a %s route while preserving the verified caller', async (_name, claims) => {
    const verify = createJwtVerifier({
      issuer: ISSUER,
      keyResolver,
      customerRoutingClaims: { customer_api: 'tenant.api_base_url' },
    });
    const result = await verify(await mint(claims), RESOURCE);

    expect(result?.caller.subject).toBe('customer-123');
    expect(result).not.toHaveProperty('customerRouting');
  });

  it('accepts exactly 2,048 UTF-8 bytes and rejects a multibyte overflow', async () => {
    const verify = createJwtVerifier({
      issuer: ISSUER,
      keyResolver,
      customerRoutingClaims: { customer_api: 'route' },
    });

    await expect(verify(await mint({ route: 'a'.repeat(2_048) }), RESOURCE)).resolves.toMatchObject(
      {
        customerRouting: { customer_api: 'a'.repeat(2_048) },
      },
    );
    await expect(
      verify(await mint({ route: `${'a'.repeat(2_047)}é` }), RESOURCE),
    ).resolves.not.toHaveProperty('customerRouting');
  });

  it.each([
    ['no mapping', undefined],
    ['empty mapping', {}],
  ])('omits customer routing when configured with %s', async (_name, customerRoutingClaims) => {
    const verify = createJwtVerifier({
      issuer: ISSUER,
      keyResolver,
      ...(customerRoutingClaims === undefined ? {} : { customerRoutingClaims }),
    });

    await expect(
      verify(await mint({ route: 'https://tenant.api.noodleseed.dev' }), RESOURCE),
    ).resolves.not.toHaveProperty('customerRouting');
  });

  it('rejects the exact resource and configured audience before route projection', async () => {
    let projections = 0;
    const customerRoutingClaims = new Proxy(
      { customer_api: 'tenant.api_base_url' },
      {
        ownKeys(target) {
          projections += 1;
          return Reflect.ownKeys(target);
        },
      },
    );
    const verify = createJwtVerifier({
      issuer: ISSUER,
      keyResolver,
      requiredAudiences: ['customer-api'],
      customerRoutingClaims,
    });
    const claims = {
      tenant: { api_base_url: 'https://tenant.api.noodleseed.dev' },
    };

    await expect(
      verify(
        await mint(claims, ['customer-api', 'https://other.cloud.noodleseed.dev/mcp']),
        RESOURCE,
      ),
    ).resolves.toBeNull();
    await expect(verify(await mint(claims, RESOURCE), RESOURCE)).resolves.toBeNull();
    expect(projections).toBe(0);
  });

  it('preserves __proto__ as an own key without mutating prototypes', async () => {
    const routeClaims = Object.create(null) as Record<string, string>;
    routeClaims.__proto__ = 'tenant.api_base_url';
    const tenant = Object.create(null) as Record<string, string>;
    tenant.api_base_url = 'https://customer.api.noodleseed.dev/base';
    const verify = createJwtVerifier({
      issuer: ISSUER,
      keyResolver,
      customerRoutingClaims: routeClaims,
    });

    const result = await verify(await mint({ tenant }), RESOURCE);

    expect(Object.getPrototypeOf(result?.customerRouting)).toBeNull();
    expect(Object.hasOwn(result?.customerRouting ?? {}, '__proto__')).toBe(true);
    expect(result?.customerRouting?.__proto__).toBe('https://customer.api.noodleseed.dev/base');
    expect({}).not.toHaveProperty('api_base_url');
  });
});
