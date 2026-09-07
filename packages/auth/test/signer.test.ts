import { exportPKCS8, generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  createJwtVerifier,
  createStaticSigningKeyProvider,
  mintAccessToken,
} from '../src/index.js';

const ISSUER = 'https://borg.test';
const RESOURCE = 'https://borg.test/o/acme/support/mcp';

describe('signing key + access-token mint (OA-2)', () => {
  it('mints a token that the OA-1 verifier accepts (the closed loop)', async () => {
    const provider = await createStaticSigningKeyProvider();
    const verify = createJwtVerifier({ issuer: ISSUER, keyResolver: await provider.verifierKey() });

    const token = await mintAccessToken(
      provider,
      {
        issuer: ISSUER,
        subject: 'google-sub-1',
        audience: RESOURCE,
        email: 'owner@noodleseed.com',
        locale: 'en-GB',
        timeZone: 'Europe/London',
        scope: 'mcp',
      },
      3600,
    );

    const id = (await verify(token, RESOURCE))?.caller;
    expect(id).not.toBeNull();
    expect(id?.subject).toBe('google-sub-1');
    expect(id?.audience).toBe(RESOURCE);
    expect(id?.email).toBe('owner@noodleseed.com');
    expect(id?.locale).toBe('en-GB');
    expect(id?.timeZone).toBe('Europe/London');
    expect(id?.scopes).toEqual(['mcp']);
    expect(typeof id?.expiresAt).toBe('number');
  });

  it('binds the token to its resource — a different resource is rejected', async () => {
    const provider = await createStaticSigningKeyProvider();
    const verify = createJwtVerifier({ issuer: ISSUER, keyResolver: await provider.verifierKey() });
    const token = await mintAccessToken(
      provider,
      { issuer: ISSUER, subject: 'google-sub-1', audience: RESOURCE },
      3600,
    );
    expect(await verify(token, 'https://borg.test/o/other/app/mcp')).toBeNull();
  });

  it('round-trips an opaque developer grant and OAuth client binding', async () => {
    const provider = await createStaticSigningKeyProvider();
    const verify = createJwtVerifier({ issuer: ISSUER, keyResolver: await provider.verifierKey() });
    const token = await mintAccessToken(
      provider,
      {
        issuer: ISSUER,
        subject: 'google-sub-1',
        audience: RESOURCE,
        developerGrantId: 'grant-1',
        oauthClientId: 'client-1',
      },
      3600,
    );

    await expect(verify(token, RESOURCE)).resolves.toMatchObject({
      caller: {
        subject: 'google-sub-1',
        developerGrantId: 'grant-1',
        oauthClientId: 'client-1',
      },
    });
  });

  it('rejects an expired token', async () => {
    const provider = await createStaticSigningKeyProvider();
    const verify = createJwtVerifier({ issuer: ISSUER, keyResolver: await provider.verifierKey() });
    const token = await mintAccessToken(
      provider,
      { issuer: ISSUER, subject: 'google-sub-1', audience: RESOURCE },
      -60,
    );
    expect(await verify(token, RESOURCE)).toBeNull();
  });

  it("rejects a token signed by a different provider's key", async () => {
    const signer = await createStaticSigningKeyProvider();
    const other = await createStaticSigningKeyProvider();
    const verify = createJwtVerifier({ issuer: ISSUER, keyResolver: await other.verifierKey() });
    const token = await mintAccessToken(
      signer,
      { issuer: ISSUER, subject: 'google-sub-1', audience: RESOURCE },
      3600,
    );
    expect(await verify(token, RESOURCE)).toBeNull();
  });

  it('imports a PKCS#8 PEM key and mints a verifiable token (production custody path)', async () => {
    const pair = await generateKeyPair('RS256', { extractable: true });
    const privateKeyPem = await exportPKCS8(pair.privateKey);
    const provider = await createStaticSigningKeyProvider({ privateKeyPem });
    const verify = createJwtVerifier({ issuer: ISSUER, keyResolver: await provider.verifierKey() });
    const token = await mintAccessToken(
      provider,
      { issuer: ISSUER, subject: 'google-sub-2', audience: RESOURCE },
      3600,
    );
    expect((await verify(token, RESOURCE))?.caller.subject).toBe('google-sub-2');
  });

  it('publishes a JWKS with public members only (no private fields), a stable kid, and RS256/use=sig', async () => {
    const provider = await createStaticSigningKeyProvider();
    const jwks = await provider.publicJwks();
    expect(jwks.keys).toHaveLength(1);
    const jwk = jwks.keys[0];
    expect(jwk?.kty).toBe('RSA');
    expect(jwk?.alg).toBe('RS256');
    expect(jwk?.use).toBe('sig');
    expect(typeof jwk?.kid).toBe('string');
    // Never leak private RSA fields.
    for (const priv of ['d', 'p', 'q', 'dp', 'dq', 'qi']) {
      expect(jwk).not.toHaveProperty(priv);
    }
    // The token header kid matches the published kid.
    expect((await provider.signingKey()).kid).toBe(jwk?.kid);
  });
});
