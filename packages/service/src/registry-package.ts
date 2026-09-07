import type { AppPackageArtifactV1 } from '@noodle-borg/app-package';
import {
  type AppPackageRenderer,
  AppPackageSnapshotError,
  type AppPackageSnapshotV1,
  createAppPackageSnapshot,
  parseAppPackageSnapshot,
} from './app-package-snapshot.js';
import type { RegistryStateView } from './registry-state.js';
import type { DeployError } from './registry-types.js';
import { validateSlug } from './store.js';

export interface DeploymentPackage {
  readonly deploymentId: string;
  readonly appSlug: string;
  readonly environment: string;
  readonly serverVersion?: string;
  readonly active: boolean;
  readonly archivedAt?: string;
  readonly snapshot: AppPackageSnapshotV1;
}

export function renderDeploymentPackageSnapshot(
  artifact: AppPackageArtifactV1,
  renderer: AppPackageRenderer | undefined,
):
  | { readonly ok: true; readonly snapshot: AppPackageSnapshotV1 }
  | { readonly ok: false; readonly errors: readonly DeployError[] } {
  try {
    return { ok: true, snapshot: createAppPackageSnapshot(artifact, renderer) };
  } catch (error) {
    if (error instanceof AppPackageSnapshotError) {
      return { ok: false, errors: [error.deployError] };
    }
    throw error;
  }
}

/** Store-first historical package read; never recompiles or rerenders deployment bytes. */
export async function registryDeploymentPackage(
  state: RegistryStateView,
  org: string,
  deploymentId: string,
): Promise<DeploymentPackage | undefined> {
  const safeOrg = validateSlug('org', org);
  const record = state.store
    ? await state.store.get(deploymentId)
    : state.records.get(deploymentId);
  if (record === undefined || record.orgSlug !== safeOrg) return undefined;
  const snapshot = parseAppPackageSnapshot(record.appPackageSnapshot);
  if (snapshot === undefined) return undefined;
  return {
    deploymentId: record.deploymentId,
    appSlug: record.appSlug,
    environment: record.environment,
    ...(record.serverVersion !== undefined ? { serverVersion: record.serverVersion } : {}),
    active: record.active,
    ...(record.archivedAt !== undefined ? { archivedAt: record.archivedAt } : {}),
    snapshot,
  };
}
