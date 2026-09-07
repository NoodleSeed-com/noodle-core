import { createJwtVerifier, createStaticSigningKeyProvider } from '@noodle-borg/auth';
import { jwtVerify } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import { ManagedConfigBroker } from '../src/credential-broker.js';
import { createHostedCustomerVerifierFactory } from '../src/customer-verifier.js';
import { InMemoryOAuthStore } from '../src/oauth/store.js';
import { OAuthTokenIssuer } from '../src/oauth/token-issuer.js';
import { InMemoryConfigStore, type TenantBridgeAuthConfig } from '../src/store.js';
import { credentialBrokerScope } from './credential-broker-fixtures.js';

const PLATFORM_ISSUER = 'https://cloud.test';
const RESOURCE = 'https://cloud.test/o/acme/demo/mcp';
const TOKEN_AUDIENCE = 'customer-api';
const BRIDGE_CASES = [
  {
    provider: 'firebase' as const,
    auth: {
      kind: 'bridge' as const,
      provider: 'firebase' as const,
      projectId: 'customer-project',
    },
    customerIssuer: 'https://securetoken.google.com/customer-project',
  },
  {
    provider: 'microsoft' as const,
    auth: {
      kind: 'bridge' as const,
      provider: 'microsoft' as const,
      tenantId: 'tenant-1',
      clientId: 'client-1',
      clientSecret: 'MICROSOFT_CLIENT_SECRET',
    },
    customerIssuer: 'https://login.microsoftonline.com/tenant-1/v2.0',
  },
] satisfies readonly {
  readonly provider: 'firebase' | 'microsoft';
  readonly auth: TenantBridgeAuthConfig;
  readonly customerIssuer: string;
}[];

describe('managed customer bridge delegated token exchange', () => {
  it.each(
    BRIDGE_CASES,
  )('binds the verified $provider issuer into the downstream customer identity', async ({
    auth,
    customerIssuer,
    provider,
  }) => {
    const signer = await createStaticSigningKeyProvider();
    const oauthStore = new InMemoryOAuthStore();
    const tokenIssuer = new OAuthTokenIssuer({
      store: oauthStore,
      signer,
      issuer: PLATFORM_ISSUER,
      accessTtl: 3_600,
      refreshTtl: 86_400,
      codeTtl: 600,
      nowSeconds: () => 1_700_000_000,
    });
    const bridgeTokens = await tokenIssuer.issueTokens({
      clientId: 'mcp-client',
      ownerSubject: `${provider}-customer-subject`,
      resource: RESOURCE,
      identityKind: 'customer',
      identityProvider: provider,
      customerIssuer,
    });
    const platformVerifier = createJwtVerifier({
      issuer: PLATFORM_ISSUER,
      keyResolver: await signer.verifierKey(),
    });
    const resolveBridgeAuth = vi.fn(async () => auth);
    const hostedVerifier = createHostedCustomerVerifierFactory(
      () => async () => null,
      platformVerifier,
      { resolveBridgeAuth },
    )(auth);
    const verified = await hostedVerifier(bridgeTokens.access_token, RESOURCE);
    if (verified === null) throw new Error('expected the bridge token to verify');

    const configStore = new InMemoryConfigStore();
    await configStore.setConfigValue({
      kind: 'secret',
      scope: credentialBrokerScope,
      name: 'CUSTOMER_EXCHANGE_SECRET',
      value: 'exchange-client-secret',
    });
    const exchangeRequests: URLSearchParams[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      exchangeRequests.push(new URLSearchParams(String(init?.body)));
      return Response.json({
        access_token: `${provider}-downstream-token`,
        token_type: 'Bearer',
        expires_in: 900,
      });
    }) as unknown as typeof fetch;
    const broker = new ManagedConfigBroker(
      [
        {
          connectorId: 'customer_api',
          connectorVersion: '1.0.0',
          authKind: 'delegatedTokenExchange',
          secretRef: 'CUSTOMER_EXCHANGE_SECRET',
          tokenExchange: {
            tokenUrl: 'https://customer.example/oauth/token',
            clientId: 'exchange-client',
            audience: TOKEN_AUDIENCE,
            authMethod: 'client_secret_basic',
          },
        },
      ],
      configStore,
      credentialBrokerScope,
      {
        delegatedExchange: {
          issuer: PLATFORM_ISSUER,
          signer,
          tenant: 'acme/demo/prod',
          deployment: 'deployment-1',
        },
        fetchImpl,
      },
    );

    await expect(
      broker.getCredential({
        connectorId: 'customer_api',
        connectorVersion: '1.0.0',
        operation: 'read',
        caller: verified.caller,
        customerIssuer: verified.customerIssuer,
      }),
    ).resolves.toEqual({ token: `${provider}-downstream-token` });

    expect(resolveBridgeAuth).toHaveBeenCalledWith(auth, RESOURCE);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const subjectToken = exchangeRequests[0]?.get('subject_token');
    expect(subjectToken).toBeTruthy();
    expect(subjectToken).not.toBe(bridgeTokens.access_token);
    expect(exchangeRequests[0]?.toString()).not.toContain(bridgeTokens.access_token);
    const { payload } = await jwtVerify(subjectToken as string, await signer.verifierKey(), {
      issuer: PLATFORM_ISSUER,
      audience: TOKEN_AUDIENCE,
      currentDate: new Date(1_700_000_000_000),
    });
    expect(payload.sub).toBe(`${provider}-customer-subject`);
    expect(payload.customer_identity).toEqual({ version: 1, issuer: customerIssuer });
  });

  it('keeps a legacy issuer-less bridge session fail-closed before config, signing, or fetch', async () => {
    const signer = await createStaticSigningKeyProvider();
    const platformVerifier = createJwtVerifier({
      issuer: PLATFORM_ISSUER,
      keyResolver: await signer.verifierKey(),
    });
    const tokenIssuer = new OAuthTokenIssuer({
      store: new InMemoryOAuthStore(),
      signer,
      issuer: PLATFORM_ISSUER,
      accessTtl: 3_600,
      refreshTtl: 86_400,
      codeTtl: 600,
      nowSeconds: () => 1_700_000_000,
    });
    const legacy = await tokenIssuer.issueTokens({
      clientId: 'mcp-client',
      ownerSubject: 'legacy-customer',
      resource: RESOURCE,
      identityKind: 'customer',
      identityProvider: 'firebase',
    });
    const resolveBridgeAuth = vi.fn(async () => BRIDGE_CASES[0].auth);
    const verified = await createHostedCustomerVerifierFactory(
      () => async () => null,
      platformVerifier,
      { resolveBridgeAuth },
    )(BRIDGE_CASES[0].auth)(legacy.access_token, RESOURCE);
    if (verified === null) throw new Error('expected the legacy bridge token to verify');

    const configStore = new InMemoryConfigStore();
    const resolveConfig = vi.spyOn(configStore, 'resolveConfigValues');
    const signingKey = vi.spyOn(signer, 'signingKey');
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const broker = new ManagedConfigBroker(
      [
        {
          connectorId: 'customer_api',
          connectorVersion: '1.0.0',
          authKind: 'delegatedTokenExchange',
          secretRef: 'CUSTOMER_EXCHANGE_SECRET',
          tokenExchange: {
            tokenUrl: 'https://customer.example/oauth/token',
            clientId: 'exchange-client',
            audience: TOKEN_AUDIENCE,
            authMethod: 'client_secret_basic',
          },
        },
      ],
      configStore,
      credentialBrokerScope,
      {
        delegatedExchange: {
          issuer: PLATFORM_ISSUER,
          signer,
          tenant: 'acme/demo/prod',
          deployment: 'deployment-1',
        },
        fetchImpl,
      },
    );

    await expect(
      broker.getCredential({
        connectorId: 'customer_api',
        connectorVersion: '1.0.0',
        operation: 'read',
        caller: verified.caller,
      }),
    ).rejects.toMatchObject({
      reason: 'caller_issuer_missing',
      fix: 'Reconnect through the configured customer authentication flow so Noodle can bind the verified issuer.',
    });
    expect(resolveBridgeAuth).not.toHaveBeenCalled();
    expect(resolveConfig).not.toHaveBeenCalled();
    expect(signingKey).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
