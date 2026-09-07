import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { assetReference } from '@noodle-borg/compiler';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ArtifactStore,
  createServiceHandler,
  InMemoryArtifactStore,
  InMemoryAssetStore,
  InMemoryAuditStore,
  InMemoryConfigStore,
  InMemoryControlPlaneStore,
  ServerRegistry,
} from '../src/index.js';

const HELLO = `
manifestVersion: "1"
server:
  name: hello
  version: 1.0.0
  title: Hello
tools:
  - name: greet
    description: Greet someone.
    inputSchema:
      type: object
      properties:
        name:
          type: string
      required:
        - name
      additionalProperties: false
    fulfilment:
      steps:
        - id: build
          map:
            message: "Hello, \${input.name}!"
      output:
        message: \${steps.build.message}
`;

function helloManifest(greeting: string): string {
  return HELLO.replace('Hello, ${input.name}!', `${greeting}, \${input.name}!`);
}

const BROKEN = `
manifestVersion: "1"
server:
  name: broken
  version: 1.0.0
tools: []
`;

const ACCEPT = 'application/json, text/event-stream';
const JSON_HEADERS = { 'content-type': 'application/json', accept: ACCEPT };
const OWNER_TOKEN = 'OWNER';
const NO_AUTH = '__NO_AUTH__';
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);

let http: Server;
let base: string;
let configStore: InMemoryConfigStore;
let registry: ServerRegistry;
let controlPlane: InMemoryControlPlaneStore;

beforeEach(async () => {
  configStore = new InMemoryConfigStore();
  registry = new ServerRegistry(undefined, undefined, configStore);
  controlPlane = new InMemoryControlPlaneStore();
  await controlPlane.createOrgWithOwner({
    slug: 'acme',
    owner: { subject: 'owner-sub', email: 'owner@noodleseed.com' },
  });
  http = createServer(
    createServiceHandler(registry, {
      configStore,
      controlPlaneStore: controlPlane,
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
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => http.close((e) => (e ? reject(e) : resolve())));
});

function tenantDeployUrl(baseUrl: string, app = 'hello', env = 'prod'): string {
  return `${baseUrl}/v1/orgs/acme/apps/${app}/envs/${env}/deploy`;
}

function deploy(manifest: string, connectors?: string, app = 'hello'): Promise<Response> {
  return fetch(tenantDeployUrl(base, app), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ manifest, serverVersion: '1', ...(connectors ? { connectors } : {}) }),
  });
}

function deployBody(body: Record<string, unknown>): Promise<Response> {
  return fetch(tenantDeployUrl(base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function authHeaders(key: string | undefined): Record<string, string> {
  if (key === NO_AUTH) return {};
  return { authorization: `Bearer ${OWNER_TOKEN}` };
}

function initialize(url: string, key?: string): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { ...JSON_HEADERS, ...authHeaders(key) },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25' },
    }),
  });
}

function call(url: string, name: string, key?: string): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { ...JSON_HEADERS, 'mcp-protocol-version': '2025-11-25', ...authHeaders(key) },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'greet', arguments: { name } },
    }),
  });
}

describe('deploy service', () => {
  it('defaults omitted deployment source to api and preserves a declared console example', async () => {
    const defaultResponse = await deployBody({ manifest: HELLO, serverVersion: '1' });
    const defaultBody = (await defaultResponse.json()) as { deploymentId: string };
    expect((await registry.getDeployment('acme', defaultBody.deploymentId))?.deploymentSource).toBe(
      'api',
    );

    const exampleResponse = await deployBody({
      manifest: HELLO,
      serverVersion: '1',
      deploymentSource: 'console-example',
    });
    const exampleBody = (await exampleResponse.json()) as { deploymentId: string };
    expect((await registry.getDeployment('acme', exampleBody.deploymentId))?.deploymentSource).toBe(
      'console-example',
    );
  });

  it('requires explicit organization creation before deploy', async () => {
    const response = await fetch(`${base}/v1/orgs/not-created/apps/hello/envs/prod/deploy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ manifest: HELLO, serverVersion: '1' }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      code: 'organization_not_found',
      error: 'organization must be created before deploy',
    });
    expect(await controlPlane.getOrg('not-created')).toBeUndefined();
  });

  it('deploys a manifest and serves it as a working MCP endpoint', async () => {
    const res = await deploy(HELLO);
    expect(res.status).toBe(201);
    const { ok, deploymentId, serverVersion, url, defaultUrl, accessMode, callerKey } =
      await res.json();
    expect(ok).toBe(true);
    expect(deploymentId).toMatch(/^hello-[0-9a-f]{8}$/);
    expect(serverVersion).toBe('1');
    expect(url).toBe(`${base}/o/acme/hello/v1/mcp`);
    expect(defaultUrl).toBe(`${base}/o/acme/hello/mcp`);
    expect(accessMode).toBe('owner-only');
    expect(callerKey).toBeUndefined();

    // Without an owner token the endpoint is closed; with it, calls work.
    expect((await initialize(url, NO_AUTH)).status).toBe(401);
    expect((await initialize(url)).status).toBe(200);

    const result = await (await call(url, 'world')).json();
    expect(result.result.structuredContent).toEqual({ message: 'Hello, world!' });
    expect(result.result.isError).toBe(false);
  });

  it('isolates two deployed servers under distinct ids', async () => {
    const a = await (await deploy(HELLO, undefined, 'alpha')).json();
    const b = await (await deploy(HELLO, undefined, 'beta')).json();
    expect(a.deploymentId).not.toBe(b.deploymentId);
    expect(a.callerKey).toBeUndefined();
    expect(b.callerKey).toBeUndefined();
    expect((await initialize(a.url)).status).toBe(200);
    expect((await initialize(b.url)).status).toBe(200);
  });

  it('serves versioned deployments independently and defaults to the highest version', async () => {
    const v1 = await (
      await fetch(tenantDeployUrl(base), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manifest: helloManifest('Hello'), serverVersion: '1' }),
      })
    ).json();
    const v2 = await (
      await fetch(tenantDeployUrl(base), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manifest: helloManifest('Goodbye'), serverVersion: '2.0.0' }),
      })
    ).json();

    expect(v1.url).toBe(`${base}/o/acme/hello/v1/mcp`);
    expect(v2.url).toBe(`${base}/o/acme/hello/v2_0_0/mcp`);
    expect((await (await call(v1.url, 'world')).json()).result.structuredContent).toEqual({
      message: 'Hello, world!',
    });
    expect((await (await call(v2.url, 'world')).json()).result.structuredContent).toEqual({
      message: 'Goodbye, world!',
    });
    expect(
      (await (await call(`${base}/o/acme/hello/mcp`, 'world')).json()).result.structuredContent,
    ).toEqual({
      message: 'Goodbye, world!',
    });
  });

  it('invalidates the unversioned default cache after deploying a higher version', async () => {
    await fetch(tenantDeployUrl(base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ manifest: helloManifest('Hello'), serverVersion: '1' }),
    });
    expect(
      (await (await call(`${base}/o/acme/hello/mcp`, 'world')).json()).result.structuredContent,
    ).toEqual({ message: 'Hello, world!' });

    await fetch(tenantDeployUrl(base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ manifest: helloManifest('Goodbye'), serverVersion: '2.0.0' }),
    });
    expect(
      (await (await call(`${base}/o/acme/hello/mcp`, 'world')).json()).result.structuredContent,
    ).toEqual({ message: 'Goodbye, world!' });
  });

  it('redeploys one version without changing other versioned endpoints', async () => {
    const firstV1 = await (
      await fetch(tenantDeployUrl(base), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manifest: helloManifest('Hello'), serverVersion: '1' }),
      })
    ).json();
    const v2 = await (
      await fetch(tenantDeployUrl(base), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manifest: helloManifest('Goodbye'), serverVersion: '2.0.0' }),
      })
    ).json();
    const secondV1 = await (
      await fetch(tenantDeployUrl(base), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manifest: helloManifest('Welcome'), serverVersion: '1' }),
      })
    ).json();

    expect(secondV1.deploymentId).not.toBe(firstV1.deploymentId);
    expect((await (await call(firstV1.url, 'world')).json()).result.structuredContent).toEqual({
      message: 'Welcome, world!',
    });
    expect((await (await call(v2.url, 'world')).json()).result.structuredContent).toEqual({
      message: 'Goodbye, world!',
    });
    expect((await initialize(`${base}/${firstV1.deploymentId}/mcp`)).status).toBe(404);
    expect((await initialize(`${base}/${secondV1.deploymentId}/mcp`)).status).toBe(200);
  });

  it('returns 404 for an unknown server id', async () => {
    const res = await initialize(`${base}/hello-deadbeef/mcp`);
    expect(res.status).toBe(404);
  });

  it('returns 400 with errors for a manifest that fails to compile', async () => {
    const res = await deploy(BROKEN);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.errors.length).toBeGreaterThan(0);
  });

  it('gates the deploy on a widget CSP origin the host renderer would drop', async () => {
    const widgetManifest = (connectOrigin: string): string => `
manifestVersion: "1"
server:
  name: shop
  version: 1.0.0
  title: Shop
tools:
  - name: open_cart
    description: Open the cart.
    inputSchema:
      type: object
    outputSchema:
      type: object
      properties:
        ok:
          type: string
    fulfilment:
      steps:
        - id: m
          map:
            ok: "yes"
      output:
        ok: \${steps.m.ok}
widgets:
  - name: cart
    tool: open_cart
    html: "<!doctype html><main>Cart</main>"
    csp:
      connectDomains:
        - ${connectOrigin}
`;
    // A scheme-less origin the host would silently drop is rejected at deploy with an actionable error.
    const blocked = await deploy(widgetManifest('api.shop.example.com'), undefined, 'shop');
    expect(blocked.status).toBe(400);
    const body = await blocked.json();
    expect(body.error).toContain('api.shop.example.com');
    expect(body.error).toContain('https://api.shop.example.com');

    // The same manifest with an absolute https origin deploys cleanly.
    const ok = await deploy(widgetManifest('https://api.shop.example.com'), undefined, 'shop');
    expect(ok.status).toBe(201);
  });

  it('returns 400 for a malformed deploy body', async () => {
    const res = await fetch(tenantDeployUrl(base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ not_manifest: true }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for malformed optional deploy fields', async () => {
    const badConnectors = await deployBody({ manifest: HELLO, connectors: 123 });
    expect(badConnectors.status).toBe(400);
    expect((await badConnectors.json()).error).toContain('"connectors": Invalid input');

    const badSecrets = await deployBody({ manifest: HELLO, secrets: [] });
    expect(badSecrets.status).toBe(400);
    expect((await badSecrets.json()).error).toContain('"secrets" is no longer accepted');
  });

  it('honors a configured public base URL', async () => {
    const reg = new ServerRegistry();
    const server = createServer(
      createServiceHandler(reg, {
        controlPlaneStore: controlPlane,
        publicBaseUrl: 'https://cloud.noodleseed.dev/',
        deployGate: {
          authorize: () =>
            Promise.resolve({
              ok: true,
              identity: { subject: 'owner-sub', email: 'owner@noodleseed.com', superAdmin: true },
            }),
        },
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const res = await fetch(tenantDeployUrl(`http://127.0.0.1:${port}`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manifest: HELLO }),
      });
      const first = (await res.json()) as { url: string; deploymentId: string };
      const { url } = first;
      expect(url).toBe('https://cloud.noodleseed.dev/o/acme/hello/v1/mcp');

      const secondResponse = await fetch(tenantDeployUrl(`http://127.0.0.1:${port}`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manifest: HELLO }),
      });
      expect(secondResponse.status).toBe(201);

      const status = await fetch(
        `http://127.0.0.1:${port}/v1/orgs/acme/apps/hello/envs/prod/status`,
      );
      expect(
        ((await status.json()) as { deployment: { endpointUrl: string } }).deployment.endpointUrl,
      ).toBe('https://cloud.noodleseed.dev/o/acme/hello/v1/mcp');

      const rollback = await fetch(
        `http://127.0.0.1:${port}/v1/orgs/acme/apps/hello/envs/prod/rollback`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ deploymentId: first.deploymentId }),
        },
      );
      expect(rollback.status).toBe(200);
      expect(
        ((await rollback.json()) as { rollback: { endpointUrl: string } }).rollback.endpointUrl,
      ).toBe('https://cloud.noodleseed.dev/o/acme/hello/v1/mcp');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    }
  });

  it('preflights, uploads, verifies, deploys, and serves hosted packaged image assets', async () => {
    const assetStore = new InMemoryAssetStore();
    const reg = new ServerRegistry();
    const server = createServer(
      createServiceHandler(reg, {
        controlPlaneStore: controlPlane,
        assetStore,
        assetPublicBaseUrl: 'https://assets.example.test',
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
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const localBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const ref = assetReference('./assets/logo.png');
    const contentHash = `sha256:${createHash('sha256').update(PNG_1X1).digest('hex')}`;
    try {
      const preflight = await fetch(
        `${localBase}/v1/orgs/acme/apps/assets/envs/prod/assets/preflight`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            assets: [
              {
                logicalId: ref.logicalId,
                sourcePath: 'assets/logo.png',
                contentHash,
                mimeType: 'image/png',
                byteLength: PNG_1X1.byteLength,
                width: 1,
                height: 1,
              },
            ],
          }),
        },
      );
      expect(preflight.status).toBe(200);
      const plan = (await preflight.json()) as {
        assets: Array<{
          logicalId: string;
          objectKey: string;
          publicUrl: string;
        }>;
        uploads: Array<{
          uploadUrl: string;
          method: 'PUT';
          headers: Record<string, string>;
        }>;
      };
      const plannedAsset = plan.assets[0];
      expect(plannedAsset).toBeDefined();
      expect(plannedAsset?.objectKey).toContain(`acme/assets/prod/${contentHash.slice(7)}`);
      expect(plannedAsset?.publicUrl).toMatch(
        /^https:\/\/assets\.example\.test\/__noodle\/hosted-assets\//,
      );
      expect(plannedAsset?.publicUrl).not.toContain('logo.png');
      expect(plan.uploads).toHaveLength(1);

      const upload = plan.uploads[0];
      expect(upload).toBeDefined();
      if (upload === undefined || plannedAsset === undefined) return;
      const uploaded = await fetch(upload.uploadUrl, {
        method: upload.method,
        headers: upload.headers,
        body: PNG_1X1,
      });
      expect(uploaded.status).toBe(201);

      const deployed = await fetch(`${localBase}/v1/orgs/acme/apps/assets/envs/prod/deploy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          manifest: JSON.stringify(manifestWithHostedAsset(ref)),
          hostedAssets: plan.assets,
        }),
      });
      expect(deployed.status).toBe(201);

      const resource = await fetch(`${localBase}/o/acme/assets/mcp`, {
        method: 'POST',
        headers: {
          ...JSON_HEADERS,
          'mcp-protocol-version': '2025-11-25',
          authorization: `Bearer ${OWNER_TOKEN}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'resources/read',
          params: { uri: 'ui://asset_server/show_widget' },
        }),
      });
      expect(resource.status).toBe(200);
      const resourceBody = await resource.json();
      const text = resourceBody.result.contents[0].text as string;
      expect(text).toContain(plannedAsset.publicUrl);

      const assetPath = new URL(plannedAsset.publicUrl).pathname;
      const head = await fetch(`${localBase}${assetPath}`, { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(head.headers.get('content-type')).toBe('image/png');
      expect(head.headers.get('x-content-type-options')).toBe('nosniff');
      expect(head.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect(head.headers.get('set-cookie')).toBeNull();
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    }
  });

  it('emits safe audit events for asset preflight and activation', async () => {
    const assetStore = new InMemoryAssetStore();
    const audit = new InMemoryAuditStore();
    const server = createServer(
      createServiceHandler(new ServerRegistry(undefined, undefined, configStore), {
        controlPlaneStore: controlPlane,
        configStore,
        assetStore,
        audit,
        deployGate: {
          authorize: () =>
            Promise.resolve({
              ok: true,
              identity: { subject: 'owner-sub', email: 'owner@noodleseed.com', superAdmin: true },
            }),
        },
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const localBase = `http://127.0.0.1:${port}`;
    try {
      const ref = assetReference('./assets/logo.png');
      const contentHash = `sha256:${createHash('sha256').update(PNG_1X1).digest('hex')}`;
      const preflight = (await (
        await fetch(`${localBase}/v1/orgs/acme/apps/audit-assets/envs/prod/assets/preflight`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            assets: [
              {
                logicalId: ref.logicalId,
                sourcePath: 'assets/logo.png',
                contentHash,
                mimeType: 'image/png',
                byteLength: PNG_1X1.byteLength,
                width: 1,
                height: 1,
              },
            ],
          }),
        })
      ).json()) as {
        assets: Array<{ publicUrl: string }>;
        uploads: Array<{ uploadUrl: string; method: 'PUT'; headers: Record<string, string> }>;
      };
      const upload = preflight.uploads[0];
      expect(upload).toBeDefined();
      if (upload === undefined) return;
      await fetch(upload.uploadUrl, {
        method: 'PUT',
        headers: upload.headers,
        body: PNG_1X1,
      });
      const deployed = await fetch(`${localBase}/v1/orgs/acme/apps/audit-assets/envs/prod/deploy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          manifest: JSON.stringify(manifestWithHostedAsset(ref)),
          hostedAssets: preflight.assets,
        }),
      });
      expect(deployed.status).toBe(201);

      const events = await audit.list({ org: 'acme', app: 'audit-assets', env: 'prod' });
      expect(events.map((event) => event.eventType)).toContain('asset.preflight.accepted');
      expect(events.map((event) => event.eventType)).toContain('asset.activation.accepted');
      const assetEvent = events.find((event) => event.eventType === 'asset.activation.accepted');
      expect(assetEvent?.details).toMatchObject({ assetCount: 1, totalBytes: PNG_1X1.byteLength });
      expect(JSON.stringify(events)).not.toContain('/tmp/');
      expect(JSON.stringify(events)).not.toContain('asset-uploads');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    }
  });

  it('recompiles hosted asset deployments from persisted metadata without local files', async () => {
    const assetStore = new InMemoryAssetStore();
    const artifacts: ArtifactStore = new InMemoryArtifactStore();
    const first = new ServerRegistry(artifacts);
    const server = createServer(
      createServiceHandler(first, {
        controlPlaneStore: controlPlane,
        assetStore,
        assetPublicBaseUrl: 'https://assets.example.test',
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
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const localBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const ref = assetReference('./assets/logo.png');
    const contentHash = `sha256:${createHash('sha256').update(PNG_1X1).digest('hex')}`;
    try {
      const preflight = (await (
        await fetch(`${localBase}/v1/orgs/acme/apps/recover/envs/prod/assets/preflight`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            assets: [
              {
                logicalId: ref.logicalId,
                sourcePath: 'assets/logo.png',
                contentHash,
                mimeType: 'image/png',
                byteLength: PNG_1X1.byteLength,
                width: 1,
                height: 1,
              },
            ],
          }),
        })
      ).json()) as {
        assets: Array<{ publicUrl: string }>;
        uploads: Array<{ uploadUrl: string; method: 'PUT'; headers: Record<string, string> }>;
      };
      const upload = preflight.uploads[0];
      expect(upload).toBeDefined();
      if (upload === undefined) return;
      await fetch(upload.uploadUrl, {
        method: upload.method,
        headers: upload.headers,
        body: PNG_1X1,
      });
      const deployed = await fetch(`${localBase}/v1/orgs/acme/apps/recover/envs/prod/deploy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          manifest: JSON.stringify(manifestWithHostedAsset(ref)),
          hostedAssets: preflight.assets,
        }),
      });
      expect(deployed.status).toBe(201);
      const recovered = new ServerRegistry(artifacts);
      const target = await recovered.getActiveByTenant({
        org: 'acme',
        app: 'recover',
        env: 'prod',
      });
      expect(target?.served.artifact.assets?.[0]?.publicUrl).toBe(preflight.assets[0]?.publicUrl);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    }
  });

  it('recovers persisted JSON widget manifests written before the canonical UI shape', async () => {
    const artifacts: ArtifactStore = new InMemoryArtifactStore();
    const first = new ServerRegistry(artifacts);
    const deployed = await first.deploy(
      { org: 'acme', app: 'legacy-widget-ui', env: 'prod' },
      JSON.stringify(reactWidgetManifest()),
      {
        actor: { subject: 'owner-sub', email: 'owner@noodleseed.com', superAdmin: true },
        accessMode: 'owner-only',
      },
    );
    expect(deployed.ok).toBe(true);

    const recovered = new ServerRegistry(artifacts);
    const target = await recovered.getActiveByTenant({
      org: 'acme',
      app: 'legacy-widget-ui',
      env: 'prod',
    });
    expect(target?.served.artifact.server.name).toBe('legacy_widget_ui');
    expect(target?.served.artifact.resources?.[0]?.mimeType).toBe('text/html;profile=mcp-app');
  });
});

describe('deploy service with a declarative connector', () => {
  let backing: Server;
  let backingUrl: string;

  beforeEach(async () => {
    backing = createServer((req, res) => {
      const m = /^\/posts\/(\w+)$/.exec(req.url ?? '');
      if (req.method === 'GET' && m) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: m[1], title: `t${m[1]}`, body: `b${m[1]}`, extra: 'x' }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((resolve) => backing.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => backing.close((e) => (e ? reject(e) : resolve())));
  });

  it('deploys a connector-backed server that fetches and maps real data', async () => {
    const { port } = backing.address() as AddressInfo;
    backingUrl = `http://127.0.0.1:${port}`;
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
    const CONNECTORS = `
connectors:
  - id: jsonplaceholder
    version: 1.0.0
    http:
      baseUrl: ${backingUrl}
      allowedOrigins:
        - ${backingUrl}
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
    const dep = await (await deploy(POSTS_MANIFEST, CONNECTORS)).json();
    expect(dep.ok).toBe(true);
    expect(dep.deploymentId).toMatch(/^posts-[0-9a-f]{8}$/);

    await initialize(dep.url);
    const res = await fetch(dep.url, {
      method: 'POST',
      headers: {
        ...JSON_HEADERS,
        'mcp-protocol-version': '2025-11-25',
        ...authHeaders(undefined),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'get_post', arguments: { post_id: '3' } },
      }),
    });
    const body = await res.json();
    expect(body.result.structuredContent).toEqual({ title: 't3', body: 'b3' });
    expect(body.result.isError).toBe(false);
  });

  it('returns 400 for an invalid connector catalog', async () => {
    const res = await deploy(HELLO, 'connectors: []');
    expect(res.status).toBe(400);
    expect((await res.json()).ok).toBe(false);
  });
});

function manifestWithHostedAsset(asset: ReturnType<typeof assetReference>) {
  return {
    manifestVersion: '1',
    server: {
      name: 'asset_server',
      version: '1.0.0',
      title: 'Asset Server',
      branding: { logo: { uri: asset, alt: 'Asset logo' } },
    },
    tools: [
      {
        name: 'show',
        description: 'Show asset.',
        inputSchema: { type: 'object' },
        fulfilment: { steps: [], output: { ok: true } },
      },
    ],
    widgets: [
      {
        name: 'show_widget',
        tool: 'show',
        view: { component: 'FixtureWidget', entry: './views/FixtureWidget.tsx' },
      },
    ],
  };
}

function reactWidgetManifest() {
  return {
    manifestVersion: '1',
    server: {
      name: 'legacy_widget_ui',
      version: '1.0.0',
      title: 'Legacy Widget UI',
    },
    tools: [
      {
        name: 'show',
        description: 'Show the widget.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        fulfilment: { steps: [], output: { ok: true } },
      },
    ],
    widgets: [
      {
        name: 'show_widget',
        tool: 'show',
        view: { component: 'CanonicalCard', entry: './views/CanonicalCard.tsx' },
      },
    ],
  };
}

describe('deploy service with an authenticated connector', () => {
  let backing: Server;
  let backingUrl: string;

  beforeEach(async () => {
    // Echo what httpbin.org/bearer echoes: the bearer token (only) when an Authorization header is set.
    backing = createServer((req, res) => {
      const auth = req.headers.authorization;
      const m = /^Bearer (.+)$/.exec(auth ?? '');
      if (!m) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ authenticated: false }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ authenticated: true, token: m[1] }));
    });
    await new Promise<void>((resolve) => backing.listen(0, '127.0.0.1', resolve));
    const { port } = backing.address() as AddressInfo;
    backingUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => backing.close((e) => (e ? reject(e) : resolve())));
  });

  const MANIFEST = `
manifestVersion: "1"
server:
  name: httpbin
  version: 1.0.0
  title: Httpbin
connectors:
  httpbin:
    id: httpbin
    version: 1.0.0
tools:
  - name: whoami
    description: Echo the attached bearer token.
    inputSchema:
      type: object
      properties: {}
      additionalProperties: false
    fulfilment:
      use: httpbin.whoami
      args: {}
`;

  function connectors(url: string): string {
    return `
connectors:
  - id: httpbin
    version: 1.0.0
    http:
      baseUrl: ${url}
      allowedOrigins: [ ${url} ]
      auth: { kind: bearer, secret: httpbin_token }
    operations:
      whoami:
        type: read
        method: GET
        path: /bearer
        output:
          type: object
          properties:
            authenticated: { type: boolean }
            token: { type: string }
          additionalProperties: false
        response:
          authenticated: \${response.authenticated}
          token: \${response.token}
`;
  }

  async function deployWith(body: Record<string, unknown>, app = 'hello'): Promise<Response> {
    const { secrets, ...deployBody } = body;
    if (typeof secrets === 'object' && secrets !== null && !Array.isArray(secrets)) {
      for (const [name, value] of Object.entries(secrets as Record<string, unknown>)) {
        if (typeof value !== 'string') continue;
        await configStore.setConfigValue({
          kind: 'secret',
          scope: { level: 'env', org: 'acme', app, env: 'prod' },
          name,
          value,
        });
      }
    }
    return fetch(tenantDeployUrl(base, app), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(deployBody),
    });
  }

  function callWhoami(url: string, key?: string): Promise<Response> {
    return fetch(url, {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'mcp-protocol-version': '2025-11-25', ...authHeaders(key) },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'whoami', arguments: {} },
      }),
    });
  }

  it('attaches the managed secret as a bearer token end to end', async () => {
    const dep = await (
      await deployWith({
        manifest: MANIFEST,
        connectors: connectors(backingUrl),
        secrets: { httpbin_token: 'tok-123' },
      })
    ).json();
    expect(dep.ok).toBe(true);

    await initialize(dep.url);
    const body = await (await callWhoami(dep.url)).json();
    expect(body.result.isError).toBe(false);
    expect(body.result.structuredContent).toEqual({ authenticated: true, token: 'tok-123' });
  });

  it('fails closed (400) when a referenced secret has no supplied value, registering nothing', async () => {
    const reg = new ServerRegistry();
    const before = reg.size;
    // Deploy directly against a fresh registry so we can assert nothing was registered.
    const result = await reg.deploy({ org: 'acme', app: 'auth-fail', env: 'prod' }, MANIFEST, {
      connectors: connectors(backingUrl),
    }); // no secrets
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe('missing_secret');
    expect(result.errors[0]?.path).toBe('secrets.httpbin_token');
    // The error names only the reference — never a value.
    expect(JSON.stringify(result.errors)).not.toContain('tok-');
    expect(reg.size).toBe(before);
  });

  it('isolates secrets across two deployed servers', async () => {
    const a = await (
      await deployWith(
        {
          manifest: MANIFEST,
          connectors: connectors(backingUrl),
          secrets: { httpbin_token: 'tenant-a' },
        },
        'tenant-a',
      )
    ).json();
    const b = await (
      await deployWith(
        {
          manifest: MANIFEST,
          connectors: connectors(backingUrl),
          secrets: { httpbin_token: 'tenant-b' },
        },
        'tenant-b',
      )
    ).json();
    await initialize(a.url);
    await initialize(b.url);
    const ra = await (await callWhoami(a.url)).json();
    const rb = await (await callWhoami(b.url)).json();
    expect(ra.result.structuredContent.token).toBe('tenant-a');
    expect(rb.result.structuredContent.token).toBe('tenant-b');
  });

  it('returns 400 for removed deploy-body secrets', async () => {
    const res = await fetch(tenantDeployUrl(base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        manifest: MANIFEST,
        connectors: connectors(backingUrl),
        secrets: { httpbin_token: 123 },
      }),
    });
    expect(res.status).toBe(400);
  });
});
