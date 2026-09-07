import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import {
  AppResponseSchema,
  AppSummarySchema,
  AppsListResponseSchema,
  DeploymentSummarySchema,
  OrgSummarySchema,
} from '@noodle-borg/wire-contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createServiceHandler,
  InMemoryArtifactStore,
  InMemoryControlPlaneStore,
  ServerRegistry,
  type ServiceOptions,
} from '../src/index.js';
import { summarizeApps } from '../src/store/records.js';
import type { DeploymentSummary } from '../src/store.js';

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

// ---------------------------------------------------------------------------
// Pure aggregation semantics (`summarizeApps`) — every rule from the contract, exercised directly
// against literal `DeploymentSummary` fixtures so timing/ordering is fully controlled.
// ---------------------------------------------------------------------------

function record(overrides: Partial<DeploymentSummary> & { appSlug: string }): DeploymentSummary {
  return {
    deploymentId: `${overrides.appSlug}-${overrides.environment ?? 'prod'}`,
    orgSlug: 'acme',
    environment: 'prod',
    active: false,
    serverName: overrides.appSlug,
    createdAt: '2026-01-01T00:00:00.000Z',
    accessMode: 'owner-only',
    ...overrides,
  };
}

describe('summarizeApps (pure aggregation)', () => {
  it('facing deployment: an active record beats a newer inactive one', () => {
    const records = [
      record({
        appSlug: 'web',
        environment: 'prod',
        active: true,
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
      record({
        appSlug: 'web',
        environment: 'staging',
        active: false,
        createdAt: '2026-02-01T00:00:00.000Z',
      }),
    ];
    const [summary] = summarizeApps('acme', records, [], { includeArchived: false });
    expect(summary?.latest?.environment).toBe('prod');
    expect(summary?.active).toBe(true);
  });

  it('facing deployment: the newest inactive record wins when nothing is active', () => {
    const records = [
      record({
        appSlug: 'web',
        environment: 'staging',
        active: false,
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
      record({
        appSlug: 'web',
        environment: 'dev',
        active: false,
        createdAt: '2026-03-01T00:00:00.000Z',
      }),
    ];
    const [summary] = summarizeApps('acme', records, [], { includeArchived: false });
    expect(summary?.latest?.environment).toBe('dev');
    expect(summary?.active).toBe(false);
  });

  it('ranks environments prod, staging, dev, then alphabetically', () => {
    const records = [
      record({ appSlug: 'web', environment: 'qa', createdAt: '2026-01-01T00:00:00.000Z' }),
      record({ appSlug: 'web', environment: 'dev', createdAt: '2026-01-02T00:00:00.000Z' }),
      record({ appSlug: 'web', environment: 'staging', createdAt: '2026-01-03T00:00:00.000Z' }),
      record({ appSlug: 'web', environment: 'prod', createdAt: '2026-01-04T00:00:00.000Z' }),
      record({ appSlug: 'web', environment: 'alpha', createdAt: '2026-01-05T00:00:00.000Z' }),
    ];
    const [summary] = summarizeApps('acme', records, [], { includeArchived: false });
    expect(summary?.environments).toEqual(['prod', 'staging', 'dev', 'alpha', 'qa']);
  });

  it('sorts apps by last activity desc, apps with no activity last, ties by slug asc', () => {
    const records = [
      record({ appSlug: 'bravo', createdAt: '2026-01-01T00:00:00.000Z' }),
      record({ appSlug: 'alpha', createdAt: '2026-03-01T00:00:00.000Z' }),
    ];
    const anchors = [{ appSlug: 'zeta', createdAt: '2025-01-01T00:00:00.000Z' }];
    const summaries = summarizeApps('acme', records, anchors, { includeArchived: false });
    expect(summaries.map((s) => s.appSlug)).toEqual(['alpha', 'bravo', 'zeta']);
  });

  it('excludes an archived app by default and surfaces archivedAt when included', () => {
    const records = [
      record({ appSlug: 'archived-app', archivedAt: '2026-05-01T00:00:00.000Z' }),
      record({ appSlug: 'live-app' }),
    ];
    const hidden = summarizeApps('acme', records, [], { includeArchived: false });
    expect(hidden.map((s) => s.appSlug)).toEqual(['live-app']);

    const shown = summarizeApps('acme', records, [], { includeArchived: true });
    const archived = shown.find((s) => s.appSlug === 'archived-app');
    expect(archived?.archivedAt).toBe('2026-05-01T00:00:00.000Z');
  });

  it('lists an anchor app with zero deploy records using the anchor createdAt', () => {
    const anchors = [{ appSlug: 'empty-app', createdAt: '2025-06-01T00:00:00.000Z' }];
    const [summary] = summarizeApps('acme', [], anchors, { includeArchived: false });
    expect(summary).toMatchObject({
      orgSlug: 'acme',
      appSlug: 'empty-app',
      environments: [],
      active: false,
      createdAt: '2025-06-01T00:00:00.000Z',
    });
    expect(summary?.latest).toBeUndefined();
    expect(summary?.lastActivityAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Route-level behaviour
// ---------------------------------------------------------------------------

let http: Server;
let base: string;
let store: InMemoryArtifactStore;
let controlPlane: InMemoryControlPlaneStore;
let registry: ServerRegistry;

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
      if (token === 'admin-token') {
        return Promise.resolve({
          ok: true as const,
          identity: { subject: 'admin-sub', email: 'admin@noodleseed.com', superAdmin: true },
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
  const options: ServiceOptions = { controlPlaneStore: controlPlane, deployGate: gate() };
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('GET /v1/orgs/{org} (org inspect)', () => {
  it('200s with the org summary shape', async () => {
    const res = await fetch(`${base}/v1/orgs/acme`, { headers: authHeader('owner-token') });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, data: { slug: 'acme' } });
    expect(() => OrgSummarySchema.parse(body.data)).not.toThrow();
  });

  it('404s for an unknown org', async () => {
    const res = await fetch(`${base}/v1/orgs/ghost`, { headers: authHeader('admin-token') });
    expect(res.status).toBe(404);
  });

  it('403s for a non-member', async () => {
    const res = await fetch(`${base}/v1/orgs/acme`, { headers: authHeader('outsider-token') });
    expect(res.status).toBe(403);
  });
});

describe('GET /v1/orgs/{org}/apps (apps list)', () => {
  it('groups multiple deployments of the same app into one AppSummary with ranked environments', async () => {
    expect((await deploy('web', 'staging')).status).toBe(201);
    await sleep(5);
    expect((await deploy('web', 'prod')).status).toBe(201);

    const res = await fetch(`${base}/v1/orgs/acme/apps`, { headers: authHeader('owner-token') });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(() => AppsListResponseSchema.parse(body)).not.toThrow();
    expect(body.data.apps).toHaveLength(1);
    expect(body.data.apps[0]).toMatchObject({ appSlug: 'web', environments: ['prod', 'staging'] });
    expect(body.data.truncated).toBe(false);
  });

  it('sorts by most recent activity', async () => {
    expect((await deploy('older')).status).toBe(201);
    await sleep(5);
    expect((await deploy('newer')).status).toBe(201);

    const res = await fetch(`${base}/v1/orgs/acme/apps`, { headers: authHeader('owner-token') });
    const body = await res.json();
    expect(body.data.apps.map((a: { appSlug: string }) => a.appSlug)).toEqual(['newer', 'older']);
  });

  it('excludes archived apps by default and includes them with ?archived=true', async () => {
    expect((await deploy('to-archive')).status).toBe(201);
    const archiveRes = await fetch(`${base}/v1/orgs/acme/apps/to-archive/archive`, {
      method: 'POST',
      headers: authHeader('owner-token'),
    });
    expect(archiveRes.status).toBe(200);

    const hidden = await fetch(`${base}/v1/orgs/acme/apps`, { headers: authHeader('owner-token') });
    expect((await hidden.json()).data.apps).toEqual([]);

    const shown = await fetch(`${base}/v1/orgs/acme/apps?archived=true`, {
      headers: authHeader('owner-token'),
    });
    const shownBody = await shown.json();
    expect(shownBody.data.apps).toHaveLength(1);
    expect(shownBody.data.apps[0]).toMatchObject({ appSlug: 'to-archive' });
    expect(shownBody.data.apps[0].archivedAt).toEqual(expect.any(String));
  });

  it('caps results at ?limit and reports truncated:true', async () => {
    await deploy('app-a');
    await deploy('app-b');
    await deploy('app-c');

    const res = await fetch(`${base}/v1/orgs/acme/apps?limit=2`, {
      headers: authHeader('owner-token'),
    });
    const body = await res.json();
    expect(body.data.apps).toHaveLength(2);
    expect(body.data.truncated).toBe(true);
  });

  it('403s for a non-member', async () => {
    const res = await fetch(`${base}/v1/orgs/acme/apps`, { headers: authHeader('outsider-token') });
    expect(res.status).toBe(403);
  });
});

describe('GET /v1/orgs/{org}/apps/{app} (app inspect)', () => {
  it('200s with the app summary shape', async () => {
    expect((await deploy('hello')).status).toBe(201);
    const res = await fetch(`${base}/v1/orgs/acme/apps/hello`, {
      headers: authHeader('owner-token'),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, data: { appSlug: 'hello', active: true } });
    expect(() => AppSummarySchema.parse(body.data)).not.toThrow();
  });

  it('404s for an app with no deployments', async () => {
    const res = await fetch(`${base}/v1/orgs/acme/apps/ghost`, {
      headers: authHeader('owner-token'),
    });
    expect(res.status).toBe(404);
  });
});

describe('contract fixtures parse against the Zod schemas', () => {
  const contractDir = join(import.meta.dirname, '..', '..', '..', 'contract', 'v1');

  function readFixture(name: string): unknown {
    return JSON.parse(readFileSync(join(contractDir, name), 'utf8'));
  }

  it('org-summary.json parses as an OrgSummary', () => {
    expect(() => OrgSummarySchema.parse(readFixture('org-summary.json'))).not.toThrow();
  });

  it('app-response.json parses as an AppResponse', () => {
    expect(() => AppResponseSchema.parse(readFixture('app-response.json'))).not.toThrow();
  });

  it('apps-list-response.json parses as an AppsListResponse', () => {
    expect(() =>
      AppsListResponseSchema.parse(readFixture('apps-list-response.json')),
    ).not.toThrow();
  });

  it('keeps response provenance forward-compatible for ordinary fallback behavior', () => {
    expect(() =>
      DeploymentSummarySchema.parse({
        deploymentId: 'dep-1',
        orgSlug: 'acme',
        appSlug: 'hello',
        environment: 'prod',
        active: true,
        serverName: 'hello',
        createdAt: '2026-07-15T00:00:00Z',
        deploymentSource: 'future-source',
        accessMode: 'owner-only',
      }),
    ).not.toThrow();
  });
});
