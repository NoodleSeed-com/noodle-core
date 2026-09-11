import { describe, expect, it } from 'vitest';
import { type DeployRecord, InMemoryArtifactStore, ServerRegistry } from '../src/index.js';

const tenant = { org: 'mixed-r1', app: 'support', env: 'prod' };
const actor = { subject: 'owner', email: 'owner@example.test', superAdmin: false };
const auth = { issuer: 'https://mixed-r1.example', audience: 'api://mixed-r1' };
function manifest(withAuth = true) {
  return JSON.stringify({
    manifestVersion: '2',
    server: { name: 'support', title: 'Support', version: '1.0.0', ...(withAuth ? { auth } : {}) },
    tools: [
      {
        name: 'ping',
        description: 'Ping',
        inputSchema: { type: 'object', properties: {} },
        fulfilment: { steps: [], output: { ok: true } },
      },
    ],
  });
}
function legacy(overrides: Partial<DeployRecord> = {}): DeployRecord {
  return {
    schemaVersion: 1,
    deploymentId: 'legacy',
    orgSlug: tenant.org,
    appSlug: tenant.app,
    environment: tenant.env,
    deploymentVersion: 1,
    active: true,
    serverName: 'support',
    createdAt: '2026-09-01T00:00:00Z',
    createdBySubject: actor.subject,
    accessMode: 'mixed',
    serverAuth: auth,
    manifest: manifest(),
    secrets: { enc: 'none', values: {} },
    ...overrides,
  };
}
function registry(store: InMemoryArtifactStore) {
  return new ServerRegistry(store, undefined, undefined, {
    customerVerifierFactory: () => async () => ({
      caller: { subject: 'customer', identityKind: 'customer' },
    }),
  });
}
describe('mixed customer authentication policy', () => {
  it('requires an authenticated deployer for new mixed customer auth', async () => {
    const service = registry(new InMemoryArtifactStore());
    await expect(
      service.deploy(tenant, manifest(), { accessMode: 'mixed' }),
    ).resolves.toMatchObject({
      ok: false,
      errors: [{ code: 'identity_access_requires_identity' }],
    });
  });
  it('creates customer authority at schema 2 and preserves platform mixed without auth', async () => {
    const store = new InMemoryArtifactStore();
    const service = registry(store);
    expect((await service.deploy(tenant, manifest(), { accessMode: 'mixed', actor })).ok).toBe(
      true,
    );
    expect(await store.getActiveByTenant(tenant)).toMatchObject({ schemaVersion: 2 });
    expect(await service.getActiveByTenant(tenant)).toMatchObject({
      authentication: { kind: 'customer' },
    });
    const other = { ...tenant, app: 'public' };
    expect((await service.deploy(other, manifest(false), { accessMode: 'mixed' })).ok).toBe(true);
    expect(await store.getActiveByTenant(other)).toMatchObject({ schemaVersion: 1 });
  });
  it('requires explicit adoption for a dormant declaration and reconciles another worker on same-mode adoption', async () => {
    const store = new InMemoryArtifactStore();
    await store.append(legacy());
    const writer = registry(store);
    const reader = registry(store);
    expect(await reader.getActiveByTenant(tenant)).toMatchObject({
      authentication: { kind: 'platform' },
    });
    await expect(
      writer.deploy(tenant, manifest(), { accessMode: 'mixed', actor }),
    ).resolves.toMatchObject({
      ok: false,
      errors: [{ code: 'customer_auth_activation_required' }],
    });
    await expect(writer.updateAccess(tenant, { accessMode: 'mixed' })).resolves.toMatchObject({
      ok: true,
      changed: true,
      accessChanged: false,
      ownerChanged: false,
      policyChanged: true,
      record: { schemaVersion: 2 },
    });
    expect(await reader.getActiveByTenant(tenant)).toMatchObject({
      authentication: { kind: 'customer' },
    });
    await expect(writer.updateAccess(tenant, { accessMode: 'mixed' })).resolves.toMatchObject({
      ok: true,
      changed: false,
      policyChanged: false,
    });
  });
  it('keeps schema 2 across mode changes and replacement deployment', async () => {
    const store = new InMemoryArtifactStore();
    await store.append(legacy());
    const service = registry(store);
    await service.updateAccess(tenant, { accessMode: 'mixed' });
    await service.updateAccess(tenant, { accessMode: 'public' });
    expect(await store.getActiveByTenant(tenant)).toMatchObject({
      schemaVersion: 2,
      accessMode: 'public',
    });
    expect(
      (await service.deploy(tenant, manifest(false), { accessMode: 'public', actor })).ok,
    ).toBe(true);
    expect(await store.getActiveByTenant(tenant)).toMatchObject({ schemaVersion: 2 });
  });
  it('allows declaring new auth when the previous mixed deployment had none', async () => {
    const store = new InMemoryArtifactStore();
    await store.append(legacy({ serverAuth: undefined, manifest: manifest(false) }));
    expect(
      (await registry(store).deploy(tenant, manifest(), { accessMode: 'mixed', actor })).ok,
    ).toBe(true);
    expect(await store.getActiveByTenant(tenant)).toMatchObject({ schemaVersion: 2 });
  });
  it('preserves current operator policy on an idempotent retry', async () => {
    const store = new InMemoryArtifactStore();
    const service = registry(store);
    const options = { accessMode: 'mixed' as const, actor, idempotencyKey: 'mixed-retry' };
    expect((await service.deploy(tenant, manifest(), options)).ok).toBe(true);
    await service.updateAccess(tenant, { accessMode: 'customers' });
    await expect(service.deploy(tenant, manifest(), options)).resolves.toMatchObject({
      ok: true,
      replayed: true,
      accessMode: 'customers',
    });
    expect(await store.getActiveByTenant(tenant)).toMatchObject({
      schemaVersion: 2,
      accessMode: 'customers',
    });
  });
});

it('rejects a mixed deployment compiled before a concurrent same-schema operator policy change', async () => {
  class RaceStore extends InMemoryArtifactStore {
    beforeAppend: (() => Promise<void>) | undefined;
    override async append(
      record: DeployRecord,
      precondition?: Parameters<InMemoryArtifactStore['append']>[1],
    ) {
      const action = this.beforeAppend;
      this.beforeAppend = undefined;
      await action?.();
      return super.append(record, precondition);
    }
  }
  const store = new RaceStore();
  const service = registry(store);
  await service.deploy(tenant, manifest(), { accessMode: 'mixed', actor });
  store.beforeAppend = async () => {
    await service.updateAccess(tenant, { accessMode: 'customers' });
  };
  await expect(
    service.deploy(tenant, manifest(), { accessMode: 'mixed', actor }),
  ).resolves.toMatchObject({ ok: false, errors: [{ code: 'deployment_policy_changed' }] });
  expect(await store.getActiveByTenant(tenant)).toMatchObject({
    schemaVersion: 2,
    accessMode: 'customers',
  });
});
it('activates a schema-2 automated deployment using an explicit target policy precondition', async () => {
  const store = new InMemoryArtifactStore();
  const service = registry(store);
  await expect(
    service.deploy(tenant, manifest(), { accessMode: 'mixed', actor, automationId: 'run-1' }),
  ).resolves.toMatchObject({ ok: true });
  expect(await store.getActiveByTenant(tenant)).toMatchObject({
    schemaVersion: 2,
    accessMode: 'mixed',
  });
});

it('does not adopt a mismatched dormant customer projection', async () => {
  const store = new InMemoryArtifactStore();
  await store.append(legacy({ serverAuth: { ...auth, audience: 'wrong' } }));
  await expect(
    registry(store).updateAccess(tenant, { accessMode: 'mixed' }),
  ).resolves.toMatchObject({ ok: false, code: 'server_auth_required' });
  expect(await store.getActiveByTenant(tenant)).toMatchObject({ schemaVersion: 1 });
});
it('reports unhealthy customer authority when schema-2 compiled auth has no durable projection', async () => {
  const store = new InMemoryArtifactStore();
  await store.append(legacy({ schemaVersion: 2, serverAuth: undefined }));
  const service = registry(store);
  await expect(service.recover()).resolves.toMatchObject({ recovered: 0 });
  await expect(service.getStatus(tenant, 'https://service.example')).resolves.toMatchObject({
    deployment: { authentication: 'customer' },
    health: { state: 'unhealthy' },
  });
});

it('rejects activation when an operator changed policy after an automated candidate was appended', async () => {
  class ActivationRaceStore extends InMemoryArtifactStore {
    beforeActivation: (() => Promise<void>) | undefined;
    override async activateDeployment(
      ...args: Parameters<InMemoryArtifactStore['activateDeployment']>
    ) {
      const action = this.beforeActivation;
      this.beforeActivation = undefined;
      await action?.();
      return super.activateDeployment(...args);
    }
  }
  const store = new ActivationRaceStore();
  const service = registry(store);
  await service.deploy(tenant, manifest(), { accessMode: 'mixed', actor });
  store.beforeActivation = async () => {
    await service.updateAccess(tenant, { accessMode: 'customers' });
  };
  await expect(
    service.deploy(tenant, manifest(), { accessMode: 'mixed', actor, automationId: 'race-run' }),
  ).resolves.toMatchObject({ ok: false, errors: [{ code: 'deployment_policy_changed' }] });
  expect(await store.getActiveByTenant(tenant)).toMatchObject({
    schemaVersion: 2,
    accessMode: 'customers',
  });
});
