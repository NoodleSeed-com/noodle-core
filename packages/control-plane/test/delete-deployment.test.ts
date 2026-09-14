import { describe, expect, it, vi } from 'vitest';
import {
  type DeploymentDeletionDependencies,
  deleteDeploymentOperation,
} from '../src/delete-deployment.js';

const target = { org: 'acme', app: 'support', env: 'prod' };
const actor = { subject: 'owner', email: 'owner@example.test', superAdmin: false };
function dependencies(): DeploymentDeletionDependencies {
  return {
    controlPlane: {
      getOrgMember: vi.fn(async ({ org }) => (org === 'acme' ? { role: 'owner' } : undefined)),
    },
    registry: {
      getDeployment: vi.fn(async () => ({
        orgSlug: 'acme',
        appSlug: 'support',
        environment: 'prod',
      })),
      deleteDeployments: vi.fn(async () => ({
        ok: true as const,
        deleted: [{ deploymentId: 'support-old' }],
      })),
    },
    audit: { emit: vi.fn(async () => undefined) },
  };
}
describe('portable deployment deletion authority', () => {
  it('checks the actual version target organization even if a host supplies a different scope org', async () => {
    const deps = dependencies();
    const result = await deleteDeploymentOperation(deps, {
      actor,
      scope: {
        kind: 'version',
        org: 'acme',
        target: { ...target, org: 'foreign' },
        serverVersion: '1',
      },
      expectedDeploymentIds: ['support-old'],
    });
    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(deps.registry.deleteDeployments).not.toHaveBeenCalled();
  });
  it('does not let a host turn a restricted developer grant into super-admin deletion', async () => {
    const deps = dependencies();
    expect(
      await deleteDeploymentOperation(deps, {
        actor: { ...actor, superAdmin: true, developerGrantId: 'restricted' },
        scope: { kind: 'deployment', org: 'acme', deploymentId: 'support-old' },
      }),
    ).toMatchObject({ ok: false, status: 403 });
    expect(deps.registry.getDeployment).not.toHaveBeenCalled();
  });
  it('retains the exact confirmed inventory and reports committed success if audit fails', async () => {
    const deps = dependencies();
    vi.mocked(deps.audit.emit).mockRejectedValue(new Error('audit unavailable'));
    const result = await deleteDeploymentOperation(deps, {
      actor,
      scope: { kind: 'version', org: 'acme', target, serverVersion: '1.0.0' },
      expectedDeploymentIds: ['support-old'],
    });
    expect(deps.registry.deleteDeployments).toHaveBeenCalledWith(target, {
      kind: 'version',
      serverVersion: '1.0.0',
      expectedDeploymentIds: ['support-old'],
    });
    expect(result).toEqual({
      ok: true,
      view: { ok: true, target, deletedDeploymentIds: ['support-old'], auditRecorded: false },
    });
  });
});
