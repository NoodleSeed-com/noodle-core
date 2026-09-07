import { exportJWK, generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createClientSecret,
  digestClientSecret,
  secretDigestMatches,
  validatePublicJwk,
} from '../src/oauth/service-principal-credentials.js';

let rsaPublicJwk: Record<string, unknown>;
let ecPublicJwk: Record<string, unknown>;

beforeAll(async () => {
  const rsa = await generateKeyPair('RS256', { modulusLength: 2048 });
  rsaPublicJwk = await exportJWK(rsa.publicKey);
  const ec = await generateKeyPair('ES256');
  ecPublicJwk = await exportJWK(ec.publicKey);
});

describe('service-principal credential material', () => {
  it('creates a 256-bit show-once secret and stores only its digest', () => {
    const secret = createClientSecret();
    const digest = digestClientSecret(secret);

    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(secret, 'base64url')).toHaveLength(32);
    expect(digest).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(digest).not.toBe(secret);
    expect(secretDigestMatches(secret, digest)).toBe(true);
    expect(secretDigestMatches(`${secret}x`, digest)).toBe(false);
    expect(secretDigestMatches(secret, 'malformed')).toBe(false);
  });

  it.each([
    ['RS256', () => rsaPublicJwk],
    ['ES256', () => ecPublicJwk],
  ] as const)('accepts a public %s verification key without requiring kid', async (algorithm, key) => {
    await expect(validatePublicJwk(key(), algorithm)).resolves.toMatchObject({
      algorithm,
      publicJwk: expect.not.objectContaining({ d: expect.anything() }),
    });
  });

  it.each([
    'd',
    'p',
    'q',
    'dp',
    'dq',
    'qi',
    'oth',
    'k',
  ])('rejects private or symmetric JWK member %s', async (member) => {
    await expect(
      validatePublicJwk({ ...rsaPublicJwk, [member]: 'private-material' }, 'RS256'),
    ).rejects.toThrow(/public JWK/i);
  });

  it.each([
    ['a symmetric algorithm', { kty: 'oct', k: 'c2VjcmV0', alg: 'HS256' }, 'HS256'],
    ['the none algorithm', rsaPublicJwk, 'none'],
    [
      'a weak RSA modulus',
      { kty: 'RSA', n: Buffer.alloc(128, 1).toString('base64url'), e: 'AQAB' },
      'RS256',
    ],
    ['the wrong EC curve', { ...ecPublicJwk, crv: 'P-384' }, 'ES256'],
    ['an incompatible key type', rsaPublicJwk, 'ES256'],
    ['an incompatible declared algorithm', { ...rsaPublicJwk, alg: 'ES256' }, 'RS256'],
    ['signing key operations', { ...rsaPublicJwk, key_ops: ['sign'] }, 'RS256'],
  ])('rejects %s', async (_case, key, algorithm) => {
    await expect(validatePublicJwk(key, algorithm)).rejects.toThrow(/JWK|algorithm|RSA|EC/i);
  });

  it('rejects oversized JWK JSON and overlong key ids', async () => {
    await expect(
      validatePublicJwk({ ...rsaPublicJwk, padding: 'x'.repeat(16_384) }, 'RS256'),
    ).rejects.toThrow(/16 KiB/i);
    await expect(
      validatePublicJwk({ ...rsaPublicJwk, kid: 'k'.repeat(201) }, 'RS256'),
    ).rejects.toThrow(/kid/i);
  });
});
