import type { IncomingMessage } from 'node:http';
import type { DeploymentPackageBinding } from '@noodle-borg/module';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryAuditStore, InMemoryControlPlaneStore } from '../src/index.js';
import { createModuleRouteContext } from '../src/modules/route-dispatch.js';

const request = { headers: { host: 'service.test' } } as IncomingMessage;

describe('module route host capabilities', () => {
  it('exposes only live delivery eligibility before tenant auth and binds it to the exact request', async () => {
    const registry = fakeRegistry();
    const context = createModuleRouteContext(request, {
      gate: gate(),
      controlPlane: await memberStore(),
      registry,
      audit: new InMemoryAuditStore(),
      options: {},
    });

    const delivery = await context.distributionDelivery?.get(request, {
      org: 'acme',
      deploymentId: 'dep_123',
    });
    expect(delivery).toEqual({
      deploymentId: 'dep_123',
      appSlug: 'tasks',
      environment: 'prod',
      serverVersion: '1',
      active: true,
      accessMode: 'org-members',
      snapshotSha256: 'c'.repeat(64),
    });
    expect(delivery).not.toHaveProperty('endpointUrl');
    expect(delivery).not.toHaveProperty('appPackage');

    registry.getDeployment.mockClear();
    registry.getDeploymentPackage.mockClear();
    const otherRequest = { headers: request.headers } as IncomingMessage;
    await expect(
      context.distributionDelivery?.get(otherRequest, {
        org: 'acme',
        deploymentId: 'dep_123',
      }),
    ).resolves.toBeUndefined();
    expect(registry.getDeployment).not.toHaveBeenCalled();
    expect(registry.getDeploymentPackage).not.toHaveBeenCalled();
  });

  it('does not touch deployment state until the same request has tenant authorization', async () => {
    const registry = fakeRegistry();
    const controlPlane = await memberStore();
    const context = createModuleRouteContext(request, {
      gate: gate(),
      controlPlane,
      registry,
      audit: new InMemoryAuditStore(),
      options: { publicBaseUrl: 'https://cloud.noodleseed.dev' },
    });

    await expect(
      context.deploymentPackages?.get(request, { org: 'acme', deploymentId: 'dep_123' }),
    ).resolves.toBeUndefined();
    expect(registry.getDeployment).not.toHaveBeenCalled();
    expect(registry.getDeploymentPackage).not.toHaveBeenCalled();

    await expect(
      context.tenantControl?.authorize(request, {
        org: 'acme',
        permission: 'deployments:write',
      }),
    ).resolves.toMatchObject({ ok: true, identity: { subject: 'member_1' } });
    await expect(
      context.deploymentPackages?.get(request, { org: 'acme', deploymentId: 'dep_123' }),
    ).resolves.toMatchObject({
      deploymentId: 'dep_123',
      accessMode: 'org-members',
      endpointUrl: expect.stringContaining('/tasks/'),
      snapshotSha256: 'c'.repeat(64),
      appPackage: {
        name: 'acme_tasks',
        skillMarkdown: '# Acme Tasks\n',
        referenceMarkdown: '# MCP surface\n',
      },
    } satisfies Partial<DeploymentPackageBinding>);
  });

  it('binds authorization to both the request object and organization', async () => {
    const registry = fakeRegistry();
    const context = createModuleRouteContext(request, {
      gate: gate(),
      controlPlane: await memberStore(),
      registry,
      audit: new InMemoryAuditStore(),
      options: {},
    });
    await context.tenantControl?.authorize(request, { org: 'acme', permission: 'cloud:read' });

    const otherRequest = { headers: request.headers } as IncomingMessage;
    expect(
      await context.deploymentPackages?.get(otherRequest, {
        org: 'acme',
        deploymentId: 'dep_123',
      }),
    ).toBeUndefined();
    expect(
      await context.deploymentPackages?.get(request, {
        org: 'other',
        deploymentId: 'dep_123',
      }),
    ).toBeUndefined();
    expect(registry.getDeployment).not.toHaveBeenCalled();
  });

  it('requires identity, live membership, and an explicitly authorized developer grant', async () => {
    const noIdentity = createModuleRouteContext(request, {
      gate: { authorize: () => ({ ok: true }) },
      controlPlane: await memberStore(),
      registry: fakeRegistry(),
      audit: new InMemoryAuditStore(),
      options: {},
    });
    expect(
      await noIdentity.tenantControl?.authorize(request, {
        org: 'acme',
        permission: 'cloud:read',
      }),
    ).toEqual({ ok: false, status: 401, message: 'identity required' });

    const notMember = createModuleRouteContext(request, {
      gate: gate(),
      controlPlane: new InMemoryControlPlaneStore(),
      registry: fakeRegistry(),
      audit: new InMemoryAuditStore(),
      options: {},
    });
    expect(
      await notMember.tenantControl?.authorize(request, {
        org: 'acme',
        permission: 'cloud:read',
      }),
    ).toEqual({ ok: false, status: 403, message: 'forbidden' });

    const grantBound = createModuleRouteContext(request, {
      gate: gate({ developerGrantId: 'grant_1', oauthClientId: 'client_1' }),
      controlPlane: await memberStore(),
      registry: fakeRegistry(),
      audit: new InMemoryAuditStore(),
      options: {},
    });
    expect(
      await grantBound.tenantControl?.authorize(request, {
        org: 'acme',
        permission: 'deployments:write',
      }),
    ).toEqual({
      ok: false,
      status: 403,
      message: 'developer grant does not authorize this operation',
    });
  });

  it('exposes only the narrow platform identity recovery projection', async () => {
    const registry = {
      ...fakeRegistry(),
      reconcilePlatformAccountReset: vi.fn(),
      customerAuthRestoreProjections: vi
        .fn()
        .mockResolvedValue([
          { deploymentId: 'dep_123', manifest: '{}', serverAuth: { mode: 'oauth' } },
        ]),
    };
    const context = createModuleRouteContext(request, {
      gate: gate(),
      controlPlane: await memberStore(),
      registry,
      audit: new InMemoryAuditStore(),
      options: {},
    });

    const plan = {
      action: 'quarantine' as const,
      apps: [{ org: 'acme', app: 'tasks' }],
      archivedAt: '2026-08-23T00:00:00.000Z',
    };
    await context.platformIdentityRecovery?.reconcile(plan);
    await expect(
      context.platformIdentityRecovery?.customerAuthRestoreProjections(['dep_123']),
    ).resolves.toEqual([
      { deploymentId: 'dep_123', manifest: '{}', serverAuth: { mode: 'oauth' } },
    ]);
    expect(registry.reconcilePlatformAccountReset).toHaveBeenCalledWith(plan);
    expect(registry.customerAuthRestoreProjections).toHaveBeenCalledWith(['dep_123']);
    expect(context.platformIdentityRecovery).not.toHaveProperty('registry');
  });
});

function fakeRegistry() {
  return {
    getDeployment: vi.fn().mockResolvedValue({
      deploymentId: 'dep_123',
      orgSlug: 'acme',
      appSlug: 'tasks',
      environment: 'prod',
      serverVersion: '1',
      active: true,
      serverName: 'acme_tasks',
      createdAt: '2026-08-18T00:00:00.000Z',
      accessMode: 'org-members',
    }),
    getDeploymentPackage: vi.fn().mockResolvedValue({
      deploymentId: 'dep_123',
      appSlug: 'tasks',
      environment: 'prod',
      serverVersion: '1',
      active: true,
      snapshot: {
        snapshotSha256: 'c'.repeat(64),
        artifact: {
          app: { name: 'acme_tasks', title: 'Acme Tasks', version: '1.0.0' },
          provenance: {
            sourceManifestSha256: 'a'.repeat(64),
            mcpSurfaceSha256: 'b'.repeat(64),
          },
        },
        files: [
          {
            target: 'codex',
            path: '.agents/skills/acme-tasks/SKILL.md',
            content: '# Acme Tasks\n',
          },
          {
            target: 'codex',
            path: '.agents/skills/acme-tasks/references/mcp-surface.md',
            content: '# MCP surface\n',
          },
        ],
      },
    }),
  };
}

async function memberStore(): Promise<InMemoryControlPlaneStore> {
  const store = new InMemoryControlPlaneStore();
  await store.createOrg({ slug: 'acme', displayName: 'Acme' });
  await store.addOrgMember({
    org: 'acme',
    subject: 'member_1',
    email: 'member@acme.test',
    role: 'developer',
  });
  return store;
}

function gate(extra: Record<string, unknown> = {}) {
  return {
    authorize: () => ({
      ok: true as const,
      identity: {
        subject: 'member_1',
        email: 'member@acme.test',
        superAdmin: false,
        ...extra,
      },
    }),
  };
}
