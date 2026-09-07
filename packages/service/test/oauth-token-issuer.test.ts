import { createJwtVerifier, createStaticSigningKeyProvider } from '@noodle-borg/auth';
import { describe, expect, it } from 'vitest';
import { issueDeviceTokens } from '../src/oauth/device-provider.js';
import { InMemoryOAuthStore } from '../src/oauth/store.js';
import { OAuthTokenIssuer } from '../src/oauth/token-issuer.js';
import { hashToken } from '../src/oauth/tokens.js';

const ISSUER = 'https://as.noodle.test';
const RESOURCE = 'https://cloud.noodle.test/o/acme/support/mcp';

describe('customer bridge token issuance', () => {
  it('preserves trusted roles and clamps access and refresh lifetime to upstream expiry', async () => {
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const upstreamExpiresAt = nowSeconds + 120;
    const signer = await createStaticSigningKeyProvider();
    const store = new InMemoryOAuthStore();
    const issuer = new OAuthTokenIssuer({
      store,
      signer,
      issuer: ISSUER,
      accessTtl: 3_600,
      refreshTtl: 86_400,
      codeTtl: 600,
      nowSeconds: () => nowSeconds,
    });

    const tokens = await issuer.issueTokens({
      clientId: 'mcp-client',
      ownerSubject: 'customer-123',
      resource: RESOURCE,
      roles: ['admin', 'support'],
      upstreamExpiresAt,
      identityKind: 'customer',
      identityProvider: 'microsoft',
      customerIssuer: 'https://login.microsoftonline.com/tenant-1/v2.0',
    });

    expect(tokens.expires_in).toBe(120);
    const verify = createJwtVerifier({
      issuer: ISSUER,
      keyResolver: await signer.verifierKey(),
    });
    await expect(verify(tokens.access_token, RESOURCE)).resolves.toMatchObject({
      caller: { roles: ['admin', 'support'] },
      customerIssuer: 'https://login.microsoftonline.com/tenant-1/v2.0',
    });
    await expect(
      store.getRefreshToken(hashToken(tokens.refresh_token as string)),
    ).resolves.toMatchObject({
      roles: ['admin', 'support'],
      upstreamExpiresAt,
      customerIssuer: 'https://login.microsoftonline.com/tenant-1/v2.0',
      expiresAt: upstreamExpiresAt,
    });
  });

  it('requires fresh upstream authentication after the verified assertion expires', async () => {
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const issuer = new OAuthTokenIssuer({
      store: new InMemoryOAuthStore(),
      signer: await createStaticSigningKeyProvider(),
      issuer: ISSUER,
      accessTtl: 3_600,
      refreshTtl: 86_400,
      codeTtl: 600,
      nowSeconds: () => nowSeconds,
    });

    await expect(
      issuer.issueTokens({
        clientId: 'mcp-client',
        ownerSubject: 'customer-123',
        resource: RESOURCE,
        roles: ['admin'],
        upstreamExpiresAt: nowSeconds,
        identityKind: 'customer',
        identityProvider: 'firebase',
      }),
    ).rejects.toThrow(/upstream identity has expired/);
  });

  it('preserves the customer issuer when an approved device flow issues tokens', async () => {
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const signer = await createStaticSigningKeyProvider();
    const store = new InMemoryOAuthStore();
    const issuer = new OAuthTokenIssuer({
      store,
      signer,
      issuer: ISSUER,
      accessTtl: 3_600,
      refreshTtl: 86_400,
      codeTtl: 600,
      nowSeconds: () => nowSeconds,
    });

    const tokens = await issueDeviceTokens({
      tokenIssuer: issuer,
      record: {
        deviceCode: 'device-code',
        userCode: 'user-code',
        clientId: 'mcp-client',
        resource: RESOURCE,
        status: 'approved',
        ownerSubject: 'customer-123',
        identityKind: 'customer',
        identityProvider: 'firebase',
        customerIssuer: 'https://securetoken.google.com/customer-project',
        expiresAt: nowSeconds + 600,
        nextPollAt: nowSeconds,
        intervalSeconds: 5,
      },
    });

    const verify = createJwtVerifier({
      issuer: ISSUER,
      keyResolver: await signer.verifierKey(),
    });
    await expect(verify(tokens.access_token, RESOURCE)).resolves.toMatchObject({
      customerIssuer: 'https://securetoken.google.com/customer-project',
    });
  });
});
