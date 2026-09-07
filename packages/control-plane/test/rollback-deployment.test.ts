import { DeploymentActivationError } from '@noodle-borg/module';
import { describe, expect, it, vi } from 'vitest';
import {
  type RollbackOperationDependencies,
  rollbackDeploymentOperation,
} from '../src/portable.js';

const owner = {
  orgSlug: 'acme',
  subject: 'owner-subject',
  email: 'owner@acme.example',
  role: 'owner' as const,
  createdAt: '2026-07-17T00:00:00.000Z',
};

const activated = {
  ok: true as const,
  deploymentId: 'dep-previous',
  previousDeploymentId: 'dep-current',
  alreadyActive: false,
  accessMode: 'org-members' as const,
  ownerSubject: 'oauth-historical-owner',
  previousAccessMode: 'owner-only' as const,
  serverName: 'Demo',
  createdAt: '2026-07-17T00:00:00.000Z',
};

function dependencies(
  overrides: Partial<RollbackOperationDependencies> = {},
): RollbackOperationDependencies {
  return {
    registry: {
      getAppArchivedAt: vi.fn(async () => undefined),
      rollback: vi.fn(async () => activated),
    },
    controlPlane: {
      getOrgMember: vi.fn(async () => owner),
    },
    audit: { emit: vi.fn(async () => undefined) },
    ...overrides,
  };
}

function run(
  deps: RollbackOperationDependencies,
  overrides: Partial<Parameters<typeof rollbackDeploymentOperation>[1]> = {},
) {
  return rollbackDeploymentOperation(deps, {
    actor: { subject: owner.subject, email: owner.email, superAdmin: false },
    target: { org: 'acme', app: 'demo', env: 'dev' },
    deploymentId: 'dep-previous',
    reason: 'Restore known-good release',
    publicBaseUrl: 'https://cloud.example',
    ...overrides,
  });
}

describe('rollbackDeploymentOperation', () => {
  it('denies a non-owner before registry access and audits the decision', async () => {
    const rollback = vi.fn();
    const audit = { emit: vi.fn(async () => undefined) };
    const deps = dependencies({
      registry: { getAppArchivedAt: vi.fn(), rollback },
      controlPlane: {
        getOrgMember: vi.fn(async () => ({ ...owner, role: 'member' as const })),
      },
      audit,
    });

    await expect(run(deps)).resolves.toEqual({
      ok: false,
      status: 403,
      code: 'forbidden',
      message: 'organization owner access is required',
    });
    expect(rollback).not.toHaveBeenCalled();
    expect(audit.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'rollback.rejected',
        decision: 'deny',
        status: 403,
        reasonCode: 'forbidden',
      }),
    );
  });

  it('rejects an archived app before activation and audits the decision', async () => {
    const rollback = vi.fn();
    const audit = { emit: vi.fn(async () => undefined) };
    const deps = dependencies({
      registry: {
        getAppArchivedAt: vi.fn(async () => '2026-07-16T00:00:00.000Z'),
        rollback,
      },
      audit,
    });

    await expect(run(deps)).resolves.toMatchObject({
      ok: false,
      status: 409,
      code: 'app_archived',
    });
    expect(rollback).not.toHaveBeenCalled();
    expect(audit.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'rollback.rejected',
        reasonCode: 'app_archived',
        details: { archivedAt: '2026-07-16T00:00:00.000Z' },
      }),
    );
  });

  it.each([
    [404, 'deployment_not_found', 'deployment not found for target environment'],
    [409, 'deployment_incompatible', 'deployment cannot be activated: capability_missing'],
  ] as const)('maps registry status %s to a stable denial code', async (status, code, error) => {
    const audit = { emit: vi.fn(async () => undefined) };
    const deps = dependencies({
      registry: {
        getAppArchivedAt: vi.fn(async () => undefined),
        rollback: vi.fn(async () => ({ ok: false as const, status, error })),
      },
      audit,
    });

    await expect(run(deps)).resolves.toEqual({
      ok: false,
      status,
      code,
      message: error,
    });
    expect(audit.emit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'rollback.rejected', status, reasonCode: code }),
    );
  });

  it('uses an explicit MCP subdomain for a public rollback endpoint', async () => {
    const deps = dependencies();
    await expect(
      run(deps, {
        endpointOptions: {
          publicBaseDomain: 'mcp.example',
          mcpSubdomain: 'arez',
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      view: {
        rollback: { endpointUrl: 'https://arez.mcp.example/demo/env/dev/mcp' },
      },
    });
  });

  it('preserves the deployment-locked denial code', async () => {
    const audit = { emit: vi.fn(async () => undefined) };
    const deps = dependencies({
      registry: {
        getAppArchivedAt: vi.fn(async () => undefined),
        rollback: vi.fn(async () => ({
          ok: false as const,
          status: 409 as const,
          code: 'deployment_locked' as const,
          error: 'this server version is locked',
        })),
      },
      audit,
    });

    await expect(run(deps)).resolves.toEqual({
      ok: false,
      status: 409,
      code: 'deployment_locked',
      message: 'this server version is locked',
    });
    expect(audit.emit).toHaveBeenCalledWith(
      expect.objectContaining({ reasonCode: 'deployment_locked' }),
    );
  });

  it.each([
    ['production_app_limit_exceeded', 409, 'production_app_limit_exceeded'],
    ['billing_enforcement_unavailable', 503, 'billing_enforcement_unavailable'],
  ] as const)('maps production admission %s without disclosing account detail', async (admissionCode, status, code) => {
    const audit = { emit: vi.fn(async () => undefined) };
    const deps = dependencies({
      registry: {
        getAppArchivedAt: vi.fn(async () => undefined),
        rollback: vi.fn(async () => {
          throw new DeploymentActivationError(admissionCode);
        }),
      },
      audit,
    });

    await expect(run(deps)).resolves.toMatchObject({ ok: false, status, code });
    expect(audit.emit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'rollback.rejected', status, reasonCode: code }),
    );
  });

  it.each([
    false,
    true,
  ])('returns one endpoint view and audits activation (alreadyActive=%s)', async (alreadyActive) => {
    const audit = { emit: vi.fn(async () => undefined) };
    const rollback = vi.fn(async () => ({ ...activated, alreadyActive }));
    const deps = dependencies({
      registry: { getAppArchivedAt: vi.fn(async () => undefined), rollback },
      audit,
    });

    await expect(run(deps)).resolves.toEqual({
      ok: true,
      view: {
        target: { org: 'acme', app: 'demo', env: 'dev' },
        rollback: {
          deploymentId: 'dep-previous',
          previousDeploymentId: 'dep-current',
          alreadyActive,
          endpointUrl: 'https://cloud.example/o/acme/demo/dev/mcp',
          accessMode: 'org-members',
          ownerSubject: 'oauth-historical-owner',
          previousAccessMode: 'owner-only',
          serverName: 'Demo',
          createdAt: '2026-07-17T00:00:00.000Z',
        },
      },
    });
    expect(rollback).toHaveBeenCalledWith({ org: 'acme', app: 'demo', env: 'dev' }, 'dep-previous');
    expect(audit.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'deploy.rollback',
        decision: 'allow',
        deploymentId: 'dep-previous',
        details: expect.objectContaining({
          previousDeploymentId: 'dep-current',
          alreadyActive,
          ownerSubject: 'oauth-historical-owner',
          reason: 'Restore known-good release',
        }),
      }),
    );
    expect(audit.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorSubject: owner.subject,
        details: expect.objectContaining({ ownerSubject: 'oauth-historical-owner' }),
      }),
    );
  });

  it('returns the completed rollback when the post-mutation audit sink fails', async () => {
    const auditFailure = new Error('audit unavailable');
    const deps = dependencies({
      audit: { emit: vi.fn(async () => Promise.reject(auditFailure)) },
    });

    await expect(run(deps)).resolves.toMatchObject({
      ok: true,
      view: { rollback: { deploymentId: 'dep-previous', alreadyActive: false } },
    });
    expect(deps.registry.rollback).toHaveBeenCalledOnce();
  });
});
