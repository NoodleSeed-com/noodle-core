import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type ArtifactStore,
  type DeployRecord,
  InMemoryArtifactStore,
  JsonFileArtifactStore,
  ServerRegistry,
  type TenantAuthConfig,
  type TenantRef,
} from '../src/index.js';

const PROD = { org: 'acme', app: 'support', env: 'prod' } as const;
const DEV = { org: 'acme', app: 'support', env: 'dev' } as const;
const OTHER = { org: 'acme', app: 'other', env: 'prod' } as const;
const DIRECT_AUTH = {
  issuer: 'https://idp.example',
  audience: 'acme-support',
} as const satisfies TenantAuthConfig;

describe('customer auth audience isolation', () => {
  it('rejects a conflicting issuer/audience deploy in another app/environment boundary', async () => {
    const registry = registryFor(new InMemoryArtifactStore());

    await expect(deploy(registry, PROD, DIRECT_AUTH, '1')).resolves.toMatchObject({ ok: true });
    await expect(deploy(registry, DEV, DIRECT_AUTH, '1')).resolves.toEqual({
      ok: false,
      errors: [
        {
          code: 'customer_auth_audience_conflict',
          path: 'server.auth.audience',
          message:
            'Customer OIDC issuer/audience bindings must be unique to one app and environment.',
        },
      ],
    });
  });

  it('allows versions of the same app/environment to share issuer/audience bindings', async () => {
    const registry = registryFor(new InMemoryArtifactStore());

    await expect(deploy(registry, PROD, DIRECT_AUTH, '1')).resolves.toMatchObject({ ok: true });
    await expect(deploy(registry, PROD, DIRECT_AUTH, '2')).resolves.toMatchObject({ ok: true });
    await expect(registry.getActiveByTenantVersion(PROD, '1')).resolves.toBeDefined();
    await expect(registry.getActiveByTenantVersion(PROD, '2')).resolves.toBeDefined();
  });

  it('fails closed during recovery and serving when legacy active records collide', async () => {
    const root = await mkdtemp(join(tmpdir(), 'customer-auth-legacy-collision-'));
    try {
      const directory = join(root, 'deployments');
      await mkdir(directory, { recursive: true });
      await Promise.all([
        writeFile(
          join(directory, 'prod-deployment.json'),
          JSON.stringify(record('prod-deployment', PROD, DIRECT_AUTH)),
        ),
        writeFile(
          join(directory, 'dev-deployment.json'),
          JSON.stringify(record('dev-deployment', DEV, DIRECT_AUTH)),
        ),
      ]);
      const store = new JsonFileArtifactStore(root);
      const registry = registryFor(store);

      const recovered = await registry.recover();

      expect(recovered).toMatchObject({
        recovered: 0,
        failed: [
          {
            errors: [
              {
                code: 'customer_auth_audience_conflict',
                path: 'server.auth.audience',
              },
            ],
          },
          {
            errors: [
              {
                code: 'customer_auth_audience_conflict',
                path: 'server.auth.audience',
              },
            ],
          },
        ],
      });
      await expect(registry.getActiveByTenant(PROD)).resolves.toBeUndefined();
      await expect(registry.getActiveByTenant(DEV)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('quarantines a malformed legacy projection without denying an unrelated customer boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'customer-auth-malformed-isolation-'));
    try {
      const directory = join(root, 'deployments');
      await mkdir(directory, { recursive: true });
      await Promise.all([
        writeFile(
          join(directory, 'malformed-deployment.json'),
          JSON.stringify({
            ...record('malformed-deployment', DEV, DIRECT_AUTH),
            serverAuth: { kind: 'federatedOidc', issuers: [] },
          }),
        ),
        writeFile(
          join(directory, 'unrelated-deployment.json'),
          JSON.stringify(
            record('unrelated-deployment', OTHER, {
              issuer: 'https://other-idp.example',
              audience: 'acme-other',
            }),
          ),
        ),
      ]);
      const registry = registryFor(new JsonFileArtifactStore(root));

      await expect(registry.recover()).resolves.toMatchObject({
        recovered: 1,
        failed: [
          {
            deploymentId: 'malformed-deployment',
            errors: [expect.objectContaining({ code: 'server_auth_required' })],
          },
        ],
      });
      await expect(registry.getActiveByTenant(OTHER)).resolves.toBeDefined();
      await expect(registry.getActiveByTenant(DEV)).rejects.toThrow(
        'customers access mode requires server.auth',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('detects an overlapping binding inside federated OIDC while allowing distinct bindings', async () => {
    const registry = registryFor(new InMemoryArtifactStore());
    const federated = {
      kind: 'federatedOidc',
      issuers: [
        { issuer: 'https://idp-a.example/', audience: 'acme-support' },
        { issuer: 'https://idp-b.example', audience: 'acme-support-partner' },
      ],
    } as const satisfies TenantAuthConfig;

    await expect(deploy(registry, PROD, federated, '1')).resolves.toMatchObject({ ok: true });
    await expect(
      deploy(
        registry,
        DEV,
        {
          issuer: 'https://idp-a.example',
          audience: 'acme-support',
        },
        '1',
      ),
    ).resolves.toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: 'customer_auth_audience_conflict' })],
    });
    await expect(
      deploy(
        registry,
        DEV,
        {
          issuer: 'https://idp-a.example',
          audience: 'acme-support-dev',
        },
        '2',
      ),
    ).resolves.toMatchObject({ ok: true });
  });

  it('rejects an access transition that would activate a cross-boundary binding conflict', async () => {
    const store = new InMemoryArtifactStore();
    const registry = registryFor(store);
    await expect(deploy(registry, PROD, DIRECT_AUTH, '1')).resolves.toMatchObject({ ok: true });
    await store.append({
      ...record('dev-owner-only', DEV, DIRECT_AUTH),
      accessMode: 'owner-only',
      createdBySubject: 'owner',
    });

    await expect(registry.updateAccess(DEV, { accessMode: 'customers' })).resolves.toEqual({
      ok: false,
      status: 409,
      code: 'customer_auth_audience_conflict',
      message: 'Customer OIDC issuer/audience bindings must be unique to one app and environment.',
    });
    await expect(store.getActiveByTenant(DEV)).resolves.toMatchObject({
      deploymentId: 'dev-owner-only',
      accessMode: 'owner-only',
    });
  });

  it('rejects rollback activation that would restore a cross-boundary binding conflict', async () => {
    const store = new InMemoryArtifactStore();
    const registry = registryFor(store);
    await expect(deploy(registry, PROD, DIRECT_AUTH, '1')).resolves.toMatchObject({ ok: true });
    await store.append({
      ...record('dev-current', DEV, DIRECT_AUTH),
      accessMode: 'owner-only',
      deploymentVersion: 2,
      createdBySubject: 'owner',
    });
    await store.append({
      ...record('dev-rollback', DEV, DIRECT_AUTH),
      active: false,
      deploymentVersion: 1,
    });

    await expect(registry.rollback(DEV, 'dev-rollback')).resolves.toEqual({
      ok: false,
      status: 409,
      error: 'deployment cannot be activated: customer_auth_audience_conflict',
    });
    await expect(store.getActiveByTenant(DEV)).resolves.toMatchObject({
      deploymentId: 'dev-current',
      accessMode: 'owner-only',
    });
  });

  it('atomically grants one owner when concurrent registries deploy the same binding', async () => {
    const store = new BarrierArtifactStore();
    const first = registryFor(store);
    const second = registryFor(store);

    const results = await Promise.all([
      deploy(first, PROD, DIRECT_AUTH, '1'),
      deploy(second, DEV, DIRECT_AUTH, '1'),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({
        errors: [expect.objectContaining({ code: 'customer_auth_audience_conflict' })],
      }),
    ]);
    expect(
      (await store.loadAll()).filter((item) => item.active && item.accessMode === 'customers'),
    ).toHaveLength(1);
  });

  it('atomically grants one owner when concurrent registries enable customer access', async () => {
    const store = new BarrierArtifactStore();
    await store.append({
      ...record('prod-owner-only', PROD, DIRECT_AUTH),
      accessMode: 'owner-only',
      createdBySubject: 'owner',
    });
    await store.append({
      ...record('dev-owner-only', DEV, DIRECT_AUTH),
      accessMode: 'owner-only',
      createdBySubject: 'owner',
    });
    const first = registryFor(store);
    const second = registryFor(store);

    const results = await Promise.all([
      first.updateAccess(PROD, { accessMode: 'customers' }),
      second.updateAccess(DEV, { accessMode: 'customers' }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({ code: 'customer_auth_audience_conflict' }),
    ]);
  });

  it('repairs recovered auth projections and rejects a later cross-boundary access transition', async () => {
    const store = new InMemoryArtifactStore();
    for (const [tenant, deploymentId] of [
      [PROD, 'prod-recovered-owner'],
      [DEV, 'dev-recovered-owner'],
    ] as const) {
      await store.append({
        ...record(deploymentId, tenant, DIRECT_AUTH),
        accessMode: 'owner-only',
        createdBySubject: 'owner',
        serverAuth: undefined,
      });
    }
    const registry = registryFor(store);

    await expect(registry.updateAccess(PROD, { accessMode: 'customers' })).resolves.toMatchObject({
      ok: true,
    });
    await expect(store.getActiveByTenant(PROD)).resolves.toMatchObject({
      accessMode: 'customers',
      serverAuth: DIRECT_AUTH,
    });
    await expect(registry.updateAccess(DEV, { accessMode: 'customers' })).resolves.toMatchObject({
      ok: false,
      code: 'customer_auth_audience_conflict',
    });
    await expect(store.getActiveByTenant(DEV)).resolves.toMatchObject({
      accessMode: 'owner-only',
    });
  });

  it('atomically grants one owner when concurrent registries roll back customer targets', async () => {
    const store = new BarrierArtifactStore();
    for (const [tenant, prefix] of [
      [PROD, 'prod'],
      [DEV, 'dev'],
    ] as const) {
      await store.append({
        ...record(`${prefix}-current`, tenant, DIRECT_AUTH),
        accessMode: 'owner-only',
        deploymentVersion: 2,
        createdBySubject: 'owner',
      });
      await store.append({
        ...record(`${prefix}-rollback`, tenant, DIRECT_AUTH),
        active: false,
        deploymentVersion: 1,
      });
    }
    const first = registryFor(store);
    const second = registryFor(store);

    const results = await Promise.all([
      first.rollback(PROD, 'prod-rollback'),
      second.rollback(DEV, 'dev-rollback'),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({
        error: 'deployment cannot be activated: customer_auth_audience_conflict',
      }),
    ]);
  });

  it('rejects restore without clearing archive stamps when another app owns the binding', async () => {
    const store = new InMemoryArtifactStore();
    const registry = registryFor(store);
    await expect(deploy(registry, PROD, DIRECT_AUTH, '1')).resolves.toMatchObject({ ok: true });
    await registry.archiveApp(PROD.org, PROD.app, '2026-07-30T00:00:00.000Z');
    await expect(deploy(registry, OTHER, DIRECT_AUTH, '1')).resolves.toMatchObject({ ok: true });

    await expect(registry.restoreApp(PROD.org, PROD.app)).rejects.toMatchObject({
      code: 'customer_auth_audience_conflict',
    });
    await expect(store.getAppArchivedAt(PROD.org, PROD.app)).resolves.toBe(
      '2026-07-30T00:00:00.000Z',
    );
  });

  it('rejects restore when persisted auth is valid but differs from compiled auth', async () => {
    const store = new InMemoryArtifactStore();
    await store.append({
      ...record('stale-projection', PROD, DIRECT_AUTH),
      serverAuth: { issuer: DIRECT_AUTH.issuer, audience: 'stale-audience' },
      archivedAt: '2026-07-30T00:00:00.000Z',
    });
    const registry = registryFor(store);

    await expect(registry.restoreApp(PROD.org, PROD.app)).rejects.toMatchObject({
      code: 'customer_auth_audience_conflict',
    });
    await expect(store.getAppArchivedAt(PROD.org, PROD.app)).resolves.toBe(
      '2026-07-30T00:00:00.000Z',
    );
  });
});

class BarrierArtifactStore extends InMemoryArtifactStore {
  #checks = 0;
  #release: (() => void) | undefined;
  readonly #ready = new Promise<void>((resolve) => {
    this.#release = resolve;
  });

  override async findActiveCustomerAuthAudienceConflict(
    ref: TenantRef,
    auth: TenantAuthConfig,
  ): Promise<TenantRef | undefined> {
    this.#checks++;
    if (this.#checks <= 2) {
      if (this.#checks === 2) this.#release?.();
      await this.#ready;
      return undefined;
    }
    return super.findActiveCustomerAuthAudienceConflict(ref, auth);
  }
}

function registryFor(store: ArtifactStore): ServerRegistry {
  return new ServerRegistry(store, undefined, undefined, {
    customerVerifierFactory: () => async (_token, resource) => ({
      caller: {
        subject: 'customer',
        ...(resource === undefined ? {} : { audience: resource }),
        identityKind: 'customer',
      },
    }),
  });
}

function deploy(
  registry: ServerRegistry,
  tenant: TenantRef,
  auth: TenantAuthConfig,
  serverVersion: string,
) {
  return registry.deploy(tenant, manifest(auth), {
    accessMode: 'customers',
    serverVersion,
    actor: { subject: 'owner', email: 'owner@example.com', superAdmin: false },
  });
}

function record(deploymentId: string, tenant: TenantRef, auth: TenantAuthConfig): DeployRecord {
  return {
    schemaVersion: 1,
    deploymentId,
    orgSlug: tenant.org,
    appSlug: tenant.app,
    environment: tenant.env,
    serverVersion: '1',
    deploymentVersion: 1,
    active: true,
    serverName: 'support',
    createdAt: '2026-07-30T00:00:00.000Z',
    accessMode: 'customers',
    serverAuth: auth,
    manifest: manifest(auth),
    secrets: { enc: 'none', values: {} },
  };
}

function manifest(auth: TenantAuthConfig): string {
  return JSON.stringify({
    manifestVersion: '2',
    server: {
      name: 'support',
      title: 'Support',
      version: '1.0.0',
      auth,
    },
    tools: [
      {
        name: 'whoami',
        description: 'Show the caller',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        fulfilment: { steps: [], output: { ok: true } },
      },
    ],
  });
}
