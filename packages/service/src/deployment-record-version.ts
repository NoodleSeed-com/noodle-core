import { sameDeploymentScope } from './deployment-versioning.js';
import type { DeployError } from './registry-types.js';
import type { DeploymentPolicyPrecondition, DeployRecord } from './store.js';

const VERSION_ERROR = {
  code: 'unsupported_deployment_record_version',
  path: 'schemaVersion',
  message: 'Deployment record version is not supported by this runtime.',
} as const;

export class UnsupportedDeploymentRecordVersionError extends Error {
  readonly code = VERSION_ERROR.code;

  constructor() {
    super(VERSION_ERROR.message);
    this.name = 'UnsupportedDeploymentRecordVersionError';
  }
}

/** R1 serves the two understood policy versions; future policy remains unavailable. */
export function deploymentRecordVersionError(
  record: Pick<DeployRecord, 'schemaVersion'>,
): DeployError | undefined {
  return record.schemaVersion === 1 || record.schemaVersion === 2 ? undefined : VERSION_ERROR;
}

/** A stale writer cannot replace or deactivate a newer policy, even after registry preflight. */
export function assertDeploymentAppendVersion(
  records: readonly DeployRecord[],
  candidate: DeployRecord,
): void {
  if (
    records.some(
      (record) =>
        record.schemaVersion > candidate.schemaVersion &&
        (record.deploymentId === candidate.deploymentId ||
          (candidate.active &&
            record.active &&
            record.archivedAt === undefined &&
            sameDeploymentScope(record, candidate))),
    )
  )
    throw new UnsupportedDeploymentRecordVersionError();
}

export function unsupportedDeploymentRecordFailure(): {
  readonly ok: false;
  readonly errors: readonly DeployError[];
} {
  return { ok: false, errors: [VERSION_ERROR] };
}

/** Reject a deployment compiled against an operator policy that has since changed. */
export class DeploymentPolicyChangedError extends Error {
  readonly code = 'deployment_policy_changed';
  constructor() {
    super('The active deployment policy changed. Retry the deployment.');
  }
}
export function assertDeploymentAppendPolicy(
  records: readonly DeployRecord[],
  candidate: DeployRecord,
  precondition?: DeploymentPolicyPrecondition,
): void {
  if (precondition === undefined) return;
  const current = records.find(
    (record) =>
      record.active && record.archivedAt === undefined && sameDeploymentScope(record, candidate),
  );
  const expected = precondition.active;
  if (
    expected === null
      ? current !== undefined
      : current === undefined ||
        current.deploymentId !== expected.deploymentId ||
        current.schemaVersion !== expected.schemaVersion ||
        current.accessMode !== expected.accessMode ||
        current.ownerSubject !== expected.ownerSubject ||
        current.manifest !== expected.manifest ||
        JSON.stringify(current.serverAuth) !== JSON.stringify(expected.serverAuth)
  ) {
    throw new DeploymentPolicyChangedError();
  }
}
