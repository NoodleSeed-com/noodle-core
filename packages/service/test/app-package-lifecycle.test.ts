import { renderProductSkillBundle } from '@noodle-borg/agent-kit';
import { describe, expect, it } from 'vitest';
import { InMemoryArtifactStore, ServerRegistry } from '../src/index.js';

const TENANT = { org: 'acme', app: 'lifecycle', env: 'prod' } as const;
const OPTIONS = {
  accessMode: 'owner-only' as const,
  actor: { subject: 'owner-subject', email: 'owner@acme.test', superAdmin: false },
};

function guidedManifest(label: string): string {
  return `
manifestVersion: '2'
server:
  name: package_lifecycle
  title: Package Lifecycle
  version: 1.0.0
  agentGuide:
    description: Use Package Lifecycle to review ${label} records.
    useWhen: [A user asks to review ${label} records.]
    workflows:
      - id: review_records
        title: Review ${label} records
        steps: [{ capability: { kind: tool, name: review_records } }]
    boundaries: [Keep ${label} record identifiers exact.]
    examples: [{ prompt: Review ${label} records., workflow: review_records }]
tools:
  - name: review_records
    description: Review ${label} records.
    inputSchema: { type: object, properties: {}, additionalProperties: false }
    fulfilment: { steps: [], output: { release: '${label}' } }
`;
}

describe('deployment App Package lifecycle identity', () => {
  it('keeps historical bytes exact through restart, version activation, rollback, archive, and restore', async () => {
    const store = new InMemoryArtifactStore();
    const initial = new ServerRegistry(store, undefined, undefined, {
      renderAppPackage: renderProductSkillBundle,
    });
    const v1a = await initial.deploy(TENANT, guidedManifest('v1-a'), {
      ...OPTIONS,
      serverVersion: '1',
    });
    const v1b = await initial.deploy(TENANT, guidedManifest('v1-b'), {
      ...OPTIONS,
      serverVersion: '1',
    });
    const v2 = await initial.deploy(TENANT, guidedManifest('v2'), {
      ...OPTIONS,
      serverVersion: '2',
    });
    expect(v1a.ok && v1b.ok && v2.ok).toBe(true);
    if (!v1a.ok || !v1b.ok || !v2.ok) return;

    const packageV1a = await initial.getDeploymentPackage(TENANT.org, v1a.deploymentId);
    const packageV1b = await initial.getDeploymentPackage(TENANT.org, v1b.deploymentId);
    const packageV2 = await initial.getDeploymentPackage(TENANT.org, v2.deploymentId);
    expect(packageV1a?.snapshot.snapshotSha256).not.toBe(packageV1b?.snapshot.snapshotSha256);
    expect(packageV1b?.snapshot.snapshotSha256).not.toBe(packageV2?.snapshot.snapshotSha256);
    expect(await initial.getDeploymentPackage('other', v1a.deploymentId)).toBeUndefined();

    const restarted = new ServerRegistry(store, undefined, undefined, {
      renderAppPackage: () => {
        throw new Error('historical package renderer must never run');
      },
    });
    expect(await restarted.recover()).toEqual({ recovered: 3, failed: [] });
    expect((await restarted.getDeploymentPackage(TENANT.org, v1a.deploymentId))?.snapshot).toEqual(
      packageV1a?.snapshot,
    );
    expect((await restarted.getDeploymentPackage(TENANT.org, v1b.deploymentId))?.snapshot).toEqual(
      packageV1b?.snapshot,
    );
    expect((await restarted.getDeploymentPackage(TENANT.org, v2.deploymentId))?.snapshot).toEqual(
      packageV2?.snapshot,
    );

    const rollback = await restarted.rollback(TENANT, v1a.deploymentId);
    expect(rollback).toMatchObject({
      ok: true,
      deploymentId: v1a.deploymentId,
      previousDeploymentId: v1b.deploymentId,
      alreadyActive: false,
    });
    expect((await restarted.getDeploymentPackage(TENANT.org, v1a.deploymentId))?.active).toBe(true);
    expect((await restarted.getDeploymentPackage(TENANT.org, v1b.deploymentId))?.active).toBe(
      false,
    );
    expect((await restarted.getDeploymentPackage(TENANT.org, v2.deploymentId))?.active).toBe(true);
    expect((await restarted.getDeploymentPackage(TENANT.org, v1a.deploymentId))?.snapshot).toEqual(
      packageV1a?.snapshot,
    );
    expect((await restarted.getDeploymentPackage(TENANT.org, v2.deploymentId))?.snapshot).toEqual(
      packageV2?.snapshot,
    );
    expect(
      (await restarted.getActiveByTenantVersion(TENANT, '1'))?.served.artifact.server.name,
    ).toBe('package_lifecycle');
    expect(
      (await restarted.getActiveByTenantVersion(TENANT, '2'))?.served.artifact.server.name,
    ).toBe('package_lifecycle');
    expect(await restarted.rollback(TENANT, v1a.deploymentId)).toMatchObject({
      ok: true,
      deploymentId: v1a.deploymentId,
      alreadyActive: true,
    });

    const archivedAt = '2026-08-09T00:00:00.000Z';
    await restarted.archiveApp(TENANT.org, TENANT.app, archivedAt);
    expect(await restarted.getDeploymentPackage(TENANT.org, v1a.deploymentId)).toMatchObject({
      archivedAt,
      snapshot: packageV1a?.snapshot,
    });
    await restarted.restoreApp(TENANT.org, TENANT.app);
    expect(
      (await restarted.getDeploymentPackage(TENANT.org, v1a.deploymentId))?.archivedAt,
    ).toBeUndefined();
    expect((await restarted.getDeploymentPackage(TENANT.org, v1a.deploymentId))?.snapshot).toEqual(
      packageV1a?.snapshot,
    );
  });
});
