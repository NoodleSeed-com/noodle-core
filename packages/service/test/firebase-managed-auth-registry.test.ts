import type { CredentialBroker } from '@noodle-borg/runtime';
import { afterEach, expect, it, vi } from 'vitest';
import { InMemoryOAuthStore } from '../src/oauth/store.js';
import { ServerRegistry } from '../src/registry.js';
import { InMemoryConfigStore } from '../src/store.js';

const tenant = { org: 'acme', app: 'firebase-auth', env: 'prod' };
const scope = { level: 'env' as const, ...tenant };
const audience = 'https://cloud.test/o/acme/firebase-auth/mcp';
const caller = {
  subject: 'firebase-user',
  audience,
  identityKind: 'customer' as const,
  identityProvider: 'firebase',
};
const credentialRequest = {
  connectorId: 'delegated_api',
  connectorVersion: '1.0.0',
  operation: 'fetch_item',
  caller,
};

const manifest = `
manifestVersion: "1"
server:
  name: firebase_auth
  version: 1.0.0
  title: Firebase auth
  auth:
    kind: bridge
    provider: firebase
    projectId: \${env.FIREBASE_PROJECT_ID}
    apiKey: \${env.FIREBASE_WEB_API_KEY}
connectors:
  api:
    id: delegated_api
    version: 1.0.0
tools:
  - name: fetch_item
    description: Fetch an item.
    inputSchema:
      type: object
      additionalProperties: false
    fulfilment:
      use: api.fetch_item
      args: {}
`;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('resolves a managed Firebase API key before hosted delegated bearer refresh', async () => {
  const harness = await createHarness('delegatedOAuth');
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(firebaseRefresh('firebase-id-token'));
  vi.stubGlobal('fetch', fetchImpl);

  await expect(harness.broker.getCredential(credentialRequest)).resolves.toEqual({
    token: 'firebase-id-token',
  });

  expect(secureTokenKey(fetchImpl, 0)).toBe('resolved-api-key');
});

it('uses a rotated managed Firebase API key after token expiry without redeploy', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  const harness = await createHarness('delegatedOAuth');
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(firebaseRefresh('firebase-id-token-1', 301))
    .mockResolvedValueOnce(firebaseRefresh('firebase-id-token-2', 301));
  vi.stubGlobal('fetch', fetchImpl);

  await expect(harness.broker.getCredential(credentialRequest)).resolves.toEqual({
    token: 'firebase-id-token-1',
  });
  await harness.configStore.setConfigValue({
    kind: 'variable',
    scope,
    name: 'FIREBASE_WEB_API_KEY',
    value: 'rotated-api-key',
  });
  vi.advanceTimersByTime(1_001);
  await expect(harness.broker.getCredential(credentialRequest)).resolves.toEqual({
    token: 'firebase-id-token-2',
  });

  expect(secureTokenKey(fetchImpl, 0)).toBe('resolved-api-key');
  expect(secureTokenKey(fetchImpl, 1)).toBe('rotated-api-key');
});

it('resolves a managed Firebase API key before hosted session-cookie refresh', async () => {
  const harness = await createHarness('delegatedSessionCookie');
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(firebaseRefresh('firebase-id-token'))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: {
          'set-cookie': 'session=session-value; Path=/; Max-Age=120; Secure; HttpOnly',
        },
      }),
    );
  vi.stubGlobal('fetch', fetchImpl);

  await expect(harness.broker.getCredential(credentialRequest)).resolves.toMatchObject({
    kind: 'cookie',
    cookie: 'session=session-value',
  });

  expect(secureTokenKey(fetchImpl, 0)).toBe('resolved-api-key');
  const [sessionUrl, sessionInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
  expect(sessionUrl).toBe('https://api.example.com/session');
  expect(sessionInit.body).toBe(JSON.stringify({ idToken: 'firebase-id-token' }));
});

it('classifies Firebase provider refresh failures without exposing provider details', async () => {
  const harness = await createHarness('delegatedOAuth');
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify({ error: { message: 'API_KEY_INVALID secret-provider-detail' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fetchImpl);

  const error = await harness.broker
    .getCredential(credentialRequest)
    .catch((cause: unknown) => cause);

  expect(error).toMatchObject({
    name: 'CredentialUnavailableError',
    reason: 'credential_exchange_failed',
    message: 'credential unavailable: credential_exchange_failed',
  });
  expect(String(error)).not.toContain('secret-provider-detail');
  expect(JSON.stringify(error)).not.toContain('secret-provider-detail');
});

async function createHarness(authKind: 'delegatedOAuth' | 'delegatedSessionCookie'): Promise<{
  readonly broker: CredentialBroker;
  readonly configStore: InMemoryConfigStore;
}> {
  const configStore = new InMemoryConfigStore();
  await configStore.setConfigValue({
    kind: 'variable',
    scope,
    name: 'FIREBASE_PROJECT_ID',
    value: 'resolved-project',
  });
  await configStore.setConfigValue({
    kind: 'variable',
    scope,
    name: 'FIREBASE_WEB_API_KEY',
    value: 'resolved-api-key',
  });
  const delegatedCredentialStore = new InMemoryOAuthStore();
  await delegatedCredentialStore.putDelegatedCredential({
    resource: audience,
    provider: 'firebase',
    subject: caller.subject,
    credential: { enc: 'none', values: { token: 'firebase-refresh-token' } },
    updatedAt: new Date(0).toISOString(),
  });
  const registry = new ServerRegistry(undefined, undefined, configStore, {
    delegatedCredentialStore,
    openCustomerCredential: async (credential) =>
      credential.enc === 'none' ? (credential.values.token ?? '') : '',
    sealCustomerCredential: async (token) => ({ enc: 'none', values: { token } }),
  });
  const deployed = await registry.deploy(tenant, manifest, {
    connectors: connectors(authKind),
    actor: { subject: 'owner', email: 'owner@example.com', superAdmin: false },
    accessMode: 'customers',
  });
  if (!deployed.ok) throw new Error(JSON.stringify(deployed.errors));
  const target = await registry.getActiveByTenant(tenant);
  if (target === undefined) throw new Error('deployed target not found');
  return { broker: target.served.deps.broker, configStore };
}

function connectors(authKind: 'delegatedOAuth' | 'delegatedSessionCookie'): string {
  return `
connectors:
  - id: delegated_api
    version: 1.0.0
    http:
      baseUrl: https://api.example.com
      allowedOrigins:
        - https://api.example.com
      auth:
        kind: ${authKind}
        provider: firebase
        ${authKind === 'delegatedSessionCookie' ? 'sessionUrl: https://api.example.com/session' : ''}
    operations:
      fetch_item:
        type: read
        method: GET
        path: /item
        output:
          type: object
          additionalProperties: true
`;
}

function firebaseRefresh(idToken: string, expiresIn = 3_600): Response {
  return Response.json({
    id_token: idToken,
    refresh_token: 'firebase-refresh-token',
    expires_in: String(expiresIn),
  });
}

function secureTokenKey(
  fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>,
  call: number,
): string | null {
  return new URL(String(fetchImpl.mock.calls[call]?.[0])).searchParams.get('key');
}
