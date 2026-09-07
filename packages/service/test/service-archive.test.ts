import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createServiceHandler,
  InMemoryArtifactStore,
  InMemoryAuditStore,
  InMemoryConfigStore,
  InMemoryControlPlaneStore,
  ServerRegistry,
  type ServiceOptions,
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

const ACCEPT = 'application/json, text/event-stream';
const JSON_HEADERS = { 'content-type': 'application/json', accept: ACCEPT };
const OWNER_DATA_TOKEN = 'OWNER';
const RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const CUSTOMER_AUTH = {
  issuer: 'https://idp.example',
  audience: 'acme-support',
} as const;

let http: Server;
let base: string;
let store: InMemoryArtifactStore;
let configStore: InMemoryConfigStore;
let controlPlane: InMemoryControlPlaneStore;
let audit: InMemoryAuditStore;
let registry: ServerRegistry;
let now: Date;
let handlerOptions: ServiceOptions;

function gate() {
  return {
    authorize: (req: { headers: Record<string, unknown> }) => {
      const token = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
      if (token === 'owner-token') {
        return Promise.resolve({
          ok: true as const,
          identity: { subject: 'owner-sub', email: 'owner@acme.test', superAdmin: false },
        });
      }
      if (token === 'dev-token') {
        return Promise.resolve({
          ok: true as const,
          identity: { subject: 'dev-sub', email: 'dev@acme.test', superAdmin: false },
        });
      }
      return Promise.resolve({ ok: false as const, status: 401, message: 'missing bearer token' });
    },
  };
}

beforeEach(async () => {
  now = new Date('2026-07-04T00:00:00.000Z');
  store = new InMemoryArtifactStore();
  configStore = new InMemoryConfigStore();
  controlPlane = new InMemoryControlPlaneStore();
  audit = new InMemoryAuditStore();
  await controlPlane.createOrg({ slug: 'acme' });
  await controlPlane.addOrgMember({
    org: 'acme',
    subject: 'owner-sub',
    email: 'owner@acme.test',
    role: 'owner',
  });
  await controlPlane.addOrgMember({
    org: 'acme',
    subject: 'dev-sub',
    email: 'dev@acme.test',
    role: 'developer',
  });
  registry = new ServerRegistry(store, undefined, configStore);
  handlerOptions = {
    configStore,
    controlPlaneStore: controlPlane,
    audit,
    clock: () => now,
    archiveRetentionDays: RETENTION_DAYS,
    deployGate: gate(),
    verifyOwnerToken: (token) =>
      Promise.resolve(token === OWNER_DATA_TOKEN ? { caller: { subject: 'owner-sub' } } : null),
  };
  http = createServer(createServiceHandler(registry, handlerOptions));
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => http.close((e) => (e ? reject(e) : resolve())));
});

function deploy(app: string, env = 'prod', token = 'owner-token'): Promise<Response> {
  return fetch(`${base}/v1/orgs/acme/apps/${app}/envs/${env}/deploy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ manifest: HELLO, serverVersion: '1' }),
  });
}

function appAction(action: 'archive' | 'restore', app: string, token = 'owner-token') {
  return fetch(`${base}/v1/orgs/acme/apps/${app}/${action}`, {
    method: 'POST',
    ...(token === '' ? {} : { headers: { authorization: `Bearer ${token}` } }),
  });
}

function initialize(url: string): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { ...JSON_HEADERS, authorization: `Bearer ${OWNER_DATA_TOKEN}` },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25' },
    }),
  });
}

function listDeployments(query = '', token = 'owner-token') {
  return fetch(`${base}/v1/orgs/acme/deployments${query}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

describe('app archive/restore control plane (ADR 0117)', () => {
  it('archives the whole app (all envs) as org owner and emits an audit event', async () => {
    expect((await deploy('hello', 'prod')).status).toBe(201);
    expect((await deploy('hello', 'staging')).status).toBe(201);

    const res = await appAction('archive', 'hello');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      target: { org: 'acme', app: 'hello' },
      archive: {
        archivedAt: now.toISOString(),
        archivedDeployments: 2,
        alreadyArchived: false,
      },
    });

    const events = await audit.list({ org: 'acme', eventType: 'app.archived' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      org: 'acme',
      app: 'hello',
      decision: 'allow',
      actorSubject: 'owner-sub',
    });
  });

  it('serves 410 Gone from the archived app MCP endpoints (versioned and default)', async () => {
    const deployed = await (await deploy('hello')).json();
    expect((await initialize(deployed.url)).status).toBe(200);

    expect((await appAction('archive', 'hello')).status).toBe(200);

    const versioned = await initialize(deployed.url);
    expect(versioned.status).toBe(410);
    expect((await versioned.json()).error).toContain('archived');
    expect((await initialize(deployed.defaultUrl)).status).toBe(410);
  });

  it('hides archived apps from the default deployments list and reveals them with ?archived=true', async () => {
    await deploy('hello');
    await deploy('keeper');
    await appAction('archive', 'hello');

    const visible = await (await listDeployments()).json();
    expect(visible.deployments.map((d: { appSlug: string }) => d.appSlug)).toEqual(['keeper']);

    const all = await (await listDeployments('?archived=true')).json();
    expect(all.deployments).toHaveLength(2);
    const archived = all.deployments.find((d: { appSlug: string }) => d.appSlug === 'hello');
    expect(archived.archivedAt).toBe(now.toISOString());
    const keeper = all.deployments.find((d: { appSlug: string }) => d.appSlug === 'keeper');
    expect(keeper.archivedAt).toBeUndefined();
  });

  it('rejects deploy and rollback to an archived app with 409 and audits the refusal', async () => {
    const first = await (await deploy('hello')).json();
    await appAction('archive', 'hello');

    const redeploy = await deploy('hello');
    expect(redeploy.status).toBe(409);
    expect((await redeploy.json()).error).toContain('archived');
    const deployRejections = await audit.list({ org: 'acme', eventType: 'deploy.rejected' });
    expect(deployRejections[0]).toMatchObject({ reasonCode: 'app_archived' });

    const rollback = await fetch(`${base}/v1/orgs/acme/apps/hello/envs/prod/rollback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer owner-token' },
      body: JSON.stringify({ deploymentId: first.deploymentId }),
    });
    expect(rollback.status).toBe(409);
    expect((await rollback.json()).error).toContain('archived');
    const rollbackRejections = await audit.list({ org: 'acme', eventType: 'rollback.rejected' });
    expect(rollbackRejections[0]).toMatchObject({ reasonCode: 'app_archived' });
  });

  it('re-archiving is a 200 no-op that keeps the original retention stamp', async () => {
    await deploy('hello');
    await appAction('archive', 'hello');
    const original = now.toISOString();
    now = new Date(now.getTime() + DAY_MS);

    const again = await appAction('archive', 'hello');
    expect(again.status).toBe(200);
    expect((await again.json()).archive).toEqual({
      archivedAt: original,
      archivedDeployments: 0,
      alreadyArchived: true,
    });
  });

  it('restores an archived app within the retention window and serves again', async () => {
    const deployed = await (await deploy('hello')).json();
    await appAction('archive', 'hello');
    now = new Date(now.getTime() + 5 * DAY_MS);

    const res = await appAction('restore', 'hello');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      target: { org: 'acme', app: 'hello' },
      restore: { restoredDeployments: 1, alreadyActive: false },
    });
    expect((await initialize(deployed.url)).status).toBe(200);
    const visible = await (await listDeployments()).json();
    expect(visible.deployments).toHaveLength(1);
    expect(await audit.list({ org: 'acme', eventType: 'app.restored' })).toHaveLength(1);
  });

  it('rejects restore when another app owns the customer OIDC binding', async () => {
    await store.append(customerRecord('hello-customer-11111111', 'hello'));
    await store.archiveApp('acme', 'hello', now.toISOString());
    await store.append(customerRecord('other-customer-22222222', 'other'));

    const res = await appAction('restore', 'hello');

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Customer OIDC issuer/audience bindings must be unique to one app and environment.',
      code: 'customer_auth_audience_conflict',
    });
    expect(await store.getAppArchivedAt('acme', 'hello')).toBe(now.toISOString());
    expect(await audit.list({ org: 'acme', eventType: 'app.restored' })).toHaveLength(0);
    expect(await audit.list({ org: 'acme', eventType: 'app.restore.rejected' })).toEqual([
      expect.objectContaining({
        status: '409',
        reasonCode: 'customer_auth_audience_conflict',
      }),
    ]);
  });

  it('restore of a live app is a 200 no-op', async () => {
    await deploy('hello');
    const res = await appAction('restore', 'hello');
    expect(res.status).toBe(200);
    expect((await res.json()).restore).toEqual({ restoredDeployments: 0, alreadyActive: true });
  });

  it('returns 404 for archive/restore of an unknown app', async () => {
    expect((await appAction('archive', 'ghost')).status).toBe(404);
    expect((await appAction('restore', 'ghost')).status).toBe(404);
  });

  it('refuses restore after the retention window with 410 Gone', async () => {
    await deploy('hello');
    await appAction('archive', 'hello');
    now = new Date(now.getTime() + (RETENTION_DAYS + 1) * DAY_MS);

    const res = await appAction('restore', 'hello');
    expect(res.status).toBe(410);
    expect((await res.json()).error).toContain('retention');
    const rejected = await audit.list({ org: 'acme', eventType: 'app.restore.rejected' });
    expect(rejected[0]).toMatchObject({ reasonCode: 'retention_elapsed' });
  });

  it('requires org-owner: a developer member gets 403 and no audit event', async () => {
    await deploy('hello');
    expect((await appAction('archive', 'hello', 'dev-token')).status).toBe(403);
    expect((await appAction('restore', 'hello', 'dev-token')).status).toBe(403);
    expect(await audit.list({ org: 'acme', eventType: 'app.archived' })).toHaveLength(0);
    // The developer can still deploy — archive is strictly stricter than deploy.
    expect((await deploy('hello', 'prod', 'dev-token')).status).toBe(201);
  });

  it('requires authentication: no token is 401', async () => {
    await deploy('hello');
    expect((await appAction('archive', 'hello', '')).status).toBe(401);
  });

  it('hard-deletes archived apps past retention on boot sweep, config included', async () => {
    await deploy('hello');
    await configStore.setConfigValue({
      kind: 'secret',
      scope: { level: 'app', org: 'acme', app: 'hello' },
      name: 'API_KEY',
      value: 'shh',
    });
    await configStore.setConfigValue({
      kind: 'variable',
      scope: { level: 'env', org: 'acme', app: 'hello', env: 'prod' },
      name: 'MODE',
      value: 'live',
    });
    await configStore.setConfigValue({
      kind: 'secret',
      scope: { level: 'org', org: 'acme' },
      name: 'ORG_WIDE',
      value: 'keep',
    });
    await appAction('archive', 'hello');
    now = new Date(now.getTime() + (RETENTION_DAYS + 1) * DAY_MS);

    // A fresh handler over the same registry = a service boot (ADR 0117 §3 boot sweep).
    createServiceHandler(registry, handlerOptions);

    // The purge audit event is emitted last, after records and config are gone — wait on it.
    await vi.waitFor(async () => {
      expect(await audit.list({ org: 'acme', eventType: 'app.purged' })).toHaveLength(1);
    });
    expect(await registry.listDeployments({ org: 'acme', includeArchived: true })).toHaveLength(0);
    expect(
      await configStore.listConfigValues('secret', { level: 'app', org: 'acme', app: 'hello' }),
    ).toHaveLength(0);
    expect(
      await configStore.listConfigValues('variable', {
        level: 'env',
        org: 'acme',
        app: 'hello',
        env: 'prod',
      }),
    ).toHaveLength(0);
    expect(
      await configStore.listConfigValues('secret', { level: 'org', org: 'acme' }),
    ).toHaveLength(1);
    const purged = await audit.list({ org: 'acme', eventType: 'app.purged' });
    expect(purged).toHaveLength(1);
    expect(purged[0]).toMatchObject({ org: 'acme', app: 'hello' });

    // After the sweep the records are gone: restore is a 404, not a 410.
    expect((await appAction('restore', 'hello')).status).toBe(404);
  });

  it('sweeps opportunistically from the deployments-list touchpoint', async () => {
    await deploy('hello');
    await appAction('archive', 'hello');
    now = new Date(now.getTime() + (RETENTION_DAYS + 1) * DAY_MS);

    expect((await listDeployments()).status).toBe(200);
    await vi.waitFor(async () => {
      expect(await registry.listDeployments({ org: 'acme', includeArchived: true })).toHaveLength(
        0,
      );
    });
  });
});

function customerRecord(deploymentId: string, app: string) {
  return {
    schemaVersion: 1 as const,
    deploymentId,
    orgSlug: 'acme',
    appSlug: app,
    environment: 'prod',
    serverVersion: '1',
    deploymentVersion: 1,
    active: true,
    serverName: app,
    createdAt: '2026-07-04T00:00:00.000Z',
    accessMode: 'customers' as const,
    serverAuth: CUSTOMER_AUTH,
    manifest: HELLO,
    secrets: { enc: 'none' as const, values: {} },
  };
}

describe('app archive without a durable store (in-memory registry)', () => {
  it('archives, blocks the data plane, and restores through the registry record map', async () => {
    const memRegistry = new ServerRegistry(undefined, undefined, configStore);
    const memHttp = createServer(
      createServiceHandler(memRegistry, { ...handlerOptions, audit: new InMemoryAuditStore() }),
    );
    await new Promise<void>((resolve) => memHttp.listen(0, '127.0.0.1', resolve));
    const { port } = memHttp.address() as AddressInfo;
    const memBase = `http://127.0.0.1:${port}`;
    try {
      const deployed = await (
        await fetch(`${memBase}/v1/orgs/acme/apps/hello/envs/prod/deploy`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer owner-token' },
          body: JSON.stringify({ manifest: HELLO, serverVersion: '1' }),
        })
      ).json();
      const init = (url: string) =>
        fetch(url, {
          method: 'POST',
          headers: { ...JSON_HEADERS, authorization: `Bearer ${OWNER_DATA_TOKEN}` },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: '2025-11-25' },
          }),
        });
      expect((await init(deployed.url)).status).toBe(200);

      const archive = await fetch(`${memBase}/v1/orgs/acme/apps/hello/archive`, {
        method: 'POST',
        headers: { authorization: 'Bearer owner-token' },
      });
      expect(archive.status).toBe(200);
      expect((await init(deployed.url)).status).toBe(410);
      expect(await memRegistry.listDeployments({ org: 'acme' })).toHaveLength(0);

      const restore = await fetch(`${memBase}/v1/orgs/acme/apps/hello/restore`, {
        method: 'POST',
        headers: { authorization: 'Bearer owner-token' },
      });
      expect(restore.status).toBe(200);
      expect((await init(deployed.url)).status).toBe(200);
    } finally {
      await new Promise<void>((resolve, reject) =>
        memHttp.close((e) => (e ? reject(e) : resolve())),
      );
    }
  });
});
