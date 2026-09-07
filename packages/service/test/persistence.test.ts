import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStaticSigningKeyProvider } from '@noodle-borg/auth';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type DeployRecord,
  InMemoryArtifactStore,
  InMemoryControlPlaneStore,
  JsonFileArtifactStore,
  ServerRegistry,
  serveService,
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

const LEGACY_CONNECTOR_MANIFEST = `
manifestVersion: "1"
server:
  name: legacy_connector
  version: 1.0.0
  title: Legacy Connector
connectors:
  legacy:
    id: legacy
    version: 1.0.0
tools:
  - name: lookup
    description: Look up one value.
    inputSchema:
      type: object
      properties:
        id: { type: string }
      required: [id]
      additionalProperties: false
    fulfilment:
      use: legacy.lookup
      args:
        id: \${input.id}
`;

const LEGACY_CONNECTORS = JSON.stringify({
  connectors: [
    {
      id: 'legacy',
      version: '1.0.0',
      http: {
        baseUrl: 'https://example.com',
        allowedOrigins: ['https://example.com'],
      },
      operations: {
        lookup: {
          type: 'read',
          method: 'GET',
          path: '/items/{id}',
          input: { id: { type: 'string', required: true } },
          output: { result: { type: 'unknown', required: true } },
          response: { result: '${response}' },
        },
      },
    },
  ],
});

// A deterministic 32-byte base64 master key for secret-at-rest (Slice 26) in tests.
const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');

const JSON_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};
const OWNER_TOKEN = 'OWNER';
const auth = (): Record<string, string> => ({ authorization: `Bearer ${OWNER_TOKEN}` });

async function serviceOptions(oauthClientCredentialsReady = false) {
  const controlPlane = new InMemoryControlPlaneStore();
  await controlPlane.createOrg({ slug: 'acme' });
  return {
    controlPlaneStore: controlPlane,
    deployGate: {
      authorize: () =>
        Promise.resolve({
          ok: true as const,
          identity: { subject: 'owner-sub', email: 'owner@noodleseed.com', superAdmin: true },
        }),
    },
    verifyOwnerToken: (token: string) =>
      Promise.resolve(token === OWNER_TOKEN ? { caller: { subject: 'owner-sub' } } : null),
    authServerIssuer: 'https://as.noodle.test',
    ...(oauthClientCredentialsReady
      ? {
          oauth: {
            issuer: 'https://as.noodle.test',
            signer: await createStaticSigningKeyProvider(),
            google: {
              authorizationUrl: () => new URL('https://google.test/authorize'),
              exchange: () =>
                Promise.resolve({ subject: 'owner-sub', email: 'owner@noodleseed.com' }),
            },
          },
        }
      : {}),
  };
}

function deploy(baseUrl: string, manifest: string, app = 'hello'): Promise<Response> {
  return fetch(`${baseUrl}/v1/orgs/acme/apps/${app}/envs/prod/deploy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ manifest }),
  });
}
function initialize(url: string): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { ...JSON_HEADERS, ...auth() },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25' },
    }),
  });
}
function callGreet(url: string, name: string): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { ...JSON_HEADERS, 'mcp-protocol-version': '2025-11-25', ...auth() },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'greet', arguments: { name } },
    }),
  });
}

function modernPost(
  url: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      ...JSON_HEADERS,
      ...auth(),
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': method,
      ...(method === 'tools/call' && typeof params.name === 'string'
        ? { 'mcp-name': params.name }
        : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 9,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/clientInfo': { name: 'restart-test', version: '1' },
        },
      },
    }),
  });
}

let dirs: string[] = [];
async function tmpDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'noodle-persist-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs = [];
});

describe('persistence + restart recovery (Slice 25)', () => {
  it('recovers a deployed server after a full process restart on the same data dir', async () => {
    const dataDir = await tmpDataDir();

    const first = await serveService({
      port: 0,
      dataDir,
      secretMasterKey: MASTER_KEY,
      mcpProtocolMode: 'legacy-only',
      ...(await serviceOptions()),
    });
    let dep: { ok: boolean; deploymentId: string; url: string };
    let frozenLegacyCall: string;
    try {
      dep = await (await deploy(first.url, HELLO)).json();
      expect(dep.ok).toBe(true);
      expect((await deploy(first.url, HELLO, 'sibling')).status).toBe(201);
      const callUrl = `${first.url}/o/acme/hello/mcp`;
      expect((await initialize(callUrl)).status).toBe(200);
      frozenLegacyCall = await (await callGreet(callUrl, 'world')).text();
    } finally {
      await first.close();
    }

    // Restart the unchanged deployment on the dual-capable image — without re-deploying.
    const second = await serveService({
      port: 0,
      dataDir,
      secretMasterKey: MASTER_KEY,
      ...(await serviceOptions(true)),
    });
    try {
      const callUrl = `${second.url}/o/acme/hello/mcp`;
      expect((await initialize(callUrl)).status).toBe(200);
      const legacyAfter = await callGreet(callUrl, 'world');
      expect(await legacyAfter.clone().text()).toBe(frozenLegacyCall);
      const result = await legacyAfter.json();
      expect(result.result.structuredContent).toEqual({ message: 'Hello, world!' });

      const discovery = await (await modernPost(callUrl, 'server/discover')).json();
      expect(discovery.result.supportedVersions).toEqual([
        '2026-07-28',
        '2025-11-25',
        '2025-06-18',
        '2025-03-26',
        '2024-11-05',
        '2024-10-07',
      ]);
      expect(discovery.result.capabilities.extensions).toMatchObject({
        'io.modelcontextprotocol/oauth-client-credentials': {},
      });
      const siblingDiscovery = await (
        await modernPost(`${second.url}/o/acme/sibling/mcp`, 'server/discover')
      ).json();
      expect(siblingDiscovery.result.capabilities.extensions).toMatchObject({
        'io.modelcontextprotocol/oauth-client-credentials': {},
      });
      const modernCall = await (
        await modernPost(callUrl, 'tools/call', {
          name: 'greet',
          arguments: { name: 'modern world' },
        })
      ).json();
      expect(modernCall.result).toMatchObject({
        resultType: 'complete',
        structuredContent: { message: 'Hello, modern world!' },
      });
    } finally {
      await second.close();
    }
  });

  it('keeps in-memory behaviour with no data dir — deploys are lost on restart', async () => {
    const first = await serveService({ port: 0, ...(await serviceOptions()) });
    await (await deploy(first.url, HELLO)).json();
    await first.close();

    const second = await serveService({ port: 0, ...(await serviceOptions()) });
    try {
      // The id from the previous in-memory boot is unknown now → 404 (nothing persisted).
      expect((await initialize(`${second.url}/o/acme/hello/mcp`)).status).toBe(404);
    } finally {
      await second.close();
    }
  });

  it('skips a record that no longer compiles and recovers the rest (fail-soft)', async () => {
    const store = new InMemoryArtifactStore();
    const good: DeployRecord = {
      schemaVersion: 1,
      deploymentId: 'good-00000000',
      orgSlug: 'acme',
      appSlug: 'good',
      environment: 'prod',
      deploymentVersion: 1,
      active: true,
      serverName: 'hello',
      createdAt: '2026-06-03T00:00:00.000Z',
      createdBySubject: 'owner-sub',
      accessMode: 'owner-only',
      manifest: HELLO,
      secrets: { enc: 'none', values: {} },
    };
    const bad: DeployRecord = {
      ...good,
      deploymentId: 'bad-00000000',
      appSlug: 'bad',
      manifest: 'manifestVersion: "1"\nnot: valid',
    };
    await store.append(good);
    await store.append(bad);

    const registry = new ServerRegistry(store);
    const result = await registry.recover();
    expect(result.recovered).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.deploymentId).toBe('bad-00000000');
    expect(await registry.get('good-00000000')).toMatchObject({ ownerSubject: 'owner-sub' });
    // The failed record is not cached; a lazy get re-reads + recompiles it and throws (→ 500), rather than
    // masquerading as "not found" (ADR 0036). "no such record" is the only undefined (→ 404) case.
    await expect(registry.get('bad-00000000')).rejects.toThrow();
  });

  it('upgrades retired connector field maps only when recompiling persisted deployments', async () => {
    const freshRegistry = new ServerRegistry();
    const fresh = await freshRegistry.deploy(
      { org: 'acme', app: 'legacy', env: 'prod' },
      LEGACY_CONNECTOR_MANIFEST,
      { connectors: LEGACY_CONNECTORS },
    );
    expect(fresh.ok).toBe(false);
    if (fresh.ok) return;
    expect(fresh.errors).toContainEqual(
      expect.objectContaining({
        code: 'invalid_connector',
        message: expect.stringContaining('retired field-map form'),
      }),
    );

    const store = new InMemoryArtifactStore();
    await store.append({
      schemaVersion: 1,
      deploymentId: 'legacy-00000000',
      orgSlug: 'acme',
      appSlug: 'legacy',
      environment: 'prod',
      serverVersion: '1',
      deploymentVersion: 1,
      active: true,
      serverName: 'legacy_connector',
      createdAt: '2026-07-09T00:00:00.000Z',
      createdBySubject: 'owner-sub',
      accessMode: 'owner-only',
      manifest: LEGACY_CONNECTOR_MANIFEST,
      connectors: LEGACY_CONNECTORS,
      secrets: { enc: 'none', values: {} },
    });

    const recoveredRegistry = new ServerRegistry(store);
    const recovered = await recoveredRegistry.recover();
    expect(recovered).toEqual({ recovered: 1, failed: [] });
    const status = await recoveredRegistry.getStatus(
      { org: 'acme', app: 'legacy', env: 'prod' },
      'https://cloud.noodle.test',
      '1',
    );
    expect(status?.health.state).toBe('ready');

    const lazyRegistry = new ServerRegistry(store);
    expect(
      await lazyRegistry.getActiveByTenantVersion({ org: 'acme', app: 'legacy', env: 'prod' }, '1'),
    ).toBeDefined();
  });
});

describe('ServerRegistry lazy recompile-on-cache-miss (ADR 0036)', () => {
  // A valid, persisted record with a cleartext (`enc:'none'`) envelope — no secretBox needed.
  const record: DeployRecord = {
    schemaVersion: 1,
    deploymentId: 'hello-deadbeef',
    orgSlug: 'acme',
    appSlug: 'hello',
    environment: 'prod',
    deploymentVersion: 1,
    active: true,
    serverName: 'hello',
    createdAt: '2026-06-04T00:00:00.000Z',
    createdBySubject: 'owner-sub',
    ownerSubject: 'oauth-explicit-owner',
    accessMode: 'owner-only',
    manifest: HELLO,
    secrets: { enc: 'none', values: {} },
  };

  it('lazily recompiles from the store on a cache miss, then serves from cache (no second read)', async () => {
    const store = new InMemoryArtifactStore();
    await store.append(record);
    const getSpy = vi.spyOn(store, 'get');
    // Fresh registry — never deployed to, never recovered: a served target can only come from a lazy miss.
    const registry = new ServerRegistry(store);
    expect(registry.size).toBe(0);

    const first = await registry.get('hello-deadbeef');
    expect(first).toBeDefined();
    expect(first?.accessMode).toBe('owner-only');
    expect(first?.ownerSubject).toBe('oauth-explicit-owner');
    expect(registry.size).toBe(1); // cached after the lazy compile
    expect(getSpy).toHaveBeenCalledTimes(1);

    const second = await registry.get('hello-deadbeef');
    expect(second).toBe(first); // same cached reference …
    expect(getSpy).toHaveBeenCalledTimes(1); // … and no second store read
  });

  it('single-flights concurrent first-hits for one id (one store read, one shared compile)', async () => {
    const store = new InMemoryArtifactStore();
    await store.append(record);
    // A slow point-read forces genuine overlap: without single-flight all three would each read + compile.
    const getSpy = vi.spyOn(store, 'get').mockImplementation(async (id) => {
      await new Promise((r) => setTimeout(r, 10));
      return id === 'hello-deadbeef' ? record : undefined;
    });
    const registry = new ServerRegistry(store);

    const [a, b, c] = await Promise.all([
      registry.get('hello-deadbeef'),
      registry.get('hello-deadbeef'),
      registry.get('hello-deadbeef'),
    ]);
    expect(getSpy).toHaveBeenCalledTimes(1); // single-flight: one shared compile, not three
    expect(a).toBeDefined();
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('does not cache a failed lazy compile — a later get retries (inflight cleared in finally)', async () => {
    const store = new InMemoryArtifactStore();
    const broken: DeployRecord = {
      ...record,
      deploymentId: 'broken-deadbeef',
      appSlug: 'broken',
      manifest: 'manifestVersion: "1"\nnot: valid',
    };
    await store.append(broken);
    const getSpy = vi.spyOn(store, 'get');
    const registry = new ServerRegistry(store);

    await expect(registry.get('broken-deadbeef')).rejects.toThrow();
    expect(registry.size).toBe(0); // a failure is never cached
    expect(getSpy).toHaveBeenCalledTimes(1);

    // A subsequent request re-reads + re-attempts — the rejected promise was not retained.
    await expect(registry.get('broken-deadbeef')).rejects.toThrow();
    expect(getSpy).toHaveBeenCalledTimes(2);
  });

  it('returns undefined for a cache miss with no durable store (→ 404)', async () => {
    expect(await new ServerRegistry().get('nope-deadbeef')).toBeUndefined();
  });
});

// Shared fixture records for both the `apps` and `envs` resource parity suites below: two envs of
// `web` (one active in prod, one inactive in staging) plus one unrelated app `api`.
const APP_ENV_RECORDS: readonly DeployRecord[] = [
  {
    schemaVersion: 1,
    deploymentId: 'web-prod-0000001',
    orgSlug: 'acme',
    appSlug: 'web',
    environment: 'prod',
    deploymentVersion: 1,
    active: true,
    serverName: 'web',
    createdAt: '2026-06-01T00:00:00.000Z',
    createdByEmail: 'dev@acme.test',
    deploymentSource: 'console-example',
    accessMode: 'org-members',
    manifest: 'manifestVersion: "1"\n',
    secrets: { enc: 'none', values: {} },
  },
  {
    schemaVersion: 1,
    deploymentId: 'web-staging-000001',
    orgSlug: 'acme',
    appSlug: 'web',
    environment: 'staging',
    deploymentVersion: 2,
    active: false,
    serverName: 'web',
    createdAt: '2026-06-05T00:00:00.000Z',
    createdByEmail: 'dev@acme.test',
    accessMode: 'org-members',
    manifest: 'manifestVersion: "1"\n',
    secrets: { enc: 'none', values: {} },
  },
  {
    schemaVersion: 1,
    deploymentId: 'api-prod-00000001',
    orgSlug: 'acme',
    appSlug: 'api',
    environment: 'prod',
    deploymentVersion: 1,
    active: true,
    serverName: 'api',
    createdAt: '2026-05-01T00:00:00.000Z',
    accessMode: 'owner-only',
    manifest: 'manifestVersion: "1"\n',
    secrets: { enc: 'none', values: {} },
  },
];

async function seedAppEnvRecords(
  store: InMemoryArtifactStore | JsonFileArtifactStore,
): Promise<void> {
  for (const record of APP_ENV_RECORDS) await store.append(record);
}

describe('ArtifactStore.listApps/getApp parity (in-memory vs json-file)', () => {
  it('produce identical AppSummary output for the same records', async () => {
    const inMemory = new InMemoryArtifactStore();
    await seedAppEnvRecords(inMemory);
    const dataDir = await tmpDataDir();
    const jsonFile = new JsonFileArtifactStore(dataDir);
    await seedAppEnvRecords(jsonFile);

    const [inMemoryList, jsonFileList] = await Promise.all([
      inMemory.listApps('acme'),
      jsonFile.listApps('acme'),
    ]);
    expect(jsonFileList).toEqual(inMemoryList);
    expect(inMemoryList.apps.map((app) => app.appSlug)).toEqual(['web', 'api']);
    expect(inMemoryList.apps[0]).toMatchObject({
      appSlug: 'web',
      environments: ['prod', 'staging'],
    });

    const [inMemoryApp, jsonFileApp] = await Promise.all([
      inMemory.getApp('acme', 'web'),
      jsonFile.getApp('acme', 'web'),
    ]);
    expect(jsonFileApp).toEqual(inMemoryApp);

    expect(await inMemory.getApp('acme', 'ghost')).toBeUndefined();
    expect(await jsonFile.getApp('acme', 'ghost')).toBeUndefined();
  });
});

describe('ArtifactStore.listEnvironments/getEnvironment parity (in-memory vs json-file)', () => {
  it('produce identical EnvSummary[] output for the same records', async () => {
    const inMemory = new InMemoryArtifactStore();
    await seedAppEnvRecords(inMemory);
    const dataDir = await tmpDataDir();
    const jsonFile = new JsonFileArtifactStore(dataDir);
    await seedAppEnvRecords(jsonFile);

    const [inMemoryEnvs, jsonFileEnvs] = await Promise.all([
      inMemory.listEnvironments('acme', 'web'),
      jsonFile.listEnvironments('acme', 'web'),
    ]);
    expect(jsonFileEnvs).toEqual(inMemoryEnvs);
    expect(inMemoryEnvs.map((env) => env.envName)).toEqual(['prod', 'staging']);
    expect(inMemoryEnvs[0]).toMatchObject({
      envName: 'prod',
      isProduction: true,
      active: true,
      deploymentCount: 1,
    });

    const [inMemoryEnv, jsonFileEnv] = await Promise.all([
      inMemory.getEnvironment('acme', 'web', 'prod'),
      jsonFile.getEnvironment('acme', 'web', 'prod'),
    ]);
    expect(jsonFileEnv).toEqual(inMemoryEnv);

    expect(await inMemory.getEnvironment('acme', 'web', 'ghost')).toBeUndefined();
    expect(await jsonFile.getEnvironment('acme', 'web', 'ghost')).toBeUndefined();
  });

  it('atomically reassign production and persists it across a json-file restart', async () => {
    const inMemory = new InMemoryArtifactStore();
    await seedAppEnvRecords(inMemory);
    const dataDir = await tmpDataDir();
    const jsonFile = new JsonFileArtifactStore(dataDir);
    await seedAppEnvRecords(jsonFile);

    const [memoryChanged, fileChanged] = await Promise.all([
      inMemory.setProductionEnvironment('acme', 'web', 'staging'),
      jsonFile.setProductionEnvironment('acme', 'web', 'staging'),
    ]);
    expect(fileChanged).toEqual(memoryChanged);
    expect(memoryChanged).toEqual({
      orgSlug: 'acme',
      appSlug: 'web',
      productionEnvironment: 'staging',
      previousProductionEnvironment: 'prod',
      changed: true,
    });

    const restarted = new JsonFileArtifactStore(dataDir);
    const restartedEnvs = await restarted.listEnvironments('acme', 'web');
    expect(restartedEnvs.map((env) => [env.envName, env.isProduction])).toEqual([
      ['staging', true],
      ['prod', false],
    ]);
    expect(await restarted.setProductionEnvironment('acme', 'web', 'staging')).toMatchObject({
      changed: false,
      previousProductionEnvironment: 'staging',
    });
    expect(await restarted.setProductionEnvironment('acme', 'web', 'ghost')).toBeUndefined();
  });

  it('keeps the first custom environment as production when a second environment is deployed', async () => {
    const inMemory = new InMemoryArtifactStore();
    const dataDir = await tmpDataDir();
    const jsonFile = new JsonFileArtifactStore(dataDir);
    const firstBase = APP_ENV_RECORDS[0];
    const secondBase = APP_ENV_RECORDS[1];
    if (!firstBase || !secondBase) throw new Error('expected two environment fixtures');
    const first = { ...firstBase, environment: 'happy-hour' };
    const second = {
      ...secondBase,
      deploymentId: 'web-preview-0000001',
      environment: 'preview',
    };
    for (const store of [inMemory, jsonFile]) {
      await store.append(first);
      await store.append(second);
      expect((await store.listEnvironments('acme', 'web'))[0]).toMatchObject({
        envName: 'happy-hour',
        isProduction: true,
      });
    }
  });

  it('keeps ambiguous legacy json-file apps unresolved when another deployment is appended', async () => {
    const dataDir = await tmpDataDir();
    const initial = new JsonFileArtifactStore(dataDir);
    const firstBase = APP_ENV_RECORDS[0];
    const secondBase = APP_ENV_RECORDS[1];
    if (!firstBase || !secondBase) throw new Error('expected two environment fixtures');
    await initial.append({ ...firstBase, environment: 'happy-hour' });
    await initial.append({
      ...secondBase,
      deploymentId: 'web-preview-0000001',
      environment: 'preview',
    });

    // Simulate a pre-designation data directory: deployments exist, metadata does not.
    await rm(join(dataDir, 'environment-metadata', 'acme', 'web.json'));
    const restarted = new JsonFileArtifactStore(dataDir);
    expect(
      (await restarted.listEnvironments('acme', 'web')).every((env) => !env.isProduction),
    ).toBe(true);

    await restarted.append({
      ...secondBase,
      deploymentId: 'web-prod-00000002',
      environment: 'prod',
      deploymentVersion: 3,
    });
    expect(
      JSON.parse(await readFile(join(dataDir, 'environment-metadata', 'acme', 'web.json'), 'utf8')),
    ).toMatchObject({ productionEnvironment: null });
    expect(
      (await restarted.listEnvironments('acme', 'web')).every((env) => !env.isProduction),
    ).toBe(true);
  });
});

describe('ArtifactStore.getDeployment parity (in-memory vs json-file)', () => {
  it('produce identical DeploymentSummary output for the same record, org-scoped', async () => {
    const inMemory = new InMemoryArtifactStore();
    await seedAppEnvRecords(inMemory);
    const dataDir = await tmpDataDir();
    const jsonFile = new JsonFileArtifactStore(dataDir);
    await seedAppEnvRecords(jsonFile);

    const [inMemoryDeployment, jsonFileDeployment] = await Promise.all([
      inMemory.getDeployment('acme', 'web-prod-0000001'),
      jsonFile.getDeployment('acme', 'web-prod-0000001'),
    ]);
    expect(jsonFileDeployment).toEqual(inMemoryDeployment);
    expect(inMemoryDeployment).toMatchObject({
      deploymentId: 'web-prod-0000001',
      orgSlug: 'acme',
      appSlug: 'web',
      environment: 'prod',
      deploymentSource: 'console-example',
    });

    // Unknown id: undefined in both backends.
    expect(await inMemory.getDeployment('acme', 'ghost-deadbeef')).toBeUndefined();
    expect(await jsonFile.getDeployment('acme', 'ghost-deadbeef')).toBeUndefined();

    // Cross-org lookup must not leak: `web-prod-0000001` belongs to `acme`, not `other`.
    expect(await inMemory.getDeployment('other', 'web-prod-0000001')).toBeUndefined();
    expect(await jsonFile.getDeployment('other', 'web-prod-0000001')).toBeUndefined();
  });
});
