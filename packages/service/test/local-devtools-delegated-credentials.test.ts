import type { CredentialBroker } from '@noodle-borg/runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type RunningService, serveService } from '../src/serve.js';
import { InMemoryConfigStore } from '../src/store.js';

const services: RunningService[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  while (services.length > 0) await services.pop()?.close();
});

describe('local Devtools delegated credentials', () => {
  it('supplies Firebase bearer and session-cookie credentials for only the exact resource and subject', async () => {
    const service = await serveService({
      port: 0,
      localDevtoolsDirectFirebaseAuth: true,
    });
    services.push(service);
    const resource = `${service.url}/o/local/firebase-delegated/dev/mcp`;
    const sink = service.localDevtoolsDelegatedCredentials;
    expect(sink).toBeDefined();
    await sink?.setCredential({
      resource,
      provider: 'firebase',
      subject: 'firebase-user',
      refreshToken: 'firebase-refresh-token',
    });

    const target = await deploy(
      service,
      'firebase-delegated',
      FIREBASE_MANIFEST,
      FIREBASE_CONNECTORS,
    );
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      const href = String(url);
      if (href.startsWith('https://securetoken.googleapis.com/')) {
        return Response.json({
          id_token: 'downstream-firebase-id-token',
          refresh_token: 'rotated-firebase-refresh-token',
          expires_in: '3600',
        });
      }
      if (href === 'https://api.example.test/session') {
        return new Response('{}', {
          status: 200,
          headers: {
            'set-cookie': 'session=downstream-session-cookie; Path=/; Max-Age=120; HttpOnly',
          },
        });
      }
      throw new Error(`unexpected fetch: ${href}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const caller = {
      subject: 'firebase-user',
      audience: resource,
      identityKind: 'customer' as const,
      identityProvider: 'firebase',
      claims: { testMarker: 'inbound-mcp-bearer' },
    };

    await expect(
      target.getCredential({
        connectorId: 'firebase_bearer',
        connectorVersion: '1.0.0',
        operation: 'get_item',
        caller,
      }),
    ).resolves.toEqual({ token: 'downstream-firebase-id-token' });
    await expect(
      target.getCredential({
        connectorId: 'firebase_cookie',
        connectorVersion: '1.0.0',
        operation: 'get_item',
        caller,
      }),
    ).resolves.toMatchObject({
      kind: 'cookie',
      cookie: 'session=downstream-session-cookie',
    });

    const serializedRequests = JSON.stringify(fetchImpl.mock.calls);
    expect(serializedRequests).toContain('firebase-refresh-token');
    expect(serializedRequests).toContain('downstream-firebase-id-token');
    expect(serializedRequests).not.toContain('inbound-mcp-bearer');

    await expect(
      target.getCredential({
        connectorId: 'firebase_bearer',
        connectorVersion: '1.0.0',
        operation: 'get_item',
        caller: { ...caller, subject: 'different-user' },
      }),
    ).rejects.toThrow(/delegated credential not found/i);
  });

  it('supplies a Microsoft Graph token without forwarding the local MCP ID token', async () => {
    const configStore = new InMemoryConfigStore();
    await configStore.setConfigValue({
      kind: 'secret',
      scope: { level: 'env', org: 'local', app: 'microsoft-delegated', env: 'dev' },
      name: 'MICROSOFT_CLIENT_SECRET',
      value: 'microsoft-client-secret',
    });
    const service = await serveService({
      port: 0,
      configStore,
      localDevtoolsDirectMicrosoftAuth: true,
    });
    services.push(service);
    const resource = `${service.url}/o/local/microsoft-delegated/dev/mcp`;
    const sink = service.localDevtoolsDelegatedCredentials;
    expect(sink).toBeDefined();
    await sink?.setCredential({
      resource,
      provider: 'microsoft',
      subject: 'microsoft-user',
      refreshToken: 'microsoft-refresh-token',
    });

    const target = await deploy(
      service,
      'microsoft-delegated',
      MICROSOFT_MANIFEST,
      MICROSOFT_CONNECTORS,
    );
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({
        access_token: 'downstream-graph-access-token',
        refresh_token: 'rotated-microsoft-refresh-token',
        expires_in: 3_600,
      }),
    );
    vi.stubGlobal('fetch', fetchImpl);

    await expect(
      target.getCredential({
        connectorId: 'sharepoint_graph',
        connectorVersion: '1.0.0',
        operation: 'get_me',
        caller: {
          subject: 'microsoft-user',
          audience: resource,
          identityKind: 'customer',
          identityProvider: 'microsoft',
          claims: { testMarker: 'local-mcp-id-token' },
        },
      }),
    ).resolves.toEqual({ token: 'downstream-graph-access-token' });

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const body = new URLSearchParams(String(init?.body));
    expect(body.get('refresh_token')).toBe('microsoft-refresh-token');
    expect(body.get('client_secret')).toBe('microsoft-client-secret');
    expect(JSON.stringify(fetchImpl.mock.calls)).not.toContain('local-mcp-id-token');
  });

  it('does not expose a local credential sink on an ordinary service', async () => {
    const service = await serveService({ port: 0 });
    services.push(service);
    expect(service.localDevtoolsDelegatedCredentials).toBeUndefined();
  });
});

async function deploy(
  service: RunningService,
  app: string,
  manifest: string,
  connectors: string,
): Promise<CredentialBroker> {
  const result = await service.registry.deploy({ org: 'local', app, env: 'dev' }, manifest, {
    connectors,
    accessMode: 'customers',
    actor: { subject: 'local-devtools', email: 'local@localhost', superAdmin: false },
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
  const target = await service.registry.getActiveByTenant({ org: 'local', app, env: 'dev' });
  if (target === undefined) throw new Error('missing deployed target');
  return target.served.deps.broker;
}

const FIREBASE_MANIFEST = `
manifestVersion: "1"
server:
  name: firebase_delegated
  version: 1.0.0
  title: Firebase delegated
  auth:
    kind: bridge
    provider: firebase
    projectId: firebase-project
    apiKey: firebase-web-api-key
connectors:
  bearer:
    id: firebase_bearer
    version: 1.0.0
  cookie:
    id: firebase_cookie
    version: 1.0.0
tools:
  - name: bearer_item
    description: Fetch with a delegated Firebase bearer.
    inputSchema: { type: object, additionalProperties: false }
    fulfilment: { use: bearer.get_item, args: {} }
  - name: cookie_item
    description: Fetch with a delegated Firebase session cookie.
    inputSchema: { type: object, additionalProperties: false }
    fulfilment: { use: cookie.get_item, args: {} }
`;

const FIREBASE_CONNECTORS = `
connectors:
  - id: firebase_bearer
    version: 1.0.0
    http:
      baseUrl: https://api.example.test
      allowedOrigins: [https://api.example.test]
      auth: { kind: delegatedOAuth, provider: firebase }
    operations:
      get_item:
        type: read
        method: GET
        path: /bearer
        output: { type: object, additionalProperties: true }
  - id: firebase_cookie
    version: 1.0.0
    http:
      baseUrl: https://api.example.test
      allowedOrigins: [https://api.example.test]
      auth:
        kind: delegatedSessionCookie
        provider: firebase
        sessionUrl: https://api.example.test/session
    operations:
      get_item:
        type: read
        method: GET
        path: /cookie
        output: { type: object, additionalProperties: true }
`;

const MICROSOFT_MANIFEST = `
manifestVersion: "1"
server:
  name: microsoft_delegated
  version: 1.0.0
  title: Microsoft delegated
  auth:
    kind: bridge
    provider: microsoft
    tenantId: tenant-id
    clientId: client-id
    clientSecret: MICROSOFT_CLIENT_SECRET
    tokenUrl: https://login.microsoftonline.test/token
    scopes: [https://graph.microsoft.com/User.Read]
connectors:
  graph:
    id: sharepoint_graph
    version: 1.0.0
tools:
  - name: get_me
    description: Read the signed-in Microsoft user.
    inputSchema: { type: object, additionalProperties: false }
    fulfilment: { use: graph.get_me, args: {} }
`;

const MICROSOFT_CONNECTORS = `
connectors:
  - id: sharepoint_graph
    version: 1.0.0
    http:
      baseUrl: https://graph.microsoft.com/v1.0
      allowedOrigins:
        - https://graph.microsoft.com
        - https://login.microsoftonline.test
      auth:
        kind: delegatedOAuth
        provider: microsoft
        tokenUrl: https://login.microsoftonline.test/token
        clientId: client-id
        clientSecret: MICROSOFT_CLIENT_SECRET
        scopes: [https://graph.microsoft.com/User.Read]
    operations:
      get_me:
        type: read
        method: GET
        path: /me
        output: { type: object, additionalProperties: true }
`;
