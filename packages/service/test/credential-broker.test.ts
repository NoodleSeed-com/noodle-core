import {
  type ArtifactConnectorBinding,
  type CredentialProfile,
  computeConnectionConfigRevision,
  type RuntimeArtifact,
} from '@noodle-borg/compiler';
import { describe, expect, it, vi } from 'vitest';
import { ManagedConfigBroker } from '../src/credential-broker.js';
import { InMemoryOAuthStore } from '../src/oauth/store.js';
import { InMemoryConfigStore, type SecretEnvelope } from '../src/store.js';
import { credentialBrokerScope as scope } from './credential-broker-fixtures.js';

const credential: SecretEnvelope = { enc: 'none', values: { token: 'firebase-refresh-1' } };
const binding = {
  connectorId: 'app_api',
  connectorVersion: '1.0.0',
  authKind: 'delegatedOAuth' as const,
  delegated: { provider: 'firebase' },
};
const sessionBinding = {
  connectorId: 'app_api',
  connectorVersion: '1.0.0',
  authKind: 'delegatedSessionCookie' as const,
  delegated: {
    provider: 'firebase',
    sessionUrl: 'https://dev.noodleseed.com/api/auth/session',
    tokenField: 'idToken',
  },
};
const caller = {
  subject: 'firebase-user-1',
  audience: 'https://cloud.test/o/acme/demo/mcp',
  identityKind: 'customer' as const,
  identityProvider: 'firebase',
};
const microsoftCredential: SecretEnvelope = { enc: 'none', values: { token: 'ms-refresh-1' } };
const microsoftBinding = {
  connectorId: 'sharepoint_graph',
  connectorVersion: '1.0.0',
  authKind: 'delegatedOAuth' as const,
  secretRef: 'MS_CLIENT_SECRET',
  delegated: {
    provider: 'microsoft',
    tokenUrl: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/token',
    clientId: 'client-id',
    scopes: ['https://graph.microsoft.com/Sites.Selected'],
    authMethod: 'client_secret_post' as const,
  },
};
const microsoftCaller = {
  subject: 'aad-user-1',
  audience: 'https://cloud.test/o/acme/sharepoint/mcp',
  identityProvider: 'microsoft',
};

function boundArtifact(
  connectorBinding: ArtifactConnectorBinding,
  presentation: CredentialProfile = { kind: 'bearer' },
): RuntimeArtifact {
  return {
    artifactSchemaVersion: '0.14.0',
    resolution: 'resolved',
    source: { manifestName: 'bound', manifestVersion: '1.0.0', coreVersion: '2' },
    server: { name: 'bound', version: '1.0.0', title: 'Bound' },
    capabilities: { tools: ['search'] },
    connectorBindings: { personal: connectorBinding },
    tools: [
      {
        name: 'search',
        description: 'Search.',
        inputSchema: { type: 'object' },
        fulfilment: {
          kind: 'operation',
          args: {},
          operationRef: {
            resolved: true,
            alias: 'personal',
            connectorId: 'mail',
            connectorVersion: '1.0.0',
            operation: 'search',
            signatureHash: 'sha256v2:test',
            credentialBinding: {
              bindingId: 'personal',
              connectionId: connectorBinding.connection.id,
              connectionConfigRevision: computeConnectionConfigRevision(
                connectorBinding.connection,
              ),
              profile: connectorBinding.profile,
              presentation,
              requiredScopes: ['mail.read'],
              requiredAudience: 'mail-api',
            },
          },
        },
      },
    ],
  };
}

function boundRequest(artifact: RuntimeArtifact) {
  const fulfilment = artifact.tools[0]?.fulfilment;
  if (fulfilment?.kind !== 'operation' || !fulfilment.operationRef.resolved) {
    throw new Error('expected bound operation');
  }
  return {
    connectorId: fulfilment.operationRef.connectorId,
    connectorVersion: fulfilment.operationRef.connectorVersion,
    operation: fulfilment.operationRef.operation,
    ...fulfilment.operationRef.credentialBinding,
  };
}

describe('ManagedConfigBroker binding-scoped credentials', () => {
  it('resolves a managed secret only for the exact binding configuration', async () => {
    const configStore = new InMemoryConfigStore();
    await configStore.setConfigValue({
      kind: 'secret',
      scope,
      name: 'PERSONAL_MAIL_SECRET',
      value: 'personal-token',
    });
    const connectorBinding = {
      profile: 'delegated',
      connection: {
        id: 'personal_mail',
        source: { kind: 'managedSecret' as const, secret: 'PERSONAL_MAIL_SECRET' },
      },
    };
    const artifact = boundArtifact(connectorBinding);
    const broker = new ManagedConfigBroker([], configStore, scope, { artifact });
    const request = boundRequest(artifact);
    await expect(broker.getCredential(request)).resolves.toEqual({ token: 'personal-token' });
    await expect(
      broker.getCredential({ ...request, connectionConfigRevision: 'sha256:drifted' }),
    ).rejects.toMatchObject({ reason: 'credential_not_configured' });
  });

  it('rejects a partial binding descriptor before legacy credential lookup', async () => {
    const connectorBinding = {
      profile: 'delegated',
      connection: {
        id: 'personal_mail',
        source: { kind: 'managedSecret' as const, secret: 'PERSONAL_MAIL_SECRET' },
      },
    };
    const artifact = boundArtifact(connectorBinding);
    const request = boundRequest(artifact);
    const { bindingId: _bindingId, ...partial } = request;
    const configStore = new InMemoryConfigStore();
    await configStore.setConfigValue({
      kind: 'secret',
      scope,
      name: 'LEGACY_MAIL_SECRET',
      value: 'legacy-token',
    });
    const resolve = vi.spyOn(configStore, 'resolveConfigValues');
    const broker = new ManagedConfigBroker(
      [
        {
          connectorId: 'mail',
          connectorVersion: '1.0.0',
          operation: 'search',
          authKind: 'static',
          secretRef: 'LEGACY_MAIL_SECRET',
        },
      ],
      configStore,
      scope,
      { artifact },
    );
    resolve.mockClear();

    await expect(broker.getCredential(partial)).rejects.toMatchObject({
      reason: 'credential_not_configured',
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('does not expose a missing managed reference in its diagnostic', async () => {
    const connectorBinding = {
      profile: 'delegated',
      connection: {
        id: 'personal_mail',
        source: { kind: 'managedSecret' as const, secret: 'PRIVATE_REFERENCE_NAME' },
      },
    };
    const artifact = boundArtifact(connectorBinding);
    const broker = new ManagedConfigBroker([], new InMemoryConfigStore(), scope, { artifact });
    const error = await broker
      .getCredential({
        ...boundRequest(artifact),
      })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ reason: 'credential_not_configured' });
    expect(String(error)).not.toContain('PRIVATE_REFERENCE_NAME');
  });

  it.each([
    ['connectorId', { connectorId: 'other' }],
    ['connectorVersion', { connectorVersion: '2.0.0' }],
    ['operation', { operation: 'send' }],
    ['bindingId', { bindingId: 'work' }],
    ['connectionId', { connectionId: 'work_mail' }],
    ['connectionConfigRevision', { connectionConfigRevision: 'sha256:drifted' }],
    ['profile', { profile: 'other' }],
    ['presentation', { presentation: { kind: 'apiKey', header: 'X-Key' } }],
    ['requiredScopes', { requiredScopes: ['mail.write'] }],
    ['requiredAudience', { requiredAudience: 'other-api' }],
  ])('rejects mutated exact descriptor field %s before secret access', async (_field, mutation) => {
    const connectorBinding = {
      profile: 'delegated',
      connection: {
        id: 'personal_mail',
        source: { kind: 'managedSecret' as const, secret: 'PERSONAL_MAIL_SECRET' },
      },
    };
    const artifact = boundArtifact(connectorBinding);
    const configStore = new InMemoryConfigStore();
    const resolve = vi.spyOn(configStore, 'resolveConfigValues');
    const broker = new ManagedConfigBroker([], configStore, scope, { artifact });
    resolve.mockClear();
    await expect(
      broker.getCredential({ ...boundRequest(artifact), ...mutation }),
    ).rejects.toMatchObject({
      reason: 'credential_not_configured',
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('fails closed for binding-scoped clientCredentials before secret access or network', async () => {
    const connectorBinding = {
      profile: 'service',
      connection: {
        id: 'service_mail',
        source: {
          kind: 'clientCredentials' as const,
          tokenUrl: '${env.UNTRUSTED_TOKEN_URL}',
          clientId: '${env.CLIENT_ID}',
          clientSecret: 'CLIENT_SECRET',
        },
      },
    };
    const artifact = boundArtifact(connectorBinding);
    const configStore = new InMemoryConfigStore();
    const resolve = vi.spyOn(configStore, 'resolveConfigValues');
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const broker = new ManagedConfigBroker([], configStore, scope, { artifact, fetchImpl });
    await expect(broker.getCredential(boundRequest(artifact))).rejects.toMatchObject({
      reason: 'credential_not_configured',
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports each externalExchange binding operation as unavailable until provider support lands', async () => {
    const connectorBinding = {
      profile: 'delegated',
      connection: { id: 'personal_mail', source: { kind: 'externalExchange' as const } },
    };
    const artifact = boundArtifact(connectorBinding);
    const broker = new ManagedConfigBroker([], new InMemoryConfigStore(), scope, { artifact });
    await expect(broker.probeDelegatedCredentials?.(caller)).resolves.toEqual([
      expect.objectContaining({
        bindingId: 'personal',
        connectionId: 'personal_mail',
        operation: 'search',
        authKind: 'externalExchange',
        ok: false,
        reason: 'credential_not_configured',
      }),
    ]);
  });
});

describe('ManagedConfigBroker delegated credentials', () => {
  it('refreshes a stored Firebase customer credential into a downstream bearer token', async () => {
    const store = new InMemoryOAuthStore();
    await store.putDelegatedCredential({
      resource: caller.audience,
      provider: 'firebase',
      subject: caller.subject,
      credential,
      updatedAt: new Date(0).toISOString(),
    });
    const fetchImpl = vi.fn(async () =>
      Response.json({
        id_token: 'firebase-id-token-1',
        refresh_token: 'firebase-refresh-2',
        expires_in: '3600',
      }),
    ) as unknown as typeof fetch;
    const broker = new ManagedConfigBroker([binding], new InMemoryConfigStore(), scope, {
      delegatedCredentialStore: store,
      serverAuth: {
        kind: 'bridge',
        provider: 'firebase',
        projectId: 'noodleseed-prod',
        apiKey: 'firebase-api-key',
      },
      openCustomerCredential: async (sealed) => sealed.values.token ?? '',
      sealCustomerCredential: async (token) => ({ enc: 'none', values: { token } }),
      fetchImpl,
      now: () => 1_000,
    });

    await expect(
      broker.getCredential({
        connectorId: 'app_api',
        connectorVersion: '1.0.0',
        operation: 'get_app',
        caller,
      }),
    ).resolves.toEqual({ token: 'firebase-id-token-1' });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://securetoken.googleapis.com/v1/token?key=firebase-api-key');
    expect(init.body).toBe('grant_type=refresh_token&refresh_token=firebase-refresh-1');
    await expect(
      store.getDelegatedCredential({
        resource: caller.audience,
        provider: 'firebase',
        subject: caller.subject,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        credential: { enc: 'none', values: { token: 'firebase-refresh-2' } },
      }),
    );
  });

  it('reuses cached Firebase ID tokens while they are fresh', async () => {
    const store = new InMemoryOAuthStore();
    await store.putDelegatedCredential({
      resource: caller.audience,
      provider: 'firebase',
      subject: caller.subject,
      credential,
      updatedAt: new Date(0).toISOString(),
    });
    const fetchImpl = vi.fn(async () =>
      Response.json({
        id_token: 'firebase-id-token-1',
        refresh_token: 'firebase-refresh-1',
        expires_in: '3600',
      }),
    ) as unknown as typeof fetch;
    const broker = new ManagedConfigBroker([binding], new InMemoryConfigStore(), scope, {
      delegatedCredentialStore: store,
      serverAuth: {
        kind: 'bridge',
        provider: 'firebase',
        projectId: 'noodleseed-prod',
        apiKey: 'firebase-api-key',
      },
      openCustomerCredential: async (sealed) => sealed.values.token ?? '',
      fetchImpl,
      now: () => 1_000,
    });

    await broker.getCredential({
      connectorId: 'app_api',
      connectorVersion: '1.0.0',
      operation: 'get_app',
      caller,
    });
    await broker.getCredential({
      connectorId: 'app_api',
      connectorVersion: '1.0.0',
      operation: 'get_app',
      caller,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refreshes a stored Microsoft delegated credential into a downstream Graph bearer token', async () => {
    const delegatedStore = new InMemoryOAuthStore();
    await delegatedStore.putDelegatedCredential({
      resource: microsoftCaller.audience,
      provider: 'microsoft',
      subject: microsoftCaller.subject,
      credential: microsoftCredential,
      updatedAt: new Date(0).toISOString(),
    });
    const configStore = new InMemoryConfigStore();
    await configStore.setConfigValue({
      kind: 'secret',
      scope,
      name: 'MS_CLIENT_SECRET',
      value: 'client-secret',
    });
    const fetchImpl = vi.fn(async () =>
      Response.json({
        access_token: 'graph-token-1',
        refresh_token: 'ms-refresh-2',
        expires_in: '3600',
      }),
    ) as unknown as typeof fetch;
    const broker = new ManagedConfigBroker([microsoftBinding], configStore, scope, {
      delegatedCredentialStore: delegatedStore,
      openCustomerCredential: async (sealed) => sealed.values.token ?? '',
      sealCustomerCredential: async (token) => ({ enc: 'none', values: { token } }),
      fetchImpl,
      now: () => 1_000,
    });

    await expect(
      broker.getCredential({
        connectorId: 'sharepoint_graph',
        connectorVersion: '1.0.0',
        operation: 'list_children',
        caller: microsoftCaller,
      }),
    ).resolves.toEqual({ token: 'graph-token-1' });

    await expect(
      broker.getCredential({
        connectorId: 'sharepoint_graph',
        connectorVersion: '1.0.0',
        operation: 'list_children',
        caller: microsoftCaller,
      }),
    ).resolves.toEqual({ token: 'graph-token-1' });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://login.microsoftonline.com/tenant/oauth2/v2.0/token');
    expect(init.method).toBe('POST');
    const body = new URLSearchParams(String(init.body));
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('client_id')).toBe('client-id');
    expect(body.get('client_secret')).toBe('client-secret');
    expect(body.get('refresh_token')).toBe('ms-refresh-1');
    expect(body.get('scope')).toBe('https://graph.microsoft.com/Sites.Selected');
    await expect(
      delegatedStore.getDelegatedCredential({
        resource: microsoftCaller.audience,
        provider: 'microsoft',
        subject: microsoftCaller.subject,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        credential: { enc: 'none', values: { token: 'ms-refresh-2' } },
      }),
    );
  });

  it('resolves managed variables in Microsoft delegated OAuth metadata before refresh', async () => {
    const delegatedStore = new InMemoryOAuthStore();
    await delegatedStore.putDelegatedCredential({
      resource: microsoftCaller.audience,
      provider: 'microsoft',
      subject: microsoftCaller.subject,
      credential: microsoftCredential,
      updatedAt: new Date(0).toISOString(),
    });
    const configStore = new InMemoryConfigStore();
    await configStore.setConfigValue({
      kind: 'secret',
      scope,
      name: 'MS_CLIENT_SECRET',
      value: 'client-secret',
    });
    await configStore.setConfigValue({
      kind: 'variable',
      scope,
      name: 'MICROSOFT_TENANT_ID',
      value: 'contoso-tenant',
    });
    await configStore.setConfigValue({
      kind: 'variable',
      scope,
      name: 'MICROSOFT_CLIENT_ID',
      value: 'managed-client-id',
    });
    const fetchImpl = vi.fn(async () =>
      Response.json({
        access_token: 'graph-token-1',
        refresh_token: 'ms-refresh-2',
        expires_in: '3600',
      }),
    ) as unknown as typeof fetch;
    const broker = new ManagedConfigBroker(
      [
        {
          ...microsoftBinding,
          delegated: {
            ...microsoftBinding.delegated,
            tokenUrl:
              'https://login.microsoftonline.com/${env.MICROSOFT_TENANT_ID}/oauth2/v2.0/token',
            clientId: '${env.MICROSOFT_CLIENT_ID}',
          },
        },
      ],
      configStore,
      scope,
      {
        delegatedCredentialStore: delegatedStore,
        openCustomerCredential: async (sealed) => sealed.values.token ?? '',
        sealCustomerCredential: async (token) => ({ enc: 'none', values: { token } }),
        fetchImpl,
        now: () => 1_000,
      },
    );

    await expect(
      broker.getCredential({
        connectorId: 'sharepoint_graph',
        connectorVersion: '1.0.0',
        operation: 'list_children',
        caller: microsoftCaller,
      }),
    ).resolves.toEqual({ token: 'graph-token-1' });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://login.microsoftonline.com/contoso-tenant/oauth2/v2.0/token');
    expect(new URLSearchParams(String(init.body)).get('client_id')).toBe('managed-client-id');
  });

  it('fails closed when Microsoft delegated OAuth has no matching Microsoft caller', async () => {
    const configStore = new InMemoryConfigStore();
    await configStore.setConfigValue({
      kind: 'secret',
      scope,
      name: 'MS_CLIENT_SECRET',
      value: 'client-secret',
    });
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const broker = new ManagedConfigBroker([microsoftBinding], configStore, scope, {
      delegatedCredentialStore: new InMemoryOAuthStore(),
      openCustomerCredential: async () => 'ms-refresh-1',
      fetchImpl,
      now: () => 1_000,
    });

    await expect(
      broker.getCredential({
        connectorId: 'sharepoint_graph',
        connectorVersion: '1.0.0',
        operation: 'list_children',
        caller,
      }),
    ).rejects.toThrow('delegated Microsoft credential requires a matching Microsoft caller');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('exchanges a delegated Firebase token for a downstream session cookie', async () => {
    const store = new InMemoryOAuthStore();
    await store.putDelegatedCredential({
      resource: caller.audience,
      provider: 'firebase',
      subject: caller.subject,
      credential,
      updatedAt: new Date(0).toISOString(),
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          id_token: 'firebase-id-token-1',
          refresh_token: 'firebase-refresh-2',
          expires_in: '3600',
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: {
            'set-cookie':
              'session=session-cookie-value; Path=/; Max-Age=1209600; Secure; HttpOnly; SameSite=lax',
          },
        }),
      ) as unknown as typeof fetch;
    const broker = new ManagedConfigBroker([sessionBinding], new InMemoryConfigStore(), scope, {
      delegatedCredentialStore: store,
      serverAuth: {
        kind: 'bridge',
        provider: 'firebase',
        projectId: 'noodleseed-dev',
        apiKey: 'firebase-api-key',
      },
      openCustomerCredential: async (sealed) => sealed.values.token ?? '',
      sealCustomerCredential: async (token) => ({ enc: 'none', values: { token } }),
      fetchImpl,
      now: () => 1_000,
    });

    await expect(
      broker.getCredential({
        connectorId: 'app_api',
        connectorVersion: '1.0.0',
        operation: 'list_orgs',
        caller,
      }),
    ).resolves.toEqual({
      kind: 'cookie',
      cookie: 'session=session-cookie-value',
      expiresAt: 1_209_601_000,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [sessionUrl, sessionInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(sessionUrl).toBe('https://dev.noodleseed.com/api/auth/session');
    expect(sessionInit.method).toBe('POST');
    expect(sessionInit.body).toBe(JSON.stringify({ idToken: 'firebase-id-token-1' }));
    await expect(
      store.getDelegatedCredential({
        resource: caller.audience,
        provider: 'firebase',
        subject: caller.subject,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        credential: { enc: 'none', values: { token: 'firebase-refresh-2' } },
      }),
    );
  });

  it('fails closed when delegated session exchange returns no cookie', async () => {
    const store = new InMemoryOAuthStore();
    await store.putDelegatedCredential({
      resource: caller.audience,
      provider: 'firebase',
      subject: caller.subject,
      credential,
      updatedAt: new Date(0).toISOString(),
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          id_token: 'firebase-id-token-1',
          refresh_token: 'firebase-refresh-1',
          expires_in: '3600',
        }),
      )
      .mockResolvedValueOnce(Response.json({ success: true })) as unknown as typeof fetch;
    const broker = new ManagedConfigBroker([sessionBinding], new InMemoryConfigStore(), scope, {
      delegatedCredentialStore: store,
      serverAuth: {
        kind: 'bridge',
        provider: 'firebase',
        projectId: 'noodleseed-dev',
        apiKey: 'firebase-api-key',
      },
      openCustomerCredential: async (sealed) => sealed.values.token ?? '',
      fetchImpl,
      now: () => 1_000,
    });

    await expect(
      broker.getCredential({
        connectorId: 'app_api',
        connectorVersion: '1.0.0',
        operation: 'list_orgs',
        caller,
      }),
    ).rejects.toThrow('delegated session endpoint did not return a cookie');
  });

  it('fails closed when a delegated connector call has no matching customer caller', async () => {
    const broker = new ManagedConfigBroker([binding], new InMemoryConfigStore(), scope, {
      delegatedCredentialStore: new InMemoryOAuthStore(),
      serverAuth: {
        kind: 'bridge',
        provider: 'firebase',
        projectId: 'noodleseed-prod',
        apiKey: 'firebase-api-key',
      },
      openCustomerCredential: async () => 'firebase-refresh-1',
    });

    await expect(
      broker.getCredential({
        connectorId: 'app_api',
        connectorVersion: '1.0.0',
        operation: 'get_app',
      }),
    ).rejects.toThrow('delegated credential requires a matching customer caller');
  });
});
