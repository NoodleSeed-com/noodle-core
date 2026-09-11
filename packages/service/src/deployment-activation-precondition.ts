import { isDeepStrictEqual } from 'node:util';
import type { DeploymentActivationPrecondition, DeployRecord } from './store.js';

/** Compare inside the lifecycle lock/transaction, before any projection or active-pointer writes. */
export function matchesDeploymentActivation(
  target: DeployRecord,
  precondition: DeploymentActivationPrecondition | undefined,
): boolean {
  if (target.schemaVersion !== (precondition?.expectedSchemaVersion ?? 1)) return false;
  if (precondition === undefined) return true;
  if (target.accessMode !== precondition.expectedAccessMode) return false;
  const expected = precondition.expectedRevision;
  if (expected === undefined) return true;
  // These are all persisted compile inputs plus the authority and lifecycle state used by the target.
  // Active status may legitimately change on repeated activation; it is not an executable input.
  return (
    [
      'manifest',
      'connectors',
      'hostedAssets',
      'serverAuth',
      'serverVersion',
      'ownerSubject',
      'createdBySubject',
      'orgMembershipSources',
      'archivedAt',
    ] as const
  ).every((key) => isDeepStrictEqual(target[key], expected[key]));
}
