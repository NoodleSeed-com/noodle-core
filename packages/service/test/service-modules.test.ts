import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  DEPLOYMENT_ACTIVATION_PHASE,
  MODULE_API_VERSION,
  type PolicyGate,
} from '@noodle-borg/module';
import type { LoadedServiceModule } from '@noodle-borg/service-modules';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createServiceHandler,
  InMemoryArtifactStore,
  InMemoryAuditStore,
  InMemoryConfigStore,
  InMemoryControlPlaneStore,
  ServerRegistry,
} from '../src/index.js';

const ACCEPT = 'application/json, text/event-stream';
const JSON_HEADERS = { 'content-type': 'application/json', accept: ACCEPT };
const OWNER_TOKEN = 'OWNER';

const POSTS_MANIFEST = `
manifestVersion: "1"
server:
  name: posts
  version: 1.0.0
  title: Posts
connectors:
  posts:
    id: jsonplaceholder
    version: 1.0.0
tools:
  - name: get_post
    description: Fetch a post.
    inputSchema:
      type: object
      properties:
        post_id:
          type: string
      required:
        - post_id
      additionalProperties: false
    fulfilment:
      use: posts.get_post
      args:
        post_id: \${input.post_id}
`;

const AUDIT_REQUIRED_MANIFEST = `
manifestVersion: "1"
server:
  name: audit_required
  version: 1.0.0
  title: Audit Required
requires:
  audit: true
tools:
  - name: ping
    description: Ping.
    inputSchema:
      type: object
    fulfilment:
      steps: []
      output:
        ok: true
`;

const PING_MANIFEST = `
manifestVersion: "1"
server:
  name: ping
  version: 1.0.0
  title: Ping
tools:
  - name: ping
    description: Ping.
    inputSchema:
      type: object
      additionalProperties: false
    fulfilment:
      steps: []
      output:
        ok: true
`;

let servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
  servers = [];
});

describe('service modules', () => {
  it('serves module routes after core routes and includes module readiness in /readyz', async () => {
    let moduleReady = true;
    const module = loaded('route-module', {
      routes: [
        {
          id: 'module.ping',
          match: (method, url) => method === 'GET' && url.pathname === '/module/ping',
          handle: (_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          },
        },
      ],
      readiness: () => moduleReady,
    });
    const service = await listen(
      createServiceHandler(new ServerRegistry(), { loadedModules: [module] }),
    );

    expect((await fetch(`${service}/healthz`)).status).toBe(200);
    expect(await (await fetch(`${service}/module/ping`)).json()).toEqual({ ok: true });
    expect((await fetch(`${service}/readyz`)).status).toBe(200);

    moduleReady = false;
    expect((await fetch(`${service}/readyz`)).status).toBe(503);
  });

  it('threads a module policy gate into deployed connector execution', async () => {
    let backendHits = 0;
    const backend = createServer((_req, res) => {
      backendHits++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ title: 't1', body: 'b1' }));
    });
    await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
    servers.push(backend);
    const { port } = backend.address() as AddressInfo;
    const backendUrl = `http://127.0.0.1:${port}`;

    const policyGate: PolicyGate = {
      before: async () => ({ allow: false, reason: 'blocked by module policy' }),
      after: async (_context, output) => output,
    };
    const module = loaded('policy-module', { policyGate });
    const configStore = new InMemoryConfigStore();
    const controlPlane = await tenantStore();
    const registry = new ServerRegistry(undefined, undefined, configStore, { policyGate });
    const service = await listen(
      createServiceHandler(registry, {
        configStore,
        controlPlaneStore: controlPlane,
        loadedModules: [module],
        deployGate: {
          authorize: () =>
            Promise.resolve({
              ok: true,
              identity: { subject: 'owner-sub', email: 'owner@noodleseed.com', superAdmin: true },
            }),
        },
        verifyOwnerToken: (token) =>
          Promise.resolve(token === OWNER_TOKEN ? { caller: { subject: 'owner-sub' } } : null),
        authServerIssuer: 'https://as.noodle.test',
      }),
    );

    const dep = await (
      await fetch(`${service}/v1/orgs/acme/apps/posts/envs/prod/deploy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manifest: POSTS_MANIFEST, connectors: connectors(backendUrl) }),
      })
    ).json();
    expect(dep.ok).toBe(true);

    await initialize(dep.url);
    const call = await fetch(dep.url, {
      method: 'POST',
      headers: {
        ...JSON_HEADERS,
        'mcp-protocol-version': '2025-11-25',
        authorization: `Bearer ${OWNER_TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'get_post', arguments: { post_id: '1' } },
      }),
    });

    const body = await call.json();
    expect(body.error.code).toBe(-32603);
    expect(body.error.message).toContain('blocked by module policy');
    expect(backendHits).toBe(0);
  });

  it('reports product capabilities without module package names by default', async () => {
    const service = await listen(
      createServiceHandler(new ServerRegistry(), {
        loadedModules: [loaded('audit', { auditStore: new InMemoryAuditStore() })],
      }),
    );

    const body = await (await fetch(`${service}/v1/service/capabilities`)).json();

    expect(body.ok).toBe(true);
    expect(body.capabilities).toEqual(['audit', 'observability', 'secrets', 'connectors', 'apps']);
    expect(JSON.stringify(body)).not.toContain('@noodle-borg');
  });

  it('includes module details only when explicitly requested', async () => {
    const service = await listen(
      createServiceHandler(new ServerRegistry(), {
        loadedModules: [
          loaded('@noodle-borg/module-audit', { auditStore: new InMemoryAuditStore() }),
        ],
      }),
    );

    const body = await (await fetch(`${service}/v1/service/capabilities?advanced=1`)).json();

    expect(body.modules).toEqual([
      expect.objectContaining({
        name: '@noodle-borg/module-audit',
        capabilities: ['audit'],
      }),
    ]);
  });

  it('rejects deploys whose required capabilities are missing', async () => {
    const controlPlane = await tenantStore();
    const service = await listen(
      createServiceHandler(new ServerRegistry(), {
        controlPlaneStore: controlPlane,
        deployGate: authenticatedGate(),
      }),
    );

    const res = await deploy(service, AUDIT_REQUIRED_MANIFEST);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.errors).toContainEqual(
      expect.objectContaining({
        code: 'missing_capability',
        path: 'requires.audit',
      }),
    );
    expect(body.errors[0]?.message).toContain('requires audit');
  });

  it('accepts deploys whose requirements match loaded module capabilities', async () => {
    const controlPlane = await tenantStore();
    const service = await listen(
      createServiceHandler(new ServerRegistry(), {
        controlPlaneStore: controlPlane,
        loadedModules: [loaded('audit', { auditStore: new InMemoryAuditStore() })],
        deployGate: authenticatedGate(),
      }),
    );

    const res = await deploy(service, AUDIT_REQUIRED_MANIFEST);
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.ok).toBe(true);
  });

  it('uses a module asset store for the public asset-preflight route', async () => {
    const planUploads = vi.fn(async () => ({
      assetOrigin: 'https://assets.example.test',
      assets: [],
      uploads: [],
    }));
    const service = await listen(
      createServiceHandler(new ServerRegistry(), {
        controlPlaneStore: await tenantStore(),
        deployGate: authenticatedGate(),
        loadedModules: [
          loaded('assets', {
            assetStore: {
              planUploads,
              verifyUploadedAssets: async ({ assets }) => ({ ok: true, assets }),
              recordReachability: async () => undefined,
            },
          }),
        ],
      }),
    );

    const response = await fetch(`${service}/v1/orgs/acme/apps/posts/envs/prod/assets/preflight`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assets: [] }),
    });

    expect(response.status).toBe(200);
    expect(planUploads).toHaveBeenCalledOnce();
  });

  it('invokes an ordered module tool hook at the existing once-per-call boundary', async () => {
    const dispatch = vi.fn(async () => ({ allow: true as const }));
    const controlPlane = await tenantStore();
    const service = await listen(
      createServiceHandler(new ServerRegistry(), {
        controlPlaneStore: controlPlane,
        deployGate: authenticatedGate(),
        verifyOwnerToken: (token) =>
          Promise.resolve(token === OWNER_TOKEN ? { caller: { subject: 'owner-sub' } } : null),
        loadedModules: [loaded('usage', { toolDispatch: { id: 'usage.dispatch', dispatch } })],
      }),
    );
    const deployed = await deployManifest(service, PING_MANIFEST, 'owner-only');

    await initialize(deployed.url);
    const response = await callPing(deployed.url);

    expect(response.status).toBe(200);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ org: 'acme', app: 'posts', toolName: 'ping' }),
    );
  });

  it('uses module auth verification and data-plane authorization contributions', async () => {
    const authVerifier = vi.fn(async (token: string) =>
      token === OWNER_TOKEN ? { caller: { subject: 'external-user' } } : null,
    );
    const dataPlaneAuthorizer = vi.fn(async () => ({ allowed: true as const }));
    const service = await listen(
      createServiceHandler(new ServerRegistry(), {
        controlPlaneStore: await tenantStore(),
        deployGate: authenticatedGate(),
        loadedModules: [loaded('identity', { authVerifier, dataPlaneAuthorizer })],
      }),
    );
    const deployed = await deployManifest(service, PING_MANIFEST, 'org-members');

    await initialize(deployed.url);
    const response = await callPing(deployed.url);

    expect(response.status).toBe(200);
    expect(authVerifier).toHaveBeenCalled();
    expect(dataPlaneAuthorizer).toHaveBeenCalledWith(
      expect.objectContaining({ org: 'acme', subject: 'external-user' }),
    );
  });

  it('scopes module deployment automation to asset-preflight and deploy routes', async () => {
    const authorize = vi.fn(async () => ({
      kind: 'authorized' as const,
      automationId: 'run-1',
      actor: { subject: 'automation:run-1', email: '', superAdmin: false },
    }));
    const service = await listen(
      createServiceHandler(new ServerRegistry(), {
        controlPlaneStore: await tenantStore(),
        loadedModules: [
          loaded('automation', {
            deploymentAutomation: { authorize },
            deploymentActivation: automationFreshness(),
            assetStore: {
              planUploads: async () => ({
                assetOrigin: 'https://assets.example.test',
                assets: [],
                uploads: [],
              }),
              verifyUploadedAssets: async ({ assets }) => ({ ok: true, assets }),
              recordReachability: async () => undefined,
            },
          }),
        ],
      }),
    );

    expect((await fetch(`${service}/healthz`)).status).toBe(200);
    expect(authorize).not.toHaveBeenCalled();
    const response = await fetch(`${service}/v1/orgs/acme/apps/posts/envs/prod/assets/preflight`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-noodle-run-token': 'run-1' },
      body: JSON.stringify({ assets: [] }),
    });

    expect(response.status).toBe(200);
    expect(authorize).toHaveBeenCalledOnce();
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'asset-preflight',
        target: { org: 'acme', app: 'posts', env: 'prod' },
      }),
    );
  });

  it('never falls back to human deploy authorization after automation denial', async () => {
    const authorize = vi.fn(async () => ({
      kind: 'denied' as const,
      status: 403 as const,
      code: 'automation_stale',
      message: 'automation credential is stale',
    }));
    const service = await listen(
      createServiceHandler(new ServerRegistry(), {
        controlPlaneStore: await tenantStore(),
        deployGate: authenticatedGate(),
        loadedModules: [
          loaded('automation', {
            deploymentAutomation: { authorize },
            deploymentActivation: automationFreshness(),
          }),
        ],
      }),
    );

    const human = await fetch(`${service}/v1/orgs/acme/apps/posts/envs/prod/deploy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ manifest: PING_MANIFEST, accessMode: 'org-members' }),
    });
    expect(human.status).toBe(201);
    expect(authorize).not.toHaveBeenCalled();

    const response = await fetch(`${service}/v1/orgs/acme/apps/posts/envs/prod/deploy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-noodle-run-token': 'stale' },
      body: JSON.stringify({ manifest: PING_MANIFEST, accessMode: 'org-members' }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'automation_stale' });
    expect(authorize).toHaveBeenCalledOnce();
  });

  it('preserves restricted org membership sources across module-authorized redeploys', async () => {
    const registry = new ServerRegistry(new InMemoryArtifactStore(), undefined, undefined, {
      transactionalModuleDeploymentActivation: true,
    });
    const authorize = vi.fn(async () => ({
      kind: 'authorized' as const,
      automationId: 'run-1',
      actor: { subject: 'automation:run-1', email: '', superAdmin: false },
      accessMode: 'org-members' as const,
      accessModeSource: 'previous' as const,
    }));
    const service = await listen(
      createServiceHandler(registry, {
        controlPlaneStore: await tenantStore(),
        deployGate: authenticatedGate(),
        loadedModules: [
          loaded('automation', {
            deploymentAutomation: { authorize },
            deploymentActivation: automationFreshness(),
          }),
        ],
      }),
    );
    const deployUrl = `${service}/v1/orgs/acme/apps/posts/envs/prod/deploy`;

    const initial = await fetch(deployUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        manifest: PING_MANIFEST,
        accessMode: 'org-members',
        orgMembershipSources: ['explicit'],
      }),
    });
    expect(initial.status).toBe(201);

    const automated = await fetch(deployUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-noodle-run-token': 'run-1' },
      body: JSON.stringify({ manifest: PING_MANIFEST }),
    });
    expect(automated.status).toBe(201);
    expect(
      (await registry.activeDeployProvenance({ org: 'acme', app: 'posts', env: 'prod' }))
        ?.orgMembershipSources,
    ).toEqual(['explicit']);
  });

  it('keeps the automation actor truthful while carrying inherited ownership separately', async () => {
    const store = new InMemoryArtifactStore();
    const registry = new ServerRegistry(store, undefined, undefined, {
      transactionalModuleDeploymentActivation: true,
    });
    const authorize = vi.fn(async () => ({
      kind: 'authorized' as const,
      automationId: 'run-1',
      actor: { subject: 'github-run:run-1', email: '', superAdmin: false },
      ownerSubject: 'owner-sub',
      accessMode: 'owner-only' as const,
      accessModeSource: 'previous' as const,
    }));
    const service = await listen(
      createServiceHandler(registry, {
        controlPlaneStore: await tenantStore(),
        deployGate: authenticatedGate(),
        loadedModules: [
          loaded('automation', {
            deploymentAutomation: { authorize },
            deploymentActivation: automationFreshness(),
          }),
        ],
      }),
    );
    const deployUrl = `${service}/v1/orgs/acme/apps/posts/envs/prod/deploy`;
    expect(
      (
        await fetch(deployUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ manifest: PING_MANIFEST }),
        })
      ).status,
    ).toBe(201);

    const automated = await fetch(deployUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-noodle-run-token': 'run-1' },
      body: JSON.stringify({ manifest: PING_MANIFEST }),
    });
    expect(automated.status).toBe(201);
    const { deploymentId } = (await automated.json()) as { deploymentId: string };
    await expect(store.get(deploymentId)).resolves.toMatchObject({
      createdBySubject: 'github-run:run-1',
      ownerSubject: 'owner-sub',
    });
  });

  it('rejects module-authorized deploy when atomic activation is unavailable', async () => {
    const authorize = vi.fn(async () => ({
      kind: 'authorized' as const,
      automationId: 'run-1',
      actor: { subject: 'automation:run-1', email: '', superAdmin: false },
      accessMode: 'org-members' as const,
      accessModeSource: 'declared' as const,
    }));
    const service = await listen(
      createServiceHandler(new ServerRegistry(), {
        controlPlaneStore: await tenantStore(),
        loadedModules: [
          loaded('automation', {
            deploymentAutomation: { authorize },
            deploymentActivation: automationFreshness(),
          }),
        ],
      }),
    );

    const response = await fetch(`${service}/v1/orgs/acme/apps/posts/envs/prod/deploy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-noodle-run-token': 'run-1' },
      body: JSON.stringify({ manifest: PING_MANIFEST, accessMode: 'org-members' }),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'automation_activation_unavailable' });
  });

  it('keeps the boot-resolved token verifier ahead of the raw module verifier', async () => {
    const moduleVerifier = vi.fn(async () => ({ caller: { subject: 'principal-1' } }));
    const guardedVerifier = vi.fn(async () => null);
    const service = await listen(
      createServiceHandler(new ServerRegistry(), {
        controlPlaneStore: await tenantStore(),
        deployGate: authenticatedGate(),
        verifyOwnerToken: guardedVerifier,
        loadedModules: [loaded('identity', { authVerifier: moduleVerifier })],
      }),
    );
    const deployed = await deployManifest(service, PING_MANIFEST, 'owner-only');

    const response = await initialize(deployed.url);

    expect(response.status).toBe(401);
    expect(guardedVerifier).toHaveBeenCalled();
    expect(moduleVerifier).not.toHaveBeenCalled();
  });

  it('never treats a presented automation credential as a human request', async () => {
    const authorize = vi.fn(async () => ({ kind: 'not-automation' as const }));
    const service = await listen(
      createServiceHandler(new ServerRegistry(), {
        controlPlaneStore: await tenantStore(),
        deployGate: authenticatedGate(),
        loadedModules: [
          loaded('automation', {
            deploymentAutomation: { authorize },
            deploymentActivation: automationFreshness(),
          }),
        ],
      }),
    );

    const response = await fetch(`${service}/v1/orgs/acme/apps/posts/envs/prod/deploy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-noodle-run-token': 'unknown' },
      body: JSON.stringify({ manifest: PING_MANIFEST, accessMode: 'org-members' }),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'run_token_unauthorized' });
    expect(authorize).toHaveBeenCalledOnce();

    const preflight = await fetch(`${service}/v1/orgs/acme/apps/posts/envs/prod/assets/preflight`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-noodle-run-token': 'unknown' },
      body: JSON.stringify({ assets: [] }),
    });
    expect(preflight.status).toBe(401);
    expect(await preflight.json()).toMatchObject({ code: 'run_token_unauthorized' });
    expect(authorize).toHaveBeenCalledTimes(2);
  });
});

function loaded(
  name: string,
  contributions: LoadedServiceModule['contributions'],
): LoadedServiceModule {
  return {
    module: { name, version: '0.0.0', apiVersion: MODULE_API_VERSION, init: () => contributions },
    contributions,
    position: 0,
  };
}

function automationFreshness() {
  return {
    id: 'automation.freshness',
    phase: DEPLOYMENT_ACTIVATION_PHASE.AUTOMATION_FRESHNESS,
    prepare: async () => undefined,
    assert: async () => undefined,
  };
}

async function listen(handler: ReturnType<typeof createServiceHandler>): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function initialize(url: string): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { ...JSON_HEADERS, authorization: `Bearer ${OWNER_TOKEN}` },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25' },
    }),
  });
}

async function deployManifest(
  service: string,
  manifest: string,
  accessMode: 'owner-only' | 'org-members',
): Promise<{ readonly url: string }> {
  const response = await fetch(`${service}/v1/orgs/acme/apps/posts/envs/prod/deploy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ manifest, accessMode }),
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<{ readonly url: string }>;
}

function callPing(url: string): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      ...JSON_HEADERS,
      'mcp-protocol-version': '2025-11-25',
      authorization: `Bearer ${OWNER_TOKEN}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'ping', arguments: {} },
    }),
  });
}

function authenticatedGate() {
  return {
    authorize: () =>
      Promise.resolve({
        ok: true as const,
        identity: { subject: 'owner-sub', email: 'owner@noodleseed.com', superAdmin: true },
      }),
  };
}

async function tenantStore(): Promise<InMemoryControlPlaneStore> {
  const store = new InMemoryControlPlaneStore();
  await store.createOrg({ slug: 'acme' });
  return store;
}

function deploy(baseUrl: string, manifest: string): Promise<Response> {
  return fetch(`${baseUrl}/v1/orgs/acme/apps/capabilities/envs/prod/deploy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ manifest }),
  });
}

function connectors(baseUrl: string): string {
  return `
connectors:
  - id: jsonplaceholder
    version: 1.0.0
    http:
      baseUrl: ${baseUrl}
      allowedOrigins:
        - ${baseUrl}
    operations:
      get_post:
        type: read
        method: GET
        path: /posts/{post_id}
        input:
          type: object
          properties:
            post_id: { type: string }
          required: [post_id]
          additionalProperties: false
        output:
          type: object
          properties:
            title: { type: string }
            body: { type: string }
          additionalProperties: false
        response:
          title: \${response.title}
          body: \${response.body}
`;
}

describe('module loading placement', () => {
  it('keeps dynamic module loading out of the request handler', () => {
    // Boot-time concern: `serveService` loads modules once, so a request path that could
    // import operator code would move an allowlist decision into per-request control flow.
    const serviceSource = readFileSync(new URL('../src/service.ts', import.meta.url), 'utf8');
    expect(serviceSource).not.toContain('loadModules');
  });
});
