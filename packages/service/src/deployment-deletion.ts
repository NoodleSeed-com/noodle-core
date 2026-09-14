import { normalizeServerVersion } from '@noodle-borg/module';
import { sameTenantRecord } from './deployment-versioning.js';
import { validateTenantRef } from './store/validate.js';
import type {
  DeploymentDeleteResult,
  DeploymentDeleteSelection,
  DeployRecord,
  TenantRef,
} from './store.js';

/** Shared, side-effect-free decision made inside each adapter's mutation boundary. */
export function planDeploymentDeletion(
  records: readonly DeployRecord[],
  ref: TenantRef,
  selection: DeploymentDeleteSelection,
): DeploymentDeleteResult {
  const safe = validateTenantRef(ref);
  const version =
    selection.kind === 'version' && selection.serverVersion !== undefined
      ? normalizeServerVersion(selection.serverVersion)
      : undefined;
  const deleted = records.filter(
    (record) =>
      sameTenantRecord(record, safe) &&
      (selection.kind === 'deployment'
        ? record.deploymentId === selection.deploymentId
        : record.serverVersion === version),
  );
  if (deleted.length === 0)
    return {
      ok: false,
      code: selection.kind === 'deployment' ? 'deployment_not_found' : 'version_not_found',
    };
  if (
    records.some(
      (record) =>
        record.orgSlug === safe.org &&
        record.appSlug === safe.app &&
        record.archivedAt !== undefined,
    )
  ) {
    return { ok: false, code: 'app_archived' };
  }
  if (selection.kind === 'deployment') {
    if (deleted.some((record) => record.active)) return { ok: false, code: 'active_deployment' };
  } else {
    if (deleted.some((record) => record.active && record.deploymentLock !== undefined))
      return { ok: false, code: 'deployment_locked' };
    const expected = new Set(selection.expectedDeploymentIds);
    if (
      expected.size !== selection.expectedDeploymentIds.length ||
      expected.size !== deleted.length ||
      deleted.some((record) => !expected.has(record.deploymentId))
    ) {
      return { ok: false, code: 'deployment_delete_conflict' };
    }
  }
  return { ok: true, deleted };
}
