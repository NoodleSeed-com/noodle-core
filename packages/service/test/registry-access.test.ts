import { describe, expect, it } from 'vitest';
import {
  type DeployRecord,
  InMemoryArtifactStore,
  ServerRegistry,
  type TenantRef,
} from '../src/index.js';
import { updateActiveAccess as updateRegistryAccess } from '../src/registry-access.js';
import type { RegistryStateView } from '../src/registry-state.js';

const TENANT = { org: 'acme', app: 'support', env: 'prod' } as const;
const STAGING_TENANT = { org: 'acme', app: 'support', env: 'staging' } as const;
const ACTOR = { subject: 'owner-subject', email: 'owner@acme.test', superAdmin: false } as const;

describe('registry access transitions', () => {
  it('returns an unchanged success without persisting the selected current mode', async () => {
    const store = new CountingAccessStore();
    const registry = new ServerRegistry(store);
    await deploy(registry, TENANT, 'owner-only');

    await expect(
      registry.updateAccess(TENANT, { accessMode: 'owner-only' }),
    ).resolves.toMatchObject({
      ok: true,
      changed: false,
      accessChanged: false,
      ownerChanged: false,
      previousAccessMode: 'owner-only',
      previousOwnerSubject: ACTOR.subject,
      record: { accessMode: 'owner-only' },
    });
    expect(store.accessUpdates).toBe(1);
  });

  it('treats an active record without an access mode as an owner-only no-op', async () => {
    const store = new CountingAccessStore();
    await seedLegacyActiveRecord(store);
    const registry = new ServerRegistry(store);

    const result = await registry.updateAccess(TENANT, { accessMode: 'owner-only' });

    expect(result).toMatchObject({
      ok: true,
      changed: false,
      accessChanged: false,
      ownerChanged: false,
      previousAccessMode: 'owner-only',
      previousOwnerSubject: ACTOR.subject,
    });
    if (result.ok) expect(result.record).not.toHaveProperty('accessMode');
    expect(store.accessUpdates).toBe(1);
  });

  it('updates only the active record for the requested tenant tuple', async () => {
    const store = new InMemoryArtifactStore();
    const registry = new ServerRegistry(store);
    await deploy(registry, TENANT, 'org-members', { orgMembershipSources: ['explicit'] });
    await deploy(registry, STAGING_TENANT, 'owner-only');

    await expect(
      registry.updateAccess(TENANT, { accessMode: 'authenticated' }),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      accessChanged: true,
      ownerChanged: false,
      previousAccessMode: 'org-members',
      previousOwnerSubject: ACTOR.subject,
      record: { accessMode: 'authenticated' },
    });
    await expect(store.getActiveByTenant(TENANT)).resolves.toMatchObject({
      accessMode: 'authenticated',
    });
    await expect(store.getActiveByTenant(STAGING_TENANT)).resolves.toMatchObject({
      accessMode: 'owner-only',
    });
  });

  it('rejects customers access when the compiled server has no customer authentication', async () => {
    const registry = new ServerRegistry(new InMemoryArtifactStore());
    await deploy(registry, TENANT, 'owner-only');

    await expect(registry.updateAccess(TENANT, { accessMode: 'customers' })).resolves.toEqual({
      ok: false,
      status: 409,
      code: 'server_auth_required',
      message: 'Customer access requires server authentication.',
    });
  });

  it('rejects public access when the compiled manifest uses the user root', async () => {
    const registry = new ServerRegistry(new InMemoryArtifactStore());
    await deploy(registry, TENANT, 'owner-only', {}, userManifest());

    await expect(registry.updateAccess(TENANT, { accessMode: 'public' })).resolves.toEqual({
      ok: false,
      status: 409,
      code: 'public_user_context_conflict',
      message: 'Public access cannot reference the user context.',
    });
  });

  it('rejects owner-only access without a recorded deployer identity', async () => {
    const registry = new ServerRegistry(new InMemoryArtifactStore());
    await deploy(registry, TENANT, 'public', { actor: undefined });

    await expect(registry.updateAccess(TENANT, { accessMode: 'owner-only' })).resolves.toEqual({
      ok: false,
      status: 409,
      code: 'owner_identity_required',
      message: 'Owner-only access requires a recorded deployer identity.',
    });
  });

  it('preserves org membership sources while changing to org-members access', async () => {
    const registry = new ServerRegistry(new InMemoryArtifactStore());
    await deploy(registry, TENANT, 'org-members', { orgMembershipSources: ['group'] });

    await registry.updateAccess(TENANT, { accessMode: 'authenticated' });
    const result = await registry.updateAccess(TENANT, { accessMode: 'org-members' });

    expect(result).toMatchObject({
      ok: true,
      changed: true,
      record: { accessMode: 'org-members', orgMembershipSources: ['group'] },
    });
  });

  it('returns a conflict and keeps the current mode when persistence fails', async () => {
    const store = new ConflictAccessStore();
    const registry = new ServerRegistry(store);
    await deploy(registry, TENANT, 'owner-only');

    await expect(registry.updateAccess(TENANT, { accessMode: 'authenticated' })).resolves.toEqual({
      ok: false,
      status: 409,
      code: 'access_update_conflict',
      message: 'The active deployment changed before access could be updated.',
    });
    await expect(store.getActiveByTenant(TENANT)).resolves.toMatchObject({
      accessMode: 'owner-only',
    });
  });

  it('allows only one real-store winner when registries concurrently update a stale mode', async () => {
    const store = new InMemoryArtifactStore();
    const seed = new ServerRegistry(store);
    await deploy(seed, TENANT, 'owner-only');
    const firstRegistry = new ServerRegistry(store);
    const secondRegistry = new ServerRegistry(store);

    const results = await Promise.all([
      firstRegistry.updateAccess(TENANT, { accessMode: 'authenticated' }),
      secondRegistry.updateAccess(TENANT, { accessMode: 'public' }),
    ]);

    const successes = results.filter((result) => result.ok);
    const conflicts = results.filter((result) => !result.ok);
    expect(successes).toHaveLength(1);
    expect(conflicts).toEqual([
      {
        ok: false,
        status: 409,
        code: 'access_update_conflict',
        message: 'The active deployment changed before access could be updated.',
      },
    ]);
    const winner = successes[0];
    expect(winner?.ok).toBe(true);
    if (!winner?.ok) throw new Error('expected one successful access update');
    await expect(store.getActiveByTenant(TENANT)).resolves.toMatchObject({
      accessMode: winner.record.accessMode,
    });
    await expect(firstRegistry.getActiveByTenant(TENANT)).resolves.toMatchObject({
      accessMode: winner.record.accessMode,
    });
    await expect(secondRegistry.getActiveByTenant(TENANT)).resolves.toMatchObject({
      accessMode: winner.record.accessMode,
    });
  });

  it('allows only one no-store winner when updates concurrently observe the same mode', async () => {
    const registry = new ServerRegistry();
    await deploy(registry, TENANT, 'owner-only');

    const results = await Promise.all([
      registry.updateAccess(TENANT, { accessMode: 'authenticated' }),
      registry.updateAccess(TENANT, { accessMode: 'public' }),
    ]);

    const successes = results.filter((result) => result.ok);
    const conflicts = results.filter((result) => !result.ok);
    expect(successes).toHaveLength(1);
    expect(conflicts).toEqual([
      {
        ok: false,
        status: 409,
        code: 'access_update_conflict',
        message: 'The active deployment changed before access could be updated.',
      },
    ]);
    const winner = successes[0];
    if (!winner?.ok) throw new Error('expected one successful access update');
    await expect(registry.getActiveByTenant(TENANT)).resolves.toMatchObject({
      accessMode: winner.record.accessMode,
    });
  });

  it('rejects a stale no-store legacy no-op and does not materialize an unchanged one', async () => {
    const legacy = legacyActiveRecord();
    const state: RegistryStateView = {
      store: undefined,
      records: new Map([[legacy.deploymentId, legacy]]),
      servers: new Map(),
      activeTenants: new Map(),
      productionEnvironments: new Map(),
    };
    const unexpectedLoad = () => Promise.reject(new Error('no-op must not load the server'));

    const unchanged = await updateRegistryAccess(
      state,
      TENANT,
      { accessMode: 'owner-only' },
      unexpectedLoad,
    );

    expect(unchanged).toMatchObject({
      ok: true,
      changed: false,
      accessChanged: false,
      ownerChanged: false,
      previousAccessMode: 'owner-only',
      previousOwnerSubject: ACTOR.subject,
    });
    expect(state.records.get(legacy.deploymentId)).not.toHaveProperty('accessMode');

    state.records.set(legacy.deploymentId, legacy);
    const staleNoOp = updateRegistryAccess(
      state,
      TENANT,
      { accessMode: 'owner-only' },
      unexpectedLoad,
    );
    state.records.set(legacy.deploymentId, { ...legacy, accessMode: 'public' });

    await expect(staleNoOp).resolves.toEqual({
      ok: false,
      status: 409,
      code: 'access_update_conflict',
      message: 'The active deployment changed before access could be updated.',
    });
    expect(state.records.get(legacy.deploymentId)).toMatchObject({ accessMode: 'public' });
  });

  it('reports a missing active deployment before loading or mutating it', async () => {
    const store = new NoActiveDeploymentStore();
    const registry = new ServerRegistry(store);

    await expect(registry.updateAccess(TENANT, { accessMode: 'public' })).resolves.toEqual({
      ok: false,
      status: 404,
      code: 'no_active_deployment',
      message: 'No active deployment exists for this environment.',
    });
    expect(store.deploymentLoads).toBe(0);
    expect(store.accessUpdates).toBe(0);
  });

  it('stores an explicit owner separately from the real deploy actor', async () => {
    const store = new InMemoryArtifactStore();
    const registry = new ServerRegistry(store);

    const result = await registry.deploy(TENANT, basicManifest(), {
      actor: { subject: 'self-host-admin', superAdmin: true },
      accessMode: 'owner-only',
      ownerSubject: 'oauth-human',
    });

    expect(result).toMatchObject({
      ok: true,
      accessMode: 'owner-only',
      ownerSubject: 'oauth-human',
    });
    if (!result.ok) throw new Error('expected deploy to succeed');
    await expect(store.get(result.deploymentId)).resolves.toMatchObject({
      createdBySubject: 'self-host-admin',
      ownerSubject: 'oauth-human',
    });
    await expect(registry.getActiveByTenant(TENANT)).resolves.toMatchObject({
      ownerSubject: 'oauth-human',
    });
    await expect(registry.getStatus(TENANT, 'https://borg.example')).resolves.toMatchObject({
      deployment: { ownerSubject: 'oauth-human' },
    });
    await expect(registry.listDeployments({ org: TENANT.org })).resolves.toEqual([
      expect.objectContaining({ ownerSubject: 'oauth-human' }),
    ]);
  });

  it('stores the deploy actor as the owner when an owner-only deploy omits the binding', async () => {
    const store = new InMemoryArtifactStore();
    const registry = new ServerRegistry(store);

    const result = await registry.deploy(TENANT, basicManifest(), {
      actor: ACTOR,
      accessMode: 'owner-only',
    });

    expect(result).toMatchObject({ ok: true, ownerSubject: ACTOR.subject });
    if (!result.ok) throw new Error('expected deploy to succeed');
    await expect(store.get(result.deploymentId)).resolves.toMatchObject({
      createdBySubject: ACTOR.subject,
      ownerSubject: ACTOR.subject,
    });
  });

  it('allows only one no-store owner transfer from the same observed binding', async () => {
    const registry = new ServerRegistry();
    await deploy(registry, TENANT, 'owner-only');

    const results = await Promise.all([
      registry.updateAccess(TENANT, {
        accessMode: 'owner-only',
        ownerSubject: 'oauth-owner-a',
      }),
      registry.updateAccess(TENANT, {
        accessMode: 'owner-only',
        ownerSubject: 'oauth-owner-b',
      }),
    ]);

    const successes = results.filter((result) => result.ok);
    expect(successes).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      {
        ok: false,
        status: 409,
        code: 'access_update_conflict',
        message: 'The active deployment changed before access could be updated.',
      },
    ]);
    const winner = successes[0];
    if (!winner?.ok) throw new Error('expected one successful owner transfer');
    expect(winner).toMatchObject({
      changed: true,
      accessChanged: false,
      ownerChanged: true,
      previousOwnerSubject: ACTOR.subject,
    });
    await expect(registry.getActiveByTenant(TENANT)).resolves.toMatchObject({
      ownerSubject: winner.record.ownerSubject,
    });
  });

  it('conflicts an idempotent replay after transfer and with a different resolved owner', async () => {
    const store = new InMemoryArtifactStore();
    const registry = new ServerRegistry(store);
    const options = {
      actor: ACTOR,
      accessMode: 'owner-only' as const,
      idempotencyKey: 'owner-bound-deploy',
    };

    const initial = await registry.deploy(TENANT, basicManifest(), options);
    expect(initial).toMatchObject({ ok: true, ownerSubject: ACTOR.subject });
    await expect(registry.deploy(TENANT, basicManifest(), options)).resolves.toMatchObject({
      ok: true,
      replayed: true,
      ownerSubject: ACTOR.subject,
    });
    await expect(
      registry.deploy(TENANT, basicManifest(), { ...options, ownerSubject: 'oauth-other' }),
    ).resolves.toMatchObject({ ok: false, conflict: true, code: 'idempotency_conflict' });

    await expect(
      registry.updateAccess(TENANT, {
        accessMode: 'owner-only',
        ownerSubject: 'oauth-transferred',
      }),
    ).resolves.toMatchObject({ ok: true, ownerChanged: true });
    await expect(registry.deploy(TENANT, basicManifest(), options)).resolves.toMatchObject({
      ok: false,
      conflict: true,
      code: 'idempotency_conflict',
    });
  });

  it('rolls back to the historical record owner without rewriting either record', async () => {
    const store = new InMemoryArtifactStore();
    const registry = new ServerRegistry(store);
    const historical = await registry.deploy(TENANT, basicManifest(), {
      actor: ACTOR,
      accessMode: 'owner-only',
      ownerSubject: 'historical-owner',
    });
    const current = await registry.deploy(TENANT, basicManifest(), {
      actor: ACTOR,
      accessMode: 'owner-only',
      ownerSubject: 'current-owner',
    });
    if (!historical.ok || !current.ok) throw new Error('expected deploys to succeed');
    await registry.updateAccess(TENANT, {
      accessMode: 'owner-only',
      ownerSubject: 'transferred-owner',
    });

    await expect(registry.rollback(TENANT, historical.deploymentId)).resolves.toMatchObject({
      ok: true,
      deploymentId: historical.deploymentId,
      ownerSubject: 'historical-owner',
    });
    await expect(store.get(historical.deploymentId)).resolves.toMatchObject({
      active: true,
      ownerSubject: 'historical-owner',
      createdBySubject: ACTOR.subject,
    });
    await expect(store.get(current.deploymentId)).resolves.toMatchObject({
      active: false,
      ownerSubject: 'transferred-owner',
      createdBySubject: ACTOR.subject,
    });
  });
});

class CountingAccessStore extends InMemoryArtifactStore {
  accessUpdates = 0;

  override async updateActiveAccess(
    ref: TenantRef,
    deploymentId: string,
    input: Parameters<InMemoryArtifactStore['updateActiveAccess']>[2],
  ) {
    this.accessUpdates += 1;
    return super.updateActiveAccess(ref, deploymentId, input);
  }
}

class ConflictAccessStore extends InMemoryArtifactStore {
  override updateActiveAccess(
    _ref: TenantRef,
    _deploymentId: string,
    _input: Parameters<InMemoryArtifactStore['updateActiveAccess']>[2],
  ): Promise<undefined> {
    return Promise.resolve(undefined);
  }
}

class NoActiveDeploymentStore extends InMemoryArtifactStore {
  deploymentLoads = 0;
  accessUpdates = 0;

  override get(deploymentId: string) {
    this.deploymentLoads += 1;
    return super.get(deploymentId);
  }

  override async updateActiveAccess(
    ref: TenantRef,
    deploymentId: string,
    input: Parameters<InMemoryArtifactStore['updateActiveAccess']>[2],
  ) {
    this.accessUpdates += 1;
    return super.updateActiveAccess(ref, deploymentId, input);
  }
}

async function deploy(
  registry: ServerRegistry,
  tenant: TenantRef,
  accessMode: 'owner-only' | 'org-members' | 'public',
  options: {
    readonly actor?: typeof ACTOR | undefined;
    readonly orgMembershipSources?: readonly ('explicit' | 'group')[] | undefined;
  } = {},
  manifest = basicManifest(),
): Promise<void> {
  const result = await registry.deploy(tenant, manifest, {
    accessMode,
    ...(options.actor === undefined && accessMode === 'public'
      ? {}
      : { actor: options.actor ?? ACTOR }),
    ...(options.orgMembershipSources !== undefined
      ? { orgMembershipSources: options.orgMembershipSources }
      : {}),
  });
  expect(result).toMatchObject({ ok: true });
}

function seedLegacyActiveRecord(store: InMemoryArtifactStore): Promise<void> {
  return store.append(legacyActiveRecord());
}

function legacyActiveRecord(): DeployRecord {
  return {
    schemaVersion: 1,
    deploymentId: 'legacy-support',
    orgSlug: TENANT.org,
    appSlug: TENANT.app,
    environment: TENANT.env,
    serverVersion: '1',
    deploymentVersion: 1,
    active: true,
    serverName: 'support',
    createdAt: '2026-07-28T00:00:00.000Z',
    createdBySubject: ACTOR.subject,
    createdByEmail: ACTOR.email,
    manifest: basicManifest(),
    secrets: { enc: 'none', values: {} },
  };
}

function basicManifest(): string {
  return JSON.stringify({
    manifestVersion: '1',
    server: { name: 'support', version: '1.0.0', title: 'Support' },
    tools: [
      {
        name: 'status',
        description: 'Return the service status.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        fulfilment: { steps: [], output: { ok: true } },
      },
    ],
  });
}

function userManifest(): string {
  return `
manifestVersion: "1"
server:
  name: support_user
  version: 1.0.0
  title: Support
tools:
  - name: whoami
    description: Return the calling user.
    inputSchema:
      type: object
      properties: {}
      additionalProperties: false
    fulfilment:
      steps: []
      output:
        subject: \${user.subject}
`;
}
