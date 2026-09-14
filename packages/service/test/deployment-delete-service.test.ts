import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ControlPlaneIdentity,
  createServiceHandler,
  type DeployAuthGate,
  type DeployRecord,
  InMemoryArtifactStore,
  InMemoryAuditStore,
  InMemoryControlPlaneStore,
  ServerRegistry,
} from '../src/index.js';

const TARGET = { org: 'acme', app: 'hello', env: 'dev' };
let service: { url: string; registry: ServerRegistry; close: () => Promise<void> };
let http: Server;
let store: InMemoryArtifactStore;
let audit: InMemoryAuditStore;
const versionPath = '/v1/orgs/acme/apps/hello/envs/dev/versions/1';

beforeEach(async () => {
  store = new InMemoryArtifactStore();
  audit = new InMemoryAuditStore();
  const controlPlane = new InMemoryControlPlaneStore();
  await controlPlane.createOrg({ slug: 'acme' });
  await controlPlane.addOrgMember({
    org: 'acme',
    subject: 'owner',
    email: 'owner@example.test',
    role: 'owner',
  });
  await controlPlane.addOrgMember({
    org: 'acme',
    subject: 'member',
    email: 'member@example.test',
    role: 'developer',
  });
  const identities = new Map<string, ControlPlaneIdentity>([
    ['owner', { subject: 'owner', email: 'owner@example.test', superAdmin: false }],
    ['member', { subject: 'member', email: 'member@example.test', superAdmin: false }],
    ['admin', { subject: 'admin', email: 'admin@example.test', superAdmin: true }],
    [
      'delegated',
      {
        subject: 'owner',
        email: 'owner@example.test',
        superAdmin: true,
        developerGrantId: 'restricted',
      },
    ],
  ]);
  const deployGate: DeployAuthGate = {
    authorize: (req) => {
      const identity = identities.get(req.headers.authorization?.replace('Bearer ', '') ?? '');
      return identity ? { ok: true, identity } : { ok: false, status: 401, message: 'sign in' };
    },
  };
  const registry = new ServerRegistry(store);
  http = createServer(
    createServiceHandler(registry, { audit, controlPlaneStore: controlPlane, deployGate }),
  );
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  service = {
    registry,
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      ),
  };
  for (const record of [recordFor('old', false), recordFor('live', true)])
    await store.append(record);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await service.close();
});

function recordFor(id: string, active: boolean, version = '1'): DeployRecord {
  return {
    schemaVersion: 1,
    deploymentId: `hello-${id}`,
    orgSlug: TARGET.org,
    appSlug: TARGET.app,
    environment: TARGET.env,
    deploymentVersion: active ? 2 : 1,
    active,
    serverName: 'hello',
    serverVersion: version,
    createdAt: '2026-09-14T00:00:00Z',
    accessMode: 'owner-only',
    manifest: 'manifestVersion: "1"\n',
    secrets: { enc: 'none', values: {} },
  };
}
function remove(path: string, body?: unknown, token: string | null = 'owner') {
  return fetch(service.url + path, {
    method: 'DELETE',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('deployment deletion service', () => {
  it('deletes history and returns only safe, exact mutation evidence', async () => {
    const response = await remove('/v1/orgs/acme/deployments/hello-old');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      target: TARGET,
      deletedDeploymentIds: ['hello-old'],
      auditRecorded: true,
    });
    expect(await store.get('hello-old')).toBeUndefined();
    expect(await store.get('hello-live')).toBeDefined();
    expect((await remove('/v1/orgs/acme/deployments/hello-old')).status).toBe(404);
    expect(await audit.list({ org: 'acme' })).toContainEqual(
      expect.objectContaining({
        eventType: 'deployment.deleted',
        deploymentId: 'hello-old',
        actorSubject: 'owner',
      }),
    );
  });
  it.each([
    ['member', 403],
    ['delegated', 403],
    [null, 401],
  ] as const)('rejects %s before touching deployment state', async (token, status) => {
    const spy = vi.spyOn(service.registry, 'getDeployment');
    expect((await remove('/v1/orgs/acme/deployments/hello-old', undefined, token)).status).toBe(
      status,
    );
    expect(spy).not.toHaveBeenCalled();
    expect(await store.get('hello-old')).toBeDefined();
  });
  it('conceals foreign deployments and allows existing super-admin authority', async () => {
    expect((await remove('/v1/orgs/other/deployments/hello-old', undefined, 'admin')).status).toBe(
      404,
    );
    expect((await remove('/v1/orgs/acme/deployments/hello-old', undefined, 'admin')).status).toBe(
      200,
    );
  });
  it('requires rollback before deleting the live deployment', async () => {
    const response = await remove('/v1/orgs/acme/deployments/hello-live');
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'active_deployment' });
    expect(await store.get('hello-live')).toBeDefined();
  });
  it('deletes all exact-version deployments while preserving a distinct dotted version', async () => {
    await store.append(recordFor('other', true, '1.0.0'));
    const response = await remove(versionPath, {
      expectedDeploymentIds: ['hello-live', 'hello-old'],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      target: TARGET,
      deletedDeploymentIds: expect.arrayContaining(['hello-old', 'hello-live']),
    });
    expect((await store.loadAll()).map((r) => r.deploymentId)).toEqual(['hello-other']);
  });
  it('rejects changed inventory and malformed confirmations without partial deletion', async () => {
    for (const [body, status] of [
      [{ expectedDeploymentIds: ['hello-old'] }, 409],
      [{ expectedDeploymentIds: [] }, 400],
      [{ expectedDeploymentIds: ['hello-old', 'hello-old'] }, 400],
      [{ expectedDeploymentIds: ['hello-old', 'hello-live'], all: true }, 400],
    ] as const)
      expect((await remove(versionPath, body)).status).toBe(status);
    expect(await store.loadAll()).toHaveLength(2);
  });
  it('preserves committed deletion when audit recording fails', async () => {
    vi.spyOn(audit, 'emit').mockRejectedValue(new Error('audit down'));
    const response = await remove('/v1/orgs/acme/deployments/hello-old');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ auditRecorded: false });
    expect(await store.get('hello-old')).toBeUndefined();
  });
});
