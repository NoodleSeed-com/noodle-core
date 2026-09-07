import { isDeepStrictEqual } from 'node:util';
import { sameDeploymentScope } from './deployment-versioning.js';
import type { DeployPreflightResult, RunDeployResult } from './registry-types.js';
import type { DeployRecord } from './store.js';

/** Stable store error used by every deployment and activation path. */
export class DeploymentLockedError extends Error {
  readonly code = 'deployment_locked' as const;
  readonly databaseReason: string | undefined;

  constructor(databaseReason?: string) {
    super('this server version is locked; unlock it before deploying or rolling back');
    this.name = 'DeploymentLockedError';
    this.databaseReason = databaseReason;
  }
}

export function deploymentLockedConflict(): RunDeployResult {
  const error = new DeploymentLockedError();
  return { ok: false, conflict: true, code: error.code, message: error.message };
}

export function deploymentLockedPreflight(): DeployPreflightResult {
  return {
    ok: false,
    errors: [
      {
        code: 'deployment_locked',
        path: 'serverVersion',
        message: 'this server version is locked; unlock it before deploying',
      },
    ],
  };
}

export function assertDeploymentAppendUnlocked(
  records: readonly DeployRecord[],
  candidate: DeployRecord,
): boolean {
  const existing = records.find((record) => record.deploymentId === candidate.deploymentId);
  if (existing?.deploymentLock !== undefined) {
    if (isDeepStrictEqual(withoutDeploymentLock(existing), withoutDeploymentLock(candidate))) {
      return false;
    }
    throw new DeploymentLockedError();
  }
  const locked = lockedActiveInScope(records, candidate);
  if (locked !== undefined) throw new DeploymentLockedError();
  return true;
}

function withoutDeploymentLock(record: DeployRecord): Omit<DeployRecord, 'deploymentLock'> {
  const { deploymentLock: _deploymentLock, ...unlocked } = record;
  return unlocked;
}

export function assertDeploymentActivationUnlocked(
  records: readonly DeployRecord[],
  target: DeployRecord,
): void {
  const locked = lockedActiveInScope(records, target);
  if (locked !== undefined && locked.deploymentId !== target.deploymentId) {
    throw new DeploymentLockedError();
  }
}

function lockedActiveInScope(
  records: readonly DeployRecord[],
  candidate: DeployRecord,
): DeployRecord | undefined {
  if (candidate.serverVersion === undefined) return undefined;
  return records.find(
    (record) =>
      record.active &&
      record.deploymentLock !== undefined &&
      sameDeploymentScope(record, candidate),
  );
}
