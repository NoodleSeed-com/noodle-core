import {
  type ProductSkillPackageInput,
  ProductSkillRenderError,
  type RenderedProductSkillBundleV1,
  renderProductSkillBundle,
  validateRenderedProductSkillFiles,
} from '@noodle-borg/agent-kit';
import {
  type AppPackageArtifactV1,
  type AppPackageSnapshotV1,
  createAppPackageSnapshotV1,
  parseAppPackageSnapshotV1,
} from '@noodle-borg/app-package';
import type { DeployError } from './registry-types.js';
import type { DeployRecord } from './store.js';

export type { AppPackageSnapshotV1 };

export type AppPackageRenderer = (input: ProductSkillPackageInput) => RenderedProductSkillBundleV1;

export class AppPackageSnapshotError extends Error {
  constructor(readonly deployError: DeployError) {
    super(deployError.message);
    this.name = 'AppPackageSnapshotError';
  }
}

/** Render and verify the exact deployment-bound package bytes before persistence. */
export function createAppPackageSnapshot(
  artifact: AppPackageArtifactV1,
  render: AppPackageRenderer = renderProductSkillBundle,
): AppPackageSnapshotV1 {
  try {
    return createAppPackageSnapshotV1(artifact, render, validateRenderedProductSkillFiles);
  } catch (error) {
    const code = error instanceof ProductSkillRenderError ? error.code : 'app_package_invalid';
    throw new AppPackageSnapshotError({
      code,
      path: 'server.agentGuide',
      message: `app package rendering failed: ${code}`,
    });
  }
}

/** Parse only a complete snapshot that also satisfies Agent Kit's canonical host-file contract. */
export function parseAppPackageSnapshot(value: unknown): AppPackageSnapshotV1 | undefined {
  return parseAppPackageSnapshotV1(value, validateRenderedProductSkillFiles);
}

/** Drop an unsafe optional sibling without making the runtime manifest unavailable. */
export function sanitizeDeployRecordAppPackageSnapshot(record: DeployRecord): DeployRecord {
  if (record.appPackageSnapshot === undefined) return record;
  const snapshot = parseAppPackageSnapshot(record.appPackageSnapshot);
  const { appPackageSnapshot: _unsafe, ...safeRecord } = record;
  return snapshot === undefined ? safeRecord : { ...safeRecord, appPackageSnapshot: snapshot };
}

/** Same-id replay may update mutable metadata, but it can never replace historical package bytes. */
export function assertSameAppPackageSnapshot(existing: DeployRecord, incoming: DeployRecord): void {
  const previous = parseAppPackageSnapshot(existing.appPackageSnapshot);
  const next = parseAppPackageSnapshot(incoming.appPackageSnapshot);
  if (
    (previous === undefined) !== (next === undefined) ||
    previous?.snapshotSha256 !== next?.snapshotSha256
  ) {
    throw new Error(`app package snapshot conflict for deployment ${incoming.deploymentId}`);
  }
}
