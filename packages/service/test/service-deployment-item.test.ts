import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { sha256Canonical } from '@noodle-borg/compiler';
import { noopLogger } from '@noodle-borg/transport-http';
import {
  DeploymentPackageResponseShapeSchema as DeploymentPackageResponseSchema,
  DeploymentResponseSchema,
} from '@noodle-borg/wire-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createServiceHandler,
  InMemoryArtifactStore,
  InMemoryControlPlaneStore,
  InMemoryDeveloperGrantStore,
  ServerRegistry,
  type ServiceOptions,
} from '../src/index.js';
import type { DeployRecord } from '../src/store.js';

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

const GUIDED = readFileSync(
  join(import.meta.dirname, 'fixtures/app-package-guided-v2.yaml'),
  'utf8',
);

// ---------------------------------------------------------------------------
// Route-level behaviour
// ---------------------------------------------------------------------------

let http: Server;
let base: string;
let store: InMemoryArtifactStore;
let controlPlane: InMemoryControlPlaneStore;
let registry: ServerRegistry;
let warn: ReturnType<typeof vi.fn>;

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
      if (token === 'outsider-token') {
        return Promise.resolve({
          ok: true as const,
          identity: { subject: 'outsider-sub', email: 'outsider@example.com', superAdmin: false },
        });
      }
      return Promise.resolve({ ok: false as const, status: 401, message: 'missing bearer token' });
    },
  };
}

function authHeader(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

beforeEach(async () => {
  store = new InMemoryArtifactStore();
  controlPlane = new InMemoryControlPlaneStore();
  await controlPlane.createOrg({ slug: 'acme' });
  await controlPlane.addOrgMember({
    org: 'acme',
    subject: 'owner-sub',
    email: 'owner@acme.test',
    role: 'owner',
  });
  registry = new ServerRegistry(store);
  warn = vi.fn();
  const options: ServiceOptions = {
    controlPlaneStore: controlPlane,
    deployGate: gate(),
    logger: { ...noopLogger, warn },
  };
  http = createServer(createServiceHandler(registry, options));
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
    headers: { 'content-type': 'application/json', ...authHeader(token) },
    body: JSON.stringify({ manifest: HELLO, serverVersion: '1' }),
  });
}

function deployGuided(app: string, env = 'prod', token = 'owner-token'): Promise<Response> {
  return fetch(`${base}/v1/orgs/acme/apps/${app}/envs/${env}/deploy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeader(token) },
    body: JSON.stringify({ manifest: GUIDED, serverVersion: '1' }),
  });
}

async function restartService(options: ServiceOptions): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    http.close((error) => (error ? reject(error) : resolve())),
  );
  http = createServer(createServiceHandler(registry, options));
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const OTHER_ORG_RECORD: DeployRecord = {
  schemaVersion: 1,
  deploymentId: 'other-hello-99999999',
  orgSlug: 'beta',
  appSlug: 'hello',
  environment: 'prod',
  deploymentVersion: 1,
  active: true,
  serverName: 'hello',
  createdAt: '2026-06-01T00:00:00.000Z',
  accessMode: 'owner-only',
  manifest: 'manifestVersion: "1"\n',
  secrets: { enc: 'none', values: {} },
};

describe('GET /v1/orgs/{org}/deployments/{deploymentId} (deployment inspect)', () => {
  it('200s with the deployment summary shape', async () => {
    const deployRes = await deploy('hello');
    expect(deployRes.status).toBe(201);
    const { deploymentId } = (await deployRes.json()) as { deploymentId: string };

    const res = await fetch(`${base}/v1/orgs/acme/deployments/${deploymentId}`, {
      headers: authHeader('owner-token'),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      data: { deploymentId, orgSlug: 'acme', appSlug: 'hello', environment: 'prod', active: true },
    });
    expect(() => DeploymentResponseSchema.parse(body)).not.toThrow();
  });

  it('200s for an archived deployment, with archivedAt present', async () => {
    const deployRes = await deploy('to-archive');
    expect(deployRes.status).toBe(201);
    const { deploymentId } = (await deployRes.json()) as { deploymentId: string };

    const archiveRes = await fetch(`${base}/v1/orgs/acme/apps/to-archive/archive`, {
      method: 'POST',
      headers: authHeader('owner-token'),
    });
    expect(archiveRes.status).toBe(200);

    const res = await fetch(`${base}/v1/orgs/acme/deployments/${deploymentId}`, {
      headers: authHeader('owner-token'),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.archivedAt).toEqual(expect.any(String));
    expect(() => DeploymentResponseSchema.parse(body)).not.toThrow();
  });

  it('404s for an unknown deployment id', async () => {
    const res = await fetch(`${base}/v1/orgs/acme/deployments/ghost-00000000`, {
      headers: authHeader('owner-token'),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'unknown deployment' });
  });

  it('404s (never 200) for a deployment id that belongs to a different org', async () => {
    await store.append(OTHER_ORG_RECORD);

    const res = await fetch(`${base}/v1/orgs/acme/deployments/${OTHER_ORG_RECORD.deploymentId}`, {
      headers: authHeader('owner-token'),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'unknown deployment' });
  });

  it('403s for a non-member', async () => {
    const deployRes = await deploy('hello');
    const { deploymentId } = (await deployRes.json()) as { deploymentId: string };

    const res = await fetch(`${base}/v1/orgs/acme/deployments/${deploymentId}`, {
      headers: authHeader('outsider-token'),
    });
    expect(res.status).toBe(403);
  });
});

describe('GET /v1/orgs/{org}/deployments/{deploymentId}/package', () => {
  it('returns the exact immutable snapshot with a private ETag and honors conditional reads', async () => {
    const deployRes = await deployGuided('guided-package');
    expect(deployRes.status).toBe(201);
    const { deploymentId } = (await deployRes.json()) as { deploymentId: string };
    const stored = await registry.getDeploymentPackage('acme', deploymentId);
    expect(stored).toBeDefined();

    const res = await fetch(`${base}/v1/orgs/acme/deployments/${deploymentId}/package`, {
      headers: authHeader('owner-token'),
    });
    expect(res.status).toBe(200);
    const etag = res.headers.get('etag');
    expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
    expect(etag).not.toBe(`"${stored?.snapshot.snapshotSha256}"`);
    expect(res.headers.get('cache-control')).toBe('private, no-cache');
    const body = await res.json();
    expect(body).toEqual({ ok: true, data: stored });
    expect(() => DeploymentPackageResponseSchema.parse(body)).not.toThrow();

    const conditional = await fetch(`${base}/v1/orgs/acme/deployments/${deploymentId}/package`, {
      headers: {
        ...authHeader('owner-token'),
        'if-none-match': etag as string,
      },
    });
    expect(conditional.status).toBe(304);
    expect(conditional.headers.get('etag')).toBe(etag);
    expect(conditional.headers.get('cache-control')).toBe('private, no-cache');
    expect(await conditional.text()).toBe('');

    for (const ifNoneMatch of [`W/${etag}`, `"unrelated", W/${etag}`, '*']) {
      const variant = await fetch(`${base}/v1/orgs/acme/deployments/${deploymentId}/package`, {
        headers: { ...authHeader('owner-token'), 'if-none-match': ifNoneMatch },
      });
      expect(variant.status, ifNoneMatch).toBe(304);
      expect(await variant.text()).toBe('');
    }
  });

  it('changes the ETag when activation or archive metadata changes the response', async () => {
    const firstDeploy = await deployGuided('guided-representation');
    const { deploymentId } = (await firstDeploy.json()) as { deploymentId: string };
    const first = await fetch(`${base}/v1/orgs/acme/deployments/${deploymentId}/package`, {
      headers: authHeader('owner-token'),
    });
    const activeEtag = first.headers.get('etag') as string;
    expect(first.status).toBe(200);

    expect((await deployGuided('guided-representation')).status).toBe(201);
    const inactive = await fetch(`${base}/v1/orgs/acme/deployments/${deploymentId}/package`, {
      headers: { ...authHeader('owner-token'), 'if-none-match': activeEtag },
    });
    const inactiveEtag = inactive.headers.get('etag') as string;
    expect(inactive.status).toBe(200);
    expect(inactiveEtag).not.toBe(activeEtag);
    expect((await inactive.json()).data.active).toBe(false);

    const archive = await fetch(`${base}/v1/orgs/acme/apps/guided-representation/archive`, {
      method: 'POST',
      headers: authHeader('owner-token'),
    });
    expect(archive.status).toBe(200);
    const archived = await fetch(`${base}/v1/orgs/acme/deployments/${deploymentId}/package`, {
      headers: { ...authHeader('owner-token'), 'if-none-match': inactiveEtag },
    });
    expect(archived.status).toBe(200);
    expect(archived.headers.get('etag')).not.toBe(inactiveEtag);
    expect((await archived.json()).data.archivedAt).toEqual(expect.any(String));
  });

  it('keeps an archived historical package readable with its original snapshot identity', async () => {
    const deployRes = await deployGuided('guided-archive');
    expect(deployRes.status).toBe(201);
    const { deploymentId } = (await deployRes.json()) as { deploymentId: string };
    const original = await registry.getDeploymentPackage('acme', deploymentId);

    const archiveRes = await fetch(`${base}/v1/orgs/acme/apps/guided-archive/archive`, {
      method: 'POST',
      headers: authHeader('owner-token'),
    });
    expect(archiveRes.status).toBe(200);

    const res = await fetch(`${base}/v1/orgs/acme/deployments/${deploymentId}/package`, {
      headers: authHeader('owner-token'),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.archivedAt).toEqual(expect.any(String));
    expect(body.data.snapshot).toEqual(original?.snapshot);
  });

  it('authenticates membership before package lookup and preserves 401/403 behavior', async () => {
    const deployRes = await deployGuided('guided-auth');
    const { deploymentId } = (await deployRes.json()) as { deploymentId: string };
    const deploymentLookup = vi.spyOn(registry, 'getDeployment');
    const packageLookup = vi.spyOn(registry, 'getDeploymentPackage');

    const missing = await fetch(`${base}/v1/orgs/acme/deployments/${deploymentId}/package`);
    expect(missing.status).toBe(401);
    const outsider = await fetch(`${base}/v1/orgs/acme/deployments/${deploymentId}/package`, {
      headers: authHeader('outsider-token'),
    });
    expect(outsider.status).toBe(403);
    expect(deploymentLookup).not.toHaveBeenCalled();
    expect(packageLookup).not.toHaveBeenCalled();
  });

  it('returns one indistinguishable 404 for unknown and cross-org deployments while live grants see every environment', async () => {
    const deployRes = await deployGuided('guided-prod');
    const { deploymentId } = (await deployRes.json()) as { deploymentId: string };
    await store.append(OTHER_ORG_RECORD);
    const packageLookup = vi.spyOn(registry, 'getDeploymentPackage');

    const unknown = await fetch(`${base}/v1/orgs/acme/deployments/ghost-00000000/package`, {
      headers: authHeader('owner-token'),
    });
    const crossOrg = await fetch(
      `${base}/v1/orgs/acme/deployments/${OTHER_ORG_RECORD.deploymentId}/package`,
      { headers: authHeader('owner-token') },
    );
    expect(unknown.status).toBe(404);
    expect(crossOrg.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'unknown deployment' });
    expect(await crossOrg.json()).toEqual({ error: 'unknown deployment' });
    expect(packageLookup).not.toHaveBeenCalled();

    const grants = new InMemoryDeveloperGrantStore({ id: () => 'grant-1' });
    await grants.getOrCreateActive({
      clientId: 'client-1',
      subject: 'owner-sub',
      resource: 'https://cloud.noodleseed.com/developer/cli',
      capabilities: ['cloud:read'],
    });
    await restartService({
      controlPlaneStore: controlPlane,
      developerGrantStore: grants,
      deployGate: {
        authorize: () =>
          Promise.resolve({
            ok: true,
            identity: {
              subject: 'owner-sub',
              email: 'owner@acme.test',
              superAdmin: true,
              developerGrantId: 'grant-1',
              oauthClientId: 'client-1',
            },
          }),
      },
    });
    const liveGrant = await fetch(`${base}/v1/orgs/acme/deployments/${deploymentId}/package`, {
      headers: authHeader('owner-token'),
    });
    expect(liveGrant.status).toBe(200);
    expect(packageLookup).toHaveBeenCalledWith('acme', deploymentId);
  });

  it.each([
    'absent',
    'malformed',
  ] as const)('returns content-free package_unavailable for an %s legacy snapshot', async (kind) => {
    const deploymentId = `legacy-${kind}-00000001`;
    const record = {
      ...OTHER_ORG_RECORD,
      deploymentId,
      orgSlug: 'acme',
      appSlug: `legacy-${kind}`,
      ...(kind === 'malformed'
        ? { appPackageSnapshot: { schemaVersion: 1, artifact: { capability: 'must-not-leak' } } }
        : {}),
    } as unknown as DeployRecord;
    await store.append(record);

    const res = await fetch(`${base}/v1/orgs/acme/deployments/${deploymentId}/package`, {
      headers: authHeader('owner-token'),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      code: 'package_unavailable',
      error: 'deployment package is unavailable',
      next: 'noodle deploy',
    });
  });

  it('fails closed without content when a stored file exceeds the 64 KiB bound', async () => {
    const size = 64 * 1024 + 1;
    const deployRes = await deployGuided(`guided-oversize-${size}`);
    const { deploymentId } = (await deployRes.json()) as { deploymentId: string };
    const stored = await registry.getDeploymentPackage('acme', deploymentId);
    expect(stored).toBeDefined();
    if (stored === undefined) return;
    const content = `secret-capability-${'x'.repeat(size)}`;
    const files = stored.snapshot.files.map((file, index) =>
      index === 0
        ? {
            ...file,
            content,
            sha256: sha256(content),
            byteLength: Buffer.byteLength(content),
          }
        : file,
    );
    vi.spyOn(registry, 'getDeploymentPackage').mockResolvedValue({
      ...stored,
      snapshot: { ...stored.snapshot, files },
    });

    const res = await fetch(`${base}/v1/orgs/acme/deployments/${deploymentId}/package`, {
      headers: authHeader('owner-token'),
    });
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(text).not.toContain('secret-capability');
    expect(JSON.parse(text)).toEqual({
      code: 'package_unavailable',
      error: 'deployment package is unavailable',
      next: 'noodle deploy',
    });
    expect(warn).toHaveBeenCalledWith('deployment_package.invalid_snapshot', {
      reason: 'schema_validation_failed',
    });
  });

  it('fails closed without content when the serialized snapshot exceeds 1 MiB', async () => {
    const deployRes = await deployGuided('guided-serialized-oversize');
    const { deploymentId } = (await deployRes.json()) as { deploymentId: string };
    const stored = await registry.getDeploymentPackage('acme', deploymentId);
    expect(stored).toBeDefined();
    if (stored === undefined) return;

    const makeSnapshot = (files: typeof stored.snapshot.files) => ({
      ...stored.snapshot,
      files,
      snapshotSha256: sha256Canonical({
        artifact: stored.snapshot.artifact,
        rendererVersion: stored.snapshot.rendererVersion,
        files: files.map(({ target, path, sha256, byteLength }) => ({
          target,
          path,
          sha256,
          byteLength,
        })),
      }),
    });
    const baseline = makeSnapshot(stored.snapshot.files);
    const extra = 1024 * 1024 + 1 - Buffer.byteLength(JSON.stringify(baseline), 'utf8');
    const files = stored.snapshot.files.map((file, index) =>
      index === 0 ? { ...file, path: `${file.path}${'p'.repeat(extra)}` } : file,
    );
    const oversized = makeSnapshot(files);
    expect(Buffer.byteLength(JSON.stringify(oversized), 'utf8')).toBe(1024 * 1024 + 1);
    vi.spyOn(registry, 'getDeploymentPackage').mockResolvedValue({
      ...stored,
      snapshot: oversized,
    });

    const res = await fetch(`${base}/v1/orgs/acme/deployments/${deploymentId}/package`, {
      headers: authHeader('owner-token'),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      code: 'package_unavailable',
      error: 'deployment package is unavailable',
      next: 'noodle deploy',
    });
  });
});

describe('contract fixtures parse against the Zod schemas', () => {
  const contractDir = join(import.meta.dirname, '..', '..', '..', 'contract', 'v1');

  function readFixture(name: string): unknown {
    return JSON.parse(readFileSync(join(contractDir, name), 'utf8'));
  }

  it('deployment-response.json parses as a DeploymentResponse', () => {
    expect(() =>
      DeploymentResponseSchema.parse(readFixture('deployment-response.json')),
    ).not.toThrow();
  });

  it('deployment-package-response.json parses as a DeploymentPackageResponse', () => {
    expect(() =>
      DeploymentPackageResponseSchema.parse(readFixture('deployment-package-response.json')),
    ).not.toThrow();
  });
});
