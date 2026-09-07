import { describe, expect, it } from 'vitest';
import {
  type DeployRecord,
  InMemoryArtifactStore,
  ServerRegistry,
  type TenantAuthConfig,
} from '../src/index.js';

const TENANT = { org: 'acme', app: 'support', env: 'prod' } as const;
const FEDERATED_AUTH = {
  kind: 'federatedOidc',
  issuers: [
    { issuer: 'https://idp-a.example', audience: 'api://support' },
    { issuer: 'https://idp-b.example', audience: 'api://support-partner' },
  ],
} as const satisfies TenantAuthConfig;
const FEDERATED_ROUTED_AUTH = {
  kind: 'federatedOidc',
  issuers: [
    {
      issuer: 'https://idp-a.example',
      audience: 'api://support',
      routing: { endpoints: { customer_api: { claim: 'tenant_a.api_url' } } },
    },
    {
      issuer: 'https://idp-b.example',
      audience: 'api://support-partner',
      routing: { endpoints: { customer_api: { claim: 'tenant_b.api_url' } } },
    },
  ],
} as const satisfies TenantAuthConfig;
const ROUTED_CATALOG = {
  id: 'customer_records',
  version: '1.0.0',
  kind: 'catalog',
  operations: {
    list_records: {
      type: 'read',
      input: { type: 'object', properties: {}, additionalProperties: false },
      output: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  customerRouting: {
    directEndpoint: 'customer_api',
    endpoints: {
      customer_api: { allowedHttpsHostSuffixes: ['noodleseed.dev'] },
    },
    operationEndpoints: { list_records: ['customer_api'] },
    operationActionEndpoints: {},
  },
} as const;

describe('customer-auth recovery boundary', () => {
  it('rebuilds federated issuer and verifier state from the compiled manifest after restart', async () => {
    const store = new InMemoryArtifactStore();
    await store.append(record({ manifest: manifest(FEDERATED_AUTH) }));
    const seenAuth: TenantAuthConfig[] = [];
    const registry = registryFor(store, seenAuth);

    await expect(registry.recover()).resolves.toEqual({ recovered: 1, failed: [] });
    const target = await registry.getActiveByTenant(TENANT);

    expect(target?.authServerIssuers).toEqual(['https://idp-a.example', 'https://idp-b.example']);
    expect(target?.verifyToken).toBeDefined();
    expect(seenAuth).toEqual([FEDERATED_AUTH]);
  });

  it('preserves per-issuer route mappings across restart and a cold cache miss', async () => {
    const store = new InMemoryArtifactStore();
    await store.append(
      record({
        serverAuth: FEDERATED_ROUTED_AUTH,
        manifest: manifest(FEDERATED_ROUTED_AUTH, { routedConnector: true }),
      }),
    );
    const recoveredAuth: TenantAuthConfig[] = [];
    const coldAuth: TenantAuthConfig[] = [];
    const options = (seenAuth: TenantAuthConfig[]) => ({
      platformCatalog: [ROUTED_CATALOG],
      customerVerifierFactory: (auth: TenantAuthConfig) => {
        seenAuth.push(auth);
        return async () => ({
          caller: { subject: 'customer-sub', identityKind: 'customer' as const },
        });
      },
    });

    const recovered = new ServerRegistry(store, undefined, undefined, options(recoveredAuth));
    await expect(recovered.recover()).resolves.toEqual({ recovered: 1, failed: [] });
    const cold = new ServerRegistry(store, undefined, undefined, options(coldAuth));
    await expect(cold.getActiveByTenant(TENANT)).resolves.toBeDefined();

    for (const seen of [recoveredAuth, coldAuth]) {
      expect(seen).toEqual([FEDERATED_ROUTED_AUTH]);
      expect(seen[0]).toMatchObject({
        kind: 'federatedOidc',
        issuers: [
          {
            routing: { endpoints: { customer_api: { claim: 'tenant_a.api_url' } } },
          },
          {
            routing: { endpoints: { customer_api: { claim: 'tenant_b.api_url' } } },
          },
        ],
      });
    }
  });

  it('preserves the transport MCP resource for a recovered customer verifier', async () => {
    const store = new InMemoryArtifactStore();
    await store.append(record({ manifest: manifest(FEDERATED_AUTH) }));
    const expectedResource = 'https://cloud.example/o/acme/support/prod/mcp';
    const registry = new ServerRegistry(store, undefined, undefined, {
      customerVerifierFactory: () => async (_token, resource) =>
        resource === expectedResource
          ? {
              caller: {
                subject: 'customer-sub',
                audience: resource,
                identityKind: 'customer',
              },
            }
          : null,
    });

    await expect(registry.recover()).resolves.toEqual({ recovered: 1, failed: [] });
    const target = await registry.getActiveByTenant(TENANT);

    await expect(target?.verifyToken?.('customer-token', expectedResource)).resolves.toMatchObject({
      caller: { audience: expectedResource },
    });
    await expect(
      target?.verifyToken?.('customer-token', 'https://cloud.example/o/acme/other/prod/mcp'),
    ).resolves.toBe(null);
  });

  it('rebuilds federated issuer and verifier state on a cold cache miss', async () => {
    const store = new InMemoryArtifactStore();
    await store.append(record({ manifest: manifest(FEDERATED_AUTH) }));
    const seenAuth: TenantAuthConfig[] = [];
    const registry = registryFor(store, seenAuth);

    const target = await registry.getActiveByTenant(TENANT);

    expect(target?.authServerIssuers).toEqual(['https://idp-a.example', 'https://idp-b.example']);
    expect(target?.verifyToken).toBeDefined();
    expect(seenAuth).toEqual([FEDERATED_AUTH]);
  });

  it('does not refetch a freshly loaded deployment during a cold serving lookup', async () => {
    const store = new DeploymentGetCountingStore();
    await store.append(record());
    const registry = registryFor(store);

    await expect(registry.getServing('deployment-1')).resolves.toMatchObject({
      deploymentId: 'deployment-1',
      accessMode: 'customers',
    });
    expect(store.deploymentGetCalls).toBe(1);
  });

  it('does not recover a customers record whose compiled manifest has no customer auth', async () => {
    const store = new InMemoryArtifactStore();
    await store.append(record({ manifest: manifest(), accessMode: 'customers' }));
    const registry = registryFor(store);

    await expect(registry.recover()).resolves.toEqual({
      recovered: 0,
      failed: [
        {
          deploymentId: 'deployment-1',
          errors: [
            {
              code: 'server_auth_required',
              path: 'server.auth',
              message: 'customers access mode requires server.auth',
            },
          ],
        },
      ],
    });
    await expect(registry.getActiveByTenant(TENANT)).rejects.toThrow(
      'customers access mode requires server.auth',
    );
  });

  it('validates customer auth before rollback activation', async () => {
    const store = new InMemoryArtifactStore();
    await store.append(
      record({
        deploymentId: 'current',
        deploymentVersion: 2,
        active: true,
        accessMode: 'owner-only',
        manifest: manifest(),
      }),
    );
    await store.append(
      record({
        deploymentId: 'unsafe-target',
        deploymentVersion: 1,
        active: false,
        accessMode: 'customers',
        manifest: manifest(),
      }),
    );
    const registry = registryFor(store);

    await expect(registry.rollback(TENANT, 'unsafe-target')).resolves.toMatchObject({
      ok: false,
      status: 409,
      error: 'deployment cannot be activated: server_auth_required',
    });
    await expect(store.getActiveByTenant(TENANT)).resolves.toMatchObject({
      deploymentId: 'current',
      accessMode: 'owner-only',
    });
  });

  it('persists compiled customer auth when rolling back a recovered projection omission', async () => {
    const store = new InMemoryArtifactStore();
    await store.append(
      record({
        deploymentId: 'current',
        deploymentVersion: 2,
        active: true,
        accessMode: 'owner-only',
      }),
    );
    await store.append(
      record({
        deploymentId: 'recovered-target',
        deploymentVersion: 1,
        active: false,
        serverAuth: undefined,
      }),
    );
    const registry = registryFor(store);

    await expect(registry.rollback(TENANT, 'recovered-target')).resolves.toMatchObject({
      ok: true,
      deploymentId: 'recovered-target',
      accessMode: 'customers',
    });
    await expect(store.getActiveByTenant(TENANT)).resolves.toMatchObject({
      deploymentId: 'recovered-target',
      serverAuth: FEDERATED_AUTH,
    });
  });

  it('uses compiled customer auth when activating customers access after a recovered row omission', async () => {
    const store = new InMemoryArtifactStore();
    await store.append(
      record({
        accessMode: 'owner-only',
        serverAuth: undefined,
        manifest: manifest(FEDERATED_AUTH),
      }),
    );
    const registry = registryFor(store);

    await expect(registry.updateAccess(TENANT, { accessMode: 'customers' })).resolves.toMatchObject(
      {
        ok: true,
        record: { deploymentId: 'deployment-1', accessMode: 'customers' },
      },
    );
    const target = await registry.getActiveByTenant(TENANT);
    expect(target?.authServerIssuers).toEqual(['https://idp-a.example', 'https://idp-b.example']);
    await expect(store.getActiveByTenant(TENANT)).resolves.toMatchObject({
      accessMode: 'customers',
      serverAuth: FEDERATED_AUTH,
    });
  });

  it('fails closed when persisted customer auth does not match the compiled manifest', async () => {
    const store = new InMemoryArtifactStore();
    await store.append(
      record({
        serverAuth: {
          issuer: 'https://wrong-idp.example',
          audience: 'api://wrong-audience',
        },
        manifest: manifest(FEDERATED_AUTH),
      }),
    );
    const registry = registryFor(store);

    await expect(registry.recover()).resolves.toEqual({
      recovered: 0,
      failed: [
        {
          deploymentId: 'deployment-1',
          errors: [
            {
              code: 'server_auth_required',
              path: 'server.auth',
              message: 'customers access mode requires server.auth',
            },
          ],
        },
      ],
    });
    await expect(registry.getActiveByTenant(TENANT)).rejects.toThrow(
      'customers access mode requires server.auth',
    );
  });

  it('projects compiler-authoritative customer auth for an archived bulk restore', async () => {
    const store = new InMemoryArtifactStore();
    await store.append(record({ archivedAt: '2026-07-29T00:00:00.000Z' }));
    const registry = registryFor(store);

    await expect(registry.customerAuthRestoreProjections(['deployment-1'])).resolves.toEqual([
      {
        deploymentId: 'deployment-1',
        manifest: manifest(FEDERATED_AUTH),
        serverAuth: FEDERATED_AUTH,
      },
    ]);

    await store.append(
      record({
        archivedAt: '2026-07-29T00:00:00.000Z',
        serverAuth: {
          issuer: 'https://wrong-idp.example',
          audience: 'api://wrong-audience',
        },
      }),
    );
    await expect(registry.customerAuthRestoreProjections(['deployment-1'])).rejects.toMatchObject({
      code: 'customer_auth_audience_conflict',
    });
  });

  it('evicts a cached customer target when its persisted auth projection drifts', async () => {
    const store = new InMemoryArtifactStore();
    const original = record();
    await store.append(original);
    const registry = registryFor(store);
    await expect(registry.getActiveByTenant(TENANT)).resolves.toBeDefined();

    await store.append({
      ...original,
      serverAuth: {
        issuer: 'https://wrong-idp.example',
        audience: 'api://wrong-audience',
      },
    });

    await expect(registry.getActiveByTenant(TENANT)).resolves.toBeUndefined();
  });

  it('does not apply a validated access change to a different deployment activated concurrently', async () => {
    const store = new AccessUpdateRaceStore();
    await store.append(
      record({
        deploymentId: 'validated-active',
        deploymentVersion: 2,
        active: true,
        accessMode: 'owner-only',
      }),
    );
    await store.append(
      record({
        deploymentId: 'unsafe-rollback-target',
        deploymentVersion: 1,
        active: false,
        accessMode: 'owner-only',
        manifest: manifest(),
      }),
    );
    store.beforeAccessUpdate = async () => {
      await store.activateDeployment(TENANT, 'unsafe-rollback-target');
    };
    const registry = registryFor(store);

    await expect(registry.updateAccess(TENANT, { accessMode: 'customers' })).resolves.toMatchObject(
      {
        ok: false,
        status: 409,
        code: 'access_update_conflict',
      },
    );
    await expect(store.getActiveByTenant(TENANT)).resolves.toMatchObject({
      deploymentId: 'unsafe-rollback-target',
      accessMode: 'owner-only',
    });
  });

  it('does not activate a rollback target whose access state changed after validation', async () => {
    const store = new RollbackRaceStore();
    await store.append(
      record({
        deploymentId: 'current',
        deploymentVersion: 2,
        active: true,
        accessMode: 'owner-only',
        manifest: manifest(),
      }),
    );
    await store.append(
      record({
        deploymentId: 'rollback-target',
        deploymentVersion: 1,
        active: false,
        accessMode: 'owner-only',
        manifest: manifest(),
      }),
    );
    store.beforeActivation = async () => {
      const target = await store.get('rollback-target');
      if (target !== undefined) {
        await store.append({ ...target, accessMode: 'customers' });
      }
    };
    const registry = registryFor(store);

    await expect(registry.rollback(TENANT, 'rollback-target')).resolves.toMatchObject({
      ok: false,
      status: 409,
      error: 'deployment changed while rollback was being validated',
    });
    await expect(store.getActiveByTenant(TENANT)).resolves.toMatchObject({
      deploymentId: 'current',
      accessMode: 'owner-only',
    });
  });

  it('reports customers deployments without compiled auth as unhealthy', async () => {
    const store = new InMemoryArtifactStore();
    await store.append(record({ manifest: manifest(), accessMode: 'customers' }));
    const registry = registryFor(store);

    await expect(registry.getStatus(TENANT, 'https://cloud.example')).resolves.toMatchObject({
      health: { state: 'unhealthy' },
    });
  });

  it.each([
    {
      name: 'tenant lookup',
      lookup: (registry: ServerRegistry) => registry.getActiveByTenant(TENANT),
    },
    {
      name: 'version-pinned lookup',
      lookup: (registry: ServerRegistry) => registry.getActiveByTenantVersion(TENANT, '1'),
    },
    {
      name: 'deployment-id serving lookup',
      lookup: (registry: ServerRegistry) => registry.getServing('deployment-1'),
    },
  ])('reconciles a cross-instance access change before $name dispatch', async ({ lookup }) => {
    const store = new InMemoryArtifactStore();
    await store.append(record({ accessMode: 'public' }));
    const writer = registryFor(store);
    const staleReader = registryFor(store);
    await expect(lookup(staleReader)).resolves.toMatchObject({ accessMode: 'public' });

    await expect(writer.updateAccess(TENANT, { accessMode: 'customers' })).resolves.toMatchObject({
      ok: true,
      record: { accessMode: 'customers' },
    });

    await expect(lookup(staleReader)).resolves.toMatchObject({
      accessMode: 'customers',
      authServerIssuers: ['https://idp-a.example', 'https://idp-b.example'],
    });
  });
});

class AccessUpdateRaceStore extends InMemoryArtifactStore {
  beforeAccessUpdate: (() => Promise<void>) | undefined;

  override async updateActiveAccess(
    ref: typeof TENANT,
    deploymentId: string,
    input: Parameters<InMemoryArtifactStore['updateActiveAccess']>[2],
  ) {
    const hook = this.beforeAccessUpdate;
    this.beforeAccessUpdate = undefined;
    await hook?.();
    return super.updateActiveAccess(ref, deploymentId, input);
  }
}

class DeploymentGetCountingStore extends InMemoryArtifactStore {
  deploymentGetCalls = 0;

  override get(deploymentId: string) {
    this.deploymentGetCalls += 1;
    return super.get(deploymentId);
  }
}

class RollbackRaceStore extends InMemoryArtifactStore {
  beforeActivation: (() => Promise<void>) | undefined;

  override async activateDeployment(
    ref: typeof TENANT,
    deploymentId: string,
    precondition?: { readonly expectedAccessMode: DeployRecord['accessMode'] },
  ) {
    const hook = this.beforeActivation;
    this.beforeActivation = undefined;
    await hook?.();
    return super.activateDeployment(ref, deploymentId, precondition);
  }
}

function registryFor(
  store: InMemoryArtifactStore,
  seenAuth: TenantAuthConfig[] = [],
): ServerRegistry {
  return new ServerRegistry(store, undefined, undefined, {
    customerVerifierFactory: (auth) => {
      seenAuth.push(auth);
      return async () => ({
        caller: { subject: 'customer-sub', identityKind: 'customer' },
      });
    },
  });
}

function record(overrides: Partial<DeployRecord> = {}): DeployRecord {
  return {
    schemaVersion: 1,
    deploymentId: 'deployment-1',
    orgSlug: TENANT.org,
    appSlug: TENANT.app,
    environment: TENANT.env,
    serverVersion: '1',
    deploymentVersion: 1,
    active: true,
    serverName: 'support',
    createdAt: '2026-07-28T00:00:00.000Z',
    createdBySubject: 'owner-sub',
    createdByEmail: 'owner@example.com',
    accessMode: 'customers',
    serverAuth: FEDERATED_AUTH,
    manifest: manifest(FEDERATED_AUTH),
    secrets: { enc: 'none', values: {} },
    ...overrides,
  };
}

function manifest(
  auth?: TenantAuthConfig,
  options: { readonly routedConnector?: boolean } = {},
): string {
  return JSON.stringify({
    manifestVersion: '2',
    server: {
      name: 'support',
      title: 'Support',
      version: '1.0.0',
      ...(auth !== undefined ? { auth } : {}),
    },
    ...(options.routedConnector === true
      ? {
          connectors: {
            api: { id: 'customer_records', version: '1.0.0' },
          },
        }
      : {}),
    tools: [
      {
        name: options.routedConnector === true ? 'list_records' : 'whoami',
        description: options.routedConnector === true ? 'List customer records' : 'Show the caller',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        fulfilment:
          options.routedConnector === true
            ? { use: 'api.list_records', args: {} }
            : { steps: [], output: { ok: true } },
      },
    ],
  });
}
