import { describe, expect, it } from 'vitest';
import { ServerRegistry } from '../src/registry.js';
import { loadPersistedRegistryTarget } from '../src/registry-compile.js';
import { deleteRegistryDeployments } from '../src/registry-deletion.js';
import type { RegistryStateView } from '../src/registry-state.js';
import { InMemoryArtifactStore } from '../src/store.js';
import { TENANT } from './deployment-deletion-suite.js';

const manifest = JSON.stringify({
  manifestVersion: '1',
  server: { name: 'support', version: '1', title: 'Support' },
  tools: [
    {
      name: 'status',
      description: 'Return service status.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      fulfilment: { steps: [], output: { ok: true } },
    },
  ],
});
async function deploy(registry: ServerRegistry) {
  const result = await registry.deploy(TENANT, manifest, {
    accessMode: 'public',
    serverVersion: '1',
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('deployment fixture failed');
  return result.deploymentId;
}
describe('registry deployment deletion', () => {
  it('does not resurrect a no-store version from a concurrent pinned-version read', async () => {
    const registry = new ServerRegistry();
    const id = await deploy(registry);
    const [read, deleted] = await Promise.all([
      registry.getActiveByTenantVersion(TENANT, '1'),
      registry.deleteDeployments(TENANT, {
        kind: 'version',
        serverVersion: '1',
        expectedDeploymentIds: [id],
      }),
    ]);
    expect(deleted.ok).toBe(true);
    expect(read).toBeUndefined();
    expect(await registry.listDeployments({ org: TENANT.org })).toEqual([]);
    expect(await registry.get(id)).toBeUndefined();
    expect(await registry.getServing(id)).toBeUndefined();
    expect(await registry.getActiveByTenantVersion(TENANT, '1')).toBeUndefined();
  });
  for (const persisted of [false, true]) {
    it(`evicts history and pinned/default routes (${persisted ? 'store' : 'no-store'})`, async () => {
      const registry = new ServerRegistry(persisted ? new InMemoryArtifactStore() : undefined);
      const history = await deploy(registry);
      const active = await deploy(registry);
      expect(await registry.get(history)).toBeDefined();
      expect(
        await registry.deleteDeployments(TENANT, { kind: 'deployment', deploymentId: history }),
      ).toMatchObject({ ok: true });
      expect(await registry.get(history)).toBeUndefined();
      expect(await registry.getActiveByTenantVersion(TENANT, '1')).toBeDefined();
      expect(
        await registry.deleteDeployments(TENANT, {
          kind: 'version',
          serverVersion: '1',
          expectedDeploymentIds: [active],
        }),
      ).toMatchObject({ ok: true });
      expect(await registry.get(active)).toBeUndefined();
      expect(await registry.getServing(active)).toBeUndefined();
      expect(await registry.getActiveByTenant(TENANT)).toBeUndefined();
      expect(await registry.getActiveByTenantVersion(TENANT, '1')).toBeUndefined();
    });
  }
  it('invalidates a warmed second registry and restart reads using store authority', async () => {
    const store = new InMemoryArtifactStore();
    const writer = new ServerRegistry(store);
    const reader = new ServerRegistry(store);
    const id = await deploy(writer);
    expect(await reader.get(id)).toBeDefined();
    await writer.deleteDeployments(TENANT, {
      kind: 'version',
      serverVersion: '1',
      expectedDeploymentIds: [id],
    });
    expect(await reader.get(id)).toBeUndefined();
    expect(await reader.getServing(id)).toBeUndefined();
    expect(await reader.getActiveByTenantVersion(TENANT, '1')).toBeUndefined();
    expect(await new ServerRegistry(store).get(id)).toBeUndefined();
  });
  it('cannot publish a compilation that finishes after persisted deletion', async () => {
    const store = new InMemoryArtifactStore();
    const registry = new ServerRegistry(store);
    const id = await deploy(registry);
    const record = await store.get(id);
    const target = await registry.get(id);
    if (!record || !target) throw new Error('fixture missing');
    let resume: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let entered: (() => void) | undefined;
    const compiling = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const state: RegistryStateView = {
      store,
      records: new Map([[id, record]]),
      servers: new Map(),
      activeTenants: new Map([[`${TENANT.org}/${TENANT.app}/${TENANT.env}`, id]]),
      productionEnvironments: new Map(),
    };
    const read = loadPersistedRegistryTarget(record, {
      state,
      compile: async () => {
        entered?.();
        await blocked;
        return { ok: true, served: target.served, bindDeployment: () => target.served };
      },
      capabilities: [],
      customerVerifierFactory: undefined,
      hasCustomerAuthConflict: async () => false,
    });
    await compiling;
    await registry.deleteDeployments(TENANT, {
      kind: 'version',
      serverVersion: '1',
      expectedDeploymentIds: [id],
    });
    resume?.();
    expect(await read).toBeUndefined();
    expect(state.servers.size).toBe(0);
    expect(state.records.size).toBe(0);
    expect(state.activeTenants.size).toBe(0);
  });
});
it('cannot restore a deleted no-store record from an in-flight lock update', async () => {
  const registry = new ServerRegistry();
  const id = await deploy(registry);
  const [locked, deleted] = await Promise.all([
    registry.setDeploymentLock(TENANT, '1', id, {
      lockedAt: '2026-09-14T00:00:00.000Z',
      lockedBySubject: 'owner',
    }),
    registry.deleteDeployments(TENANT, {
      kind: 'version',
      serverVersion: '1',
      expectedDeploymentIds: [id],
    }),
  ]);
  expect(deleted.ok).toBe(true);
  expect(locked).toEqual({ ok: false, reason: 'no_active_deployment' });
  expect(await registry.get(id)).toBeUndefined();
  expect(await registry.listDeployments({ org: TENANT.org })).toEqual([]);
});

it('does not republish no-store compilation after an existence snapshot yields', async () => {
  const fixtureStore = new InMemoryArtifactStore();
  const registry = new ServerRegistry(fixtureStore);
  const id = await deploy(registry);
  const record = await fixtureStore.get(id);
  const target = await registry.get(id);
  if (!record || !target) throw new Error('fixture missing');
  const state: RegistryStateView = {
    store: undefined,
    records: new Map([[id, record]]),
    servers: new Map(),
    activeTenants: new Map(),
    productionEnvironments: new Map(),
  };
  let deleted: Promise<unknown> | undefined;
  await loadPersistedRegistryTarget(record, {
    state,
    compile: async () => ({ ok: true, served: target.served, bindDeployment: () => target.served }),
    capabilities: [],
    customerVerifierFactory: undefined,
    hasCustomerAuthConflict: async () => {
      // The second microtask falls between an awaited presence snapshot and cache publication.
      queueMicrotask(() =>
        queueMicrotask(() => {
          deleted = deleteRegistryDeployments(state, TENANT, {
            kind: 'version',
            serverVersion: '1',
            expectedDeploymentIds: [id],
          });
        }),
      );
      return false;
    },
  });
  expect(await deleted).toMatchObject({ ok: true });
  expect(state.records.size).toBe(0);
  expect(state.servers.size).toBe(0);
});
