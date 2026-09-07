import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import {
  EnvResponseSchema,
  EnvSummarySchema,
  EnvsListResponseSchema,
  ProductionEnvironmentResponseSchema,
} from '@noodle-borg/wire-contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createServiceHandler,
  InMemoryArtifactStore,
  InMemoryAuditStore,
  InMemoryControlPlaneStore,
  ServerRegistry,
  type ServiceOptions,
} from '../src/index.js';
import { summarizeEnvs } from '../src/store/records.js';
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
// Pure aggregation semantics (`summarizeEnvs`) — every rule from the contract, exercised directly
// against literal `DeploymentSummary` fixtures so timing/ordering is fully controlled.
// ---------------------------------------------------------------------------

function record(
  overrides: Partial<DeploymentSummary> & { environment: string },
): DeploymentSummary {
  return {
    deploymentId: `web-${overrides.environment}`,
    orgSlug: 'acme',
    appSlug: 'web',
    active: false,
    serverName: 'web',
    createdAt: '2026-01-01T00:00:00.000Z',
    accessMode: 'owner-only',
    ...overrides,
  };
}

describe('summarizeEnvs (pure aggregation)', () => {
  it('facing deployment: an active record beats a newer inactive one in the same env', () => {
    const records = [
      record({ environment: 'prod', active: true, createdAt: '2026-01-01T00:00:00.000Z' }),
      record({
        environment: 'prod',
        deploymentId: 'web-prod-2',
        active: false,
        createdAt: '2026-02-01T00:00:00.000Z',
      }),
    ];
    const [summary] = summarizeEnvs('acme', 'web', records, [], { includeArchived: false });
    expect(summary?.active).toBe(true);
    expect(summary?.latest?.deploymentId).toBe('web-prod');
  });

  it('facing deployment: the newest inactive record wins when nothing is active', () => {
    const records = [
      record({ environment: 'staging', active: false, createdAt: '2026-01-01T00:00:00.000Z' }),
      record({
        environment: 'staging',
        deploymentId: 'web-staging-2',
        active: false,
        createdAt: '2026-03-01T00:00:00.000Z',
      }),
    ];
    const [summary] = summarizeEnvs('acme', 'web', records, [], { includeArchived: false });
    expect(summary?.active).toBe(false);
    expect(summary?.latest?.deploymentId).toBe('web-staging-2');
  });

  it('marks and ranks an explicitly designated custom production environment first', () => {
    const records = [
      record({ environment: 'qa', createdAt: '2026-01-05T00:00:00.000Z' }),
      record({ environment: 'dev', createdAt: '2026-01-01T00:00:00.000Z' }),
      record({ environment: 'staging', createdAt: '2026-01-02T00:00:00.000Z' }),
      record({ environment: 'prod', createdAt: '2026-01-03T00:00:00.000Z' }),
      record({ environment: 'alpha', createdAt: '2026-01-04T00:00:00.000Z' }),
    ];
    const summaries = summarizeEnvs('acme', 'web', records, [], {
      includeArchived: false,
      productionEnvironment: 'qa',
    });
    expect(summaries.map((s) => s.envName)).toEqual(['qa', 'alpha', 'dev', 'prod', 'staging']);
    expect(summaries.map((s) => [s.envName, s.isProduction])).toEqual([
      ['qa', true],
      ['alpha', false],
      ['dev', false],
      ['prod', false],
      ['staging', false],
    ]);
  });

  it('migrates a legacy prod name, a sole custom env, and leaves ambiguous custom envs unresolved', () => {
    const legacyProd = summarizeEnvs(
      'acme',
      'web',
      [record({ environment: 'prod' }), record({ environment: 'preview' })],
      [],
      { includeArchived: false },
    );
    expect(legacyProd.find((env) => env.envName === 'prod')?.isProduction).toBe(true);

    const soleCustom = summarizeEnvs('acme', 'web', [record({ environment: 'happy-hour' })], [], {
      includeArchived: false,
    });
    expect(soleCustom[0]?.isProduction).toBe(true);

    const ambiguous = summarizeEnvs(
      'acme',
      'web',
      [record({ environment: 'happy-hour' }), record({ environment: 'preview' })],
      [],
      { includeArchived: false },
    );
    expect(ambiguous.every((env) => !env.isProduction)).toBe(true);
  });

  it('deploymentCount respects archived filtering independent of exclusion', () => {
    const records = [
      record({
        environment: 'prod',
        deploymentId: 'web-prod-old',
        active: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        archivedAt: '2026-01-01T00:00:00.000Z',
      }),
      record({
        environment: 'prod',
        deploymentId: 'web-prod-new',
        active: true,
        createdAt: '2026-02-01T00:00:00.000Z',
      }),
    ];
    const excluded = summarizeEnvs('acme', 'web', records, [], { includeArchived: false });
    expect(excluded[0]?.deploymentCount).toBe(1); // only the live facing record counted
    expect(excluded[0]?.archivedAt).toBeUndefined();

    const included = summarizeEnvs('acme', 'web', records, [], { includeArchived: true });
    expect(included[0]?.deploymentCount).toBe(2); // both records counted once included
  });

  it('excludes an archived env by default and surfaces archivedAt when included', () => {
    const records = [
      record({
        environment: 'prod',
        archivedAt: '2026-05-01T00:00:00.000Z',
      }),
      record({ environment: 'staging' }),
    ];
    const hidden = summarizeEnvs('acme', 'web', records, [], { includeArchived: false });
    expect(hidden.map((s) => s.envName)).toEqual(['staging']);

    const shown = summarizeEnvs('acme', 'web', records, [], { includeArchived: true });
    const archived = shown.find((s) => s.envName === 'prod');
    expect(archived?.archivedAt).toBe('2026-05-01T00:00:00.000Z');
  });

  it('lists an anchor env with zero deploy records using the anchor createdAt', () => {
    const anchors = [{ envName: 'empty-env', createdAt: '2025-06-01T00:00:00.000Z' }];
    const [summary] = summarizeEnvs('acme', 'web', [], anchors, { includeArchived: false });
    expect(summary).toMatchObject({
      orgSlug: 'acme',
      appSlug: 'web',
      envName: 'empty-env',
      isProduction: true,
      active: false,
      createdAt: '2025-06-01T00:00:00.000Z',
      deploymentCount: 0,
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
let auditStore: InMemoryAuditStore;

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
      if (token === 'developer-token') {
        return Promise.resolve({
          ok: true as const,
          identity: { subject: 'developer-sub', email: 'dev@acme.test', superAdmin: false },
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
  await controlPlane.addOrgMember({
    org: 'acme',
    subject: 'developer-sub',
    email: 'dev@acme.test',
    role: 'developer',
  });
  auditStore = new InMemoryAuditStore();
  registry = new ServerRegistry(store);
  const options: ServiceOptions = {
    controlPlaneStore: controlPlane,
    deployGate: gate(),
    audit: auditStore,
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

describe('GET /v1/orgs/{org}/apps/{app}/envs (envs list)', () => {
  it('groups deployments per env with the first environment designated and ranked production-first', async () => {
    expect((await deploy('web', 'staging')).status).toBe(201);
    expect((await deploy('web', 'prod')).status).toBe(201);
    expect((await deploy('web', 'dev')).status).toBe(201);

    const res = await fetch(`${base}/v1/orgs/acme/apps/web/envs`, {
      headers: authHeader('owner-token'),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(() => EnvsListResponseSchema.parse(body)).not.toThrow();
    expect(body.data.envs.map((e: { envName: string }) => e.envName)).toEqual([
      'staging',
      'dev',
      'prod',
    ]);
    expect(body.data.envs.map((e: { isProduction: boolean }) => e.isProduction)).toEqual([
      true,
      false,
      false,
    ]);
    for (const env of body.data.envs) {
      expect(env.deploymentCount).toBe(1);
      expect(env.active).toBe(true);
    }
  });

  it('excludes archived envs by default and includes them with ?archived=true', async () => {
    expect((await deploy('to-archive')).status).toBe(201);
    const archiveRes = await fetch(`${base}/v1/orgs/acme/apps/to-archive/archive`, {
      method: 'POST',
      headers: authHeader('owner-token'),
    });
    expect(archiveRes.status).toBe(200);

    const hidden = await fetch(`${base}/v1/orgs/acme/apps/to-archive/envs`, {
      headers: authHeader('owner-token'),
    });
    expect((await hidden.json()).data.envs).toEqual([]);

    const shown = await fetch(`${base}/v1/orgs/acme/apps/to-archive/envs?archived=true`, {
      headers: authHeader('owner-token'),
    });
    const shownBody = await shown.json();
    expect(shownBody.data.envs).toHaveLength(1);
    expect(shownBody.data.envs[0]).toMatchObject({ envName: 'prod', deploymentCount: 1 });
    expect(shownBody.data.envs[0].archivedAt).toEqual(expect.any(String));
  });

  it('404s for an unknown app', async () => {
    const res = await fetch(`${base}/v1/orgs/acme/apps/ghost/envs`, {
      headers: authHeader('owner-token'),
    });
    expect(res.status).toBe(404);
  });

  it('403s for a non-member', async () => {
    expect((await deploy('web')).status).toBe(201);
    const res = await fetch(`${base}/v1/orgs/acme/apps/web/envs`, {
      headers: authHeader('outsider-token'),
    });
    expect(res.status).toBe(403);
  });
});

describe('PUT /v1/orgs/{org}/apps/{app}/production-environment', () => {
  it('lets an owner atomically reassign production and emits an idempotent audit event', async () => {
    expect((await deploy('web', 'staging')).status).toBe(201);
    expect((await deploy('web', 'happy-hour')).status).toBe(201);

    const setProduction = () =>
      fetch(`${base}/v1/orgs/acme/apps/web/production-environment`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...authHeader('owner-token') },
        body: JSON.stringify({ environment: 'happy-hour' }),
      });
    const changed = await setProduction();
    expect(changed.status).toBe(200);
    const changedBody = await changed.json();
    expect(() => ProductionEnvironmentResponseSchema.parse(changedBody)).not.toThrow();
    expect(changedBody.data).toEqual({
      orgSlug: 'acme',
      appSlug: 'web',
      productionEnvironment: 'happy-hour',
      previousProductionEnvironment: 'staging',
      changed: true,
    });

    expect((await setProduction()).status).toBe(200);
    const envs = await fetch(`${base}/v1/orgs/acme/apps/web/envs`, {
      headers: authHeader('owner-token'),
    }).then((response) => response.json());
    expect(
      envs.data.envs.map((env: { envName: string; isProduction: boolean }) => [
        env.envName,
        env.isProduction,
      ]),
    ).toEqual([
      ['happy-hour', true],
      ['staging', false],
    ]);

    const events = await auditStore.list({ org: 'acme', eventType: 'environment.production_set' });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      actorSubject: 'owner-sub',
      decision: 'allow',
      status: '200',
      details: {
        previousEnvironment: 'happy-hour',
        productionEnvironment: 'happy-hour',
        changed: false,
      },
    });
  });

  it('rejects non-owners, malformed bodies, and missing environments', async () => {
    expect((await deploy('web', 'staging')).status).toBe(201);
    const url = `${base}/v1/orgs/acme/apps/web/production-environment`;
    const request = (token: string, body: unknown) =>
      fetch(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...authHeader(token) },
        body: JSON.stringify(body),
      });
    expect((await request('developer-token', { environment: 'staging' })).status).toBe(403);
    expect((await request('owner-token', { environment: 'Not Valid' })).status).toBe(400);
    expect((await request('owner-token', { environment: 'ghost' })).status).toBe(404);
  });
});

describe('GET /v1/orgs/{org}/apps/{app}/envs/{env} (env inspect)', () => {
  it('200s with the env summary shape', async () => {
    expect((await deploy('hello', 'prod')).status).toBe(201);
    const res = await fetch(`${base}/v1/orgs/acme/apps/hello/envs/prod`, {
      headers: authHeader('owner-token'),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, data: { envName: 'prod', active: true } });
    expect(() => EnvSummarySchema.parse(body.data)).not.toThrow();
  });

  it('404s for an unknown env', async () => {
    expect((await deploy('hello', 'prod')).status).toBe(201);
    const res = await fetch(`${base}/v1/orgs/acme/apps/hello/envs/ghost`, {
      headers: authHeader('owner-token'),
    });
    expect(res.status).toBe(404);
  });

  it('404s for an unknown app', async () => {
    const res = await fetch(`${base}/v1/orgs/acme/apps/ghost/envs/prod`, {
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

  it('env-response.json parses as an EnvResponse', () => {
    expect(() => EnvResponseSchema.parse(readFixture('env-response.json'))).not.toThrow();
  });

  it('envs-list-response.json parses as an EnvsListResponse', () => {
    expect(() =>
      EnvsListResponseSchema.parse(readFixture('envs-list-response.json')),
    ).not.toThrow();
  });
});
