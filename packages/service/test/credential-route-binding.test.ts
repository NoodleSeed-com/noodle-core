import type { CustomerRouteBinding } from '@noodle-borg/runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagedConfigBroker } from '../src/credential-broker.js';
import { InMemoryOAuthStore } from '../src/oauth/store.js';
import { InMemoryConfigStore, type SecretEnvelope } from '../src/store.js';
import { credentialBrokerScope as scope } from './credential-broker-fixtures.js';

const routeFingerprintA = `sha256:${'a'.repeat(64)}`;
const routeFingerprintB = `sha256:${'b'.repeat(64)}`;
const routeA = {
  key: 'customer_api',
  fingerprint: routeFingerprintA,
} as const satisfies CustomerRouteBinding;
const routeOtherKey = {
  key: 'other_api',
  fingerprint: routeA.fingerprint,
} as const satisfies CustomerRouteBinding;
const routeOtherFingerprint = {
  key: routeA.key,
  fingerprint: routeFingerprintB,
} as const satisfies CustomerRouteBinding;

const caller = {
  subject: 'customer-user-1',
  audience: 'https://cloud.test/o/acme/demo/mcp',
  identityKind: 'customer' as const,
  identityProvider: 'firebase',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ManagedConfigBroker customer route cache binding', () => {
  it('isolates client-credentials cache entries by route fingerprint', async () => {
    const config = new InMemoryConfigStore();
    await config.setConfigValue({
      kind: 'secret',
      scope,
      name: 'CLIENT_SECRET',
      value: 'client-secret',
    });
    const fetchImpl = vi.fn(async () =>
      Response.json({
        access_token: `client-token-${fetchImpl.mock.calls.length}`,
        expires_in: 3_600,
      }),
    ) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchImpl);
    const broker = new ManagedConfigBroker(
      [
        {
          connectorId: 'customer_api',
          connectorVersion: '1.0.0',
          operation: 'list_records',
          customerEndpoint: 'customer_api',
          authKind: 'clientCredentials',
          secretRef: 'CLIENT_SECRET',
          clientCredentials: {
            profile: 'oauth2',
            tokenUrl: 'https://identity.test/oauth/token',
            clientId: 'client-id',
          },
        },
      ],
      config,
      scope,
    );
    const request = {
      connectorId: 'customer_api',
      connectorVersion: '1.0.0',
      operation: 'list_records',
    };

    await expect(broker.getCredential({ ...request, route: routeA })).resolves.toEqual({
      token: 'client-token-1',
    });
    await expect(broker.getCredential({ ...request, route: routeA })).resolves.toEqual({
      token: 'client-token-1',
    });
    await expect(
      broker.getCredential({ ...request, route: routeOtherFingerprint }),
    ).resolves.toEqual({ token: 'client-token-2' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('isolates Firebase delegated bearer cache entries by route', async () => {
    const delegated = new InMemoryOAuthStore();
    const credential: SecretEnvelope = {
      enc: 'none',
      values: { token: 'firebase-refresh-1' },
    };
    await delegated.putDelegatedCredential({
      resource: caller.audience,
      provider: 'firebase',
      subject: caller.subject,
      credential,
      updatedAt: new Date(0).toISOString(),
    });
    const fetchImpl = vi.fn(async () =>
      Response.json({
        id_token: `firebase-id-${fetchImpl.mock.calls.length}`,
        refresh_token: 'firebase-refresh-1',
        expires_in: '3600',
      }),
    ) as unknown as typeof fetch;
    const broker = new ManagedConfigBroker(
      [
        {
          connectorId: 'customer_api',
          connectorVersion: '1.0.0',
          operation: 'list_records',
          customerEndpoint: 'customer_api',
          authKind: 'delegatedOAuth',
          delegated: { provider: 'firebase' },
        },
      ],
      new InMemoryConfigStore(),
      scope,
      {
        delegatedCredentialStore: delegated,
        serverAuth: {
          kind: 'bridge',
          provider: 'firebase',
          projectId: 'firebase-project',
          apiKey: 'firebase-api-key',
        },
        openCustomerCredential: async (sealed) => sealed.values.token ?? '',
        fetchImpl,
        now: () => 1_000,
      },
    );
    const request = {
      connectorId: 'customer_api',
      connectorVersion: '1.0.0',
      operation: 'list_records',
      caller,
    };

    await expect(broker.getCredential({ ...request, route: routeA })).resolves.toEqual({
      token: 'firebase-id-1',
    });
    await expect(broker.getCredential({ ...request, route: routeA })).resolves.toEqual({
      token: 'firebase-id-1',
    });
    await expect(
      broker.getCredential({ ...request, route: routeOtherFingerprint }),
    ).resolves.toEqual({ token: 'firebase-id-2' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('isolates Microsoft delegated bearer cache entries by route', async () => {
    const delegated = new InMemoryOAuthStore();
    await delegated.putDelegatedCredential({
      resource: caller.audience,
      provider: 'microsoft',
      subject: caller.subject,
      credential: { enc: 'none', values: { token: 'microsoft-refresh-1' } },
      updatedAt: new Date(0).toISOString(),
    });
    const config = new InMemoryConfigStore();
    await config.setConfigValue({
      kind: 'secret',
      scope,
      name: 'MICROSOFT_SECRET',
      value: 'client-secret',
    });
    const fetchImpl = vi.fn(async () =>
      Response.json({
        access_token: `microsoft-token-${fetchImpl.mock.calls.length}`,
        expires_in: 3_600,
      }),
    ) as unknown as typeof fetch;
    const broker = new ManagedConfigBroker(
      [
        {
          connectorId: 'customer_api',
          connectorVersion: '1.0.0',
          operation: 'list_records',
          customerEndpoint: 'customer_api',
          authKind: 'delegatedOAuth',
          secretRef: 'MICROSOFT_SECRET',
          delegated: {
            provider: 'microsoft',
            tokenUrl: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/token',
            clientId: 'client-id',
          },
        },
      ],
      config,
      scope,
      {
        delegatedCredentialStore: delegated,
        openCustomerCredential: async (sealed) => sealed.values.token ?? '',
        fetchImpl,
        now: () => 1_000,
      },
    );
    const microsoftCaller = {
      ...caller,
      identityProvider: 'microsoft',
    };
    const request = {
      connectorId: 'customer_api',
      connectorVersion: '1.0.0',
      operation: 'list_records',
      caller: microsoftCaller,
    };

    await broker.getCredential({ ...request, route: routeA });
    await broker.getCredential({ ...request, route: routeA });
    await broker.getCredential({ ...request, route: routeOtherFingerprint });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('isolates delegated session-cookie cache entries by route', async () => {
    const delegated = new InMemoryOAuthStore();
    await delegated.putDelegatedCredential({
      resource: caller.audience,
      provider: 'firebase',
      subject: caller.subject,
      credential: { enc: 'none', values: { token: 'firebase-refresh-1' } },
      updatedAt: new Date(0).toISOString(),
    });
    let refreshes = 0;
    let sessions = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).startsWith('https://securetoken.googleapis.com/')) {
        refreshes += 1;
        return Response.json({
          id_token: `firebase-id-${refreshes}`,
          refresh_token: 'firebase-refresh-1',
          expires_in: '3600',
        });
      }
      sessions += 1;
      return new Response('{}', {
        headers: {
          'set-cookie': `session=session-${sessions}; Path=/; Max-Age=3600; Secure; HttpOnly`,
        },
      });
    }) as unknown as typeof fetch;
    const broker = new ManagedConfigBroker(
      [
        {
          connectorId: 'customer_api',
          connectorVersion: '1.0.0',
          operation: 'list_records',
          customerEndpoint: 'customer_api',
          authKind: 'delegatedSessionCookie',
          delegated: {
            provider: 'firebase',
            sessionUrl: 'https://session.test/exchange',
          },
        },
      ],
      new InMemoryConfigStore(),
      scope,
      {
        delegatedCredentialStore: delegated,
        serverAuth: {
          kind: 'bridge',
          provider: 'firebase',
          projectId: 'firebase-project',
          apiKey: 'firebase-api-key',
        },
        openCustomerCredential: async (sealed) => sealed.values.token ?? '',
        fetchImpl,
        now: () => 1_000,
      },
    );
    const request = {
      connectorId: 'customer_api',
      connectorVersion: '1.0.0',
      operation: 'list_records',
      caller,
    };

    await broker.getCredential({ ...request, route: routeA });
    await broker.getCredential({ ...request, route: routeA });
    await broker.getCredential({ ...request, route: routeOtherFingerprint });
    expect(refreshes).toBe(2);
    expect(sessions).toBe(2);
  });

  it.each([
    ['missing', undefined],
    ['wrong-key', routeOtherKey],
    ['empty-fingerprint', { key: routeA.key, fingerprint: '' }],
    ['uppercase-fingerprint', { key: routeA.key, fingerprint: `sha256:${'A'.repeat(64)}` }],
    ['URL-fingerprint', { key: routeA.key, fingerprint: 'https://tenant.example/api' }],
    ['oversized-fingerprint', { key: routeA.key, fingerprint: 'x'.repeat(10_000) }],
  ] as const)('rejects a %s routed SecretBinding before config or network access', async (_label, route) => {
    const config = new InMemoryConfigStore();
    const resolveConfig = vi.spyOn(config, 'resolveConfigValues');
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchImpl);
    const broker = new ManagedConfigBroker(
      [
        {
          connectorId: 'customer_api',
          connectorVersion: '1.0.0',
          operation: 'list_records',
          customerEndpoint: 'customer_api',
          authKind: 'clientCredentials',
          secretRef: 'CLIENT_SECRET',
          clientCredentials: {
            profile: 'oauth2',
            tokenUrl: 'https://identity.test/oauth/token',
            clientId: 'client-id',
          },
        },
      ],
      config,
      scope,
    );
    const request = {
      connectorId: 'customer_api',
      connectorVersion: '1.0.0',
      operation: 'list_records',
      ...(route === undefined ? {} : { route }),
    };

    await expect(broker.getCredential(request)).rejects.toMatchObject({
      reason: 'connector_route_unavailable',
    });
    expect(resolveConfig).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an unexpected route on a static SecretBinding before config or network access', async () => {
    const config = new InMemoryConfigStore();
    const resolveConfig = vi.spyOn(config, 'resolveConfigValues');
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchImpl);
    const broker = new ManagedConfigBroker(
      [
        {
          connectorId: 'static_api',
          connectorVersion: '1.0.0',
          operation: 'list_records',
          authKind: 'clientCredentials',
          secretRef: 'CLIENT_SECRET',
          clientCredentials: {
            profile: 'oauth2',
            tokenUrl: 'https://identity.test/oauth/token',
            clientId: 'client-id',
          },
        },
      ],
      config,
      scope,
    );

    await expect(
      broker.getCredential({
        connectorId: 'static_api',
        connectorVersion: '1.0.0',
        operation: 'list_records',
        route: routeA,
      }),
    ).rejects.toMatchObject({ reason: 'connector_route_unavailable' });
    expect(resolveConfig).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('preserves the empty credential for a routed connector with no credential binding', async () => {
    const config = new InMemoryConfigStore();
    const resolveConfig = vi.spyOn(config, 'resolveConfigValues');
    const broker = new ManagedConfigBroker([], config, scope);

    await expect(
      broker.getCredential({
        connectorId: 'no_auth_api',
        connectorVersion: '1.0.0',
        operation: 'list_records',
        route: routeA,
      }),
    ).resolves.toEqual({ token: '' });
    expect(resolveConfig).not.toHaveBeenCalled();
  });
});
