import { generateKeyPairSync } from 'node:crypto';
import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  Client,
  ClientCredentialsProvider,
  PrivateKeyJwtProvider,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { createJwtVerifier, createStaticSigningKeyProvider } from '@noodle-borg/auth';
import type { RequestEventInput } from '@noodle-borg/module';
import { exportJWK } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { createOAuthApp } from '../src/oauth/app.js';
import { NoodleOAuthProvider } from '../src/oauth/provider.js';
import { digestClientSecret } from '../src/oauth/service-principal-credentials.js';
import { guardServicePrincipalAccessTokenVerifier } from '../src/oauth/service-principal-guard.js';
import { resolveServicePrincipalResource } from '../src/oauth/service-principal-resource.js';
import {
  InMemoryServicePrincipalStore,
  type ServicePrincipalRuntime,
} from '../src/oauth/service-principal-store.js';
import { InMemoryOAuthStore } from '../src/oauth/store.js';
import { ServerRegistry } from '../src/registry.js';
import { createServiceHandler } from '../src/service.js';
import { InMemoryAuditStore } from '../src/store/audit.js';

const SECRET = 'abcdefghijklmnopqrstuvwxyzABCDEFGH123456789';
const MANIFEST = `
manifestVersion: "1"
server:
  name: machine_auth
  version: 1.0.0
  title: Machine auth
tools:
  - name: read_todos
    description: Read todos.
    inputSchema:
      type: object
      additionalProperties: false
    fulfilment:
      steps: []
      output:
        items: []
`;

const openServers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    openServers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe('official MCP v2 client-credentials providers', () => {
  it.each([
    'client_secret_basic',
    'private_key_jwt',
  ] as const)('obtains a token with %s and completes pinned-modern MCP discovery and a tool call', async (method) => {
    const fixture = await officialFixture(method);
    const client = new Client(
      { name: 'service-principal-test', version: '1.0.0' },
      { capabilities: {}, versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    const transport = new StreamableHTTPClientTransport(new URL(fixture.resource), {
      authProvider: fixture.authProvider,
    });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain('read_todos');
      const result = await client.callTool({ name: 'read_todos', arguments: {} });
      expect(result.structuredContent).toEqual({ items: [] });
      expect(fixture.authProvider.tokens()).toMatchObject({
        token_type: 'Bearer',
        expires_in: 600,
        scope: 'todos.read',
      });
      expect(fixture.authProvider.tokens()).not.toHaveProperty('refresh_token');
      const callAudits = await fixture.audit.list({
        org: 'acme',
        eventType: 'service_principal.tool.called',
      });
      expect(callAudits).toEqual([
        expect.objectContaining({
          actorSubject: fixture.principalId,
          decision: 'allow',
          details: { toolName: 'read_todos' },
        }),
      ]);
      expect(fixture.requestEvents.find((event) => event.method === 'tools/call')).toMatchObject({
        subjectKind: 'authenticated',
        protocolEra: 'modern',
      });
      const publicEvidence = JSON.stringify({
        callAudits,
        authorizationAudits: await fixture.audit.list({
          org: 'acme',
          eventType: 'service_principal.tool.authorization',
        }),
        requestEvents: fixture.requestEvents,
      });
      expect(publicEvidence).not.toContain(fixture.grantId);
      expect(publicEvidence).not.toContain(fixture.credentialId);
      expect(publicEvidence).not.toContain(SECRET);
      expect(publicEvidence).not.toContain(String(fixture.authProvider.tokens().access_token));
    } finally {
      await client.close();
    }
  });
});

async function officialFixture(method: 'client_secret_basic' | 'private_key_jwt') {
  let dispatch: RequestListener = (_req, res) => {
    res.statusCode = 503;
    res.end();
  };
  const server = createServer((req, res) => dispatch(req, res));
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const resource = `${origin}/o/acme/todoist/mcp`;

  const registry = new ServerRegistry();
  const deployed = await registry.deploy({ org: 'acme', app: 'todoist', env: 'prod' }, MANIFEST, {
    accessMode: 'authenticated',
    actor: {
      subject: 'human-1',
      email: 'human@example.test',
      superAdmin: false,
    },
  });
  if (!deployed.ok) throw new Error(JSON.stringify(deployed.errors));

  const machineStore = new InMemoryServicePrincipalStore();
  const principal = await machineStore.createPrincipal({
    org: 'acme',
    name: 'official client',
    actorSubject: 'human-1',
  });
  const grant = await machineStore.createGrant({
    principalId: principal.principalId,
    org: 'acme',
    app: 'todoist',
    environment: 'prod',
    scopes: ['todos.read'],
    actorSubject: 'human-1',
  });

  let authProvider: ClientCredentialsProvider | PrivateKeyJwtProvider;
  let credentialId: string;
  if (method === 'client_secret_basic') {
    const credential = await machineStore.createCredential({
      principalId: principal.principalId,
      org: 'acme',
      kind: 'client_secret',
      label: 'primary',
      secretDigest: digestClientSecret(SECRET),
      actorSubject: 'human-1',
    });
    credentialId = credential.credentialId;
    authProvider = new ClientCredentialsProvider({
      clientId: principal.principalId,
      clientSecret: SECRET,
      expectedIssuer: origin,
      scope: 'todos.read',
    });
  } else {
    const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const credential = await machineStore.createCredential({
      principalId: principal.principalId,
      org: 'acme',
      kind: 'public_jwk',
      label: 'primary',
      algorithm: 'RS256',
      publicJwk: { ...(await exportJWK(keyPair.publicKey)), alg: 'RS256' },
      actorSubject: 'human-1',
    });
    credentialId = credential.credentialId;
    authProvider = new PrivateKeyJwtProvider({
      clientId: principal.principalId,
      privateKey: keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      algorithm: 'RS256',
      expectedIssuer: origin,
      scope: 'todos.read',
    });
  }

  const signer = await createStaticSigningKeyProvider();
  const provider = new NoodleOAuthProvider({
    issuer: origin,
    store: new InMemoryOAuthStore(),
    signer,
    oauthClientCredentialsReady: true,
  });
  const runtime: ServicePrincipalRuntime = { ready: true, store: machineStore };
  const audit = new InMemoryAuditStore();
  const requestEvents: RequestEventInput[] = [];
  const authServerApp = createOAuthApp(provider, {
    servicePrincipals: {
      runtime,
      registry: () => registry,
      routing: {
        legacyOrigin: origin,
        allowedBaseDomains: [],
        resolveTenant: async () => undefined,
      },
      audit,
    },
  });
  const verifyOwnerToken = guardServicePrincipalAccessTokenVerifier(
    createJwtVerifier({
      issuer: origin,
      keyResolver: await signer.verifierKey(),
    }),
    machineStore,
    async (requestedResource) => {
      const resolved = await resolveServicePrincipalResource(requestedResource, registry, {
        legacyOrigin: origin,
        allowedBaseDomains: [],
        resolveTenant: async () => undefined,
      });
      return resolved === undefined
        ? undefined
        : {
            org: resolved.tenant.org,
            app: resolved.tenant.app,
            environment: resolved.tenant.env,
          };
    },
  );
  dispatch = createServiceHandler(registry, {
    authServerApp: authServerApp as never,
    authServerIssuer: origin,
    verifyOwnerToken,
    publicBaseUrl: origin,
    servicePrincipalRuntime: runtime,
    audit,
    captureRequestEvent: (event) => requestEvents.push(event),
  });
  return {
    resource,
    authProvider,
    audit,
    requestEvents,
    principalId: principal.principalId,
    grantId: grant.grantId,
    credentialId,
  };
}
