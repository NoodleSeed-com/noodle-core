import { usesCustomerAuthentication } from '@noodle-borg/module';
import type { DeploymentAuthentication } from '@noodle-borg/wire-contracts';
import { deploymentRecordVersionError } from './deployment-record-version.js';
import type { DeployRecord, TenantAuthConfig } from './store.js';

/** Read the effective authentication authority only when this runtime understands the record. */
export function deploymentAuthenticationFor(
  record: Pick<DeployRecord, 'schemaVersion' | 'accessMode' | 'serverAuth'>,
  compiledAuth?: TenantAuthConfig,
): DeploymentAuthentication | undefined {
  if (deploymentRecordVersionError(record) !== undefined || record.accessMode === undefined) {
    return undefined;
  }
  if (record.accessMode === 'public') return 'none';
  if (
    usesCustomerAuthentication({
      schemaVersion: record.schemaVersion,
      accessMode: record.accessMode,
      hasServerAuth: record.serverAuth !== undefined || compiledAuth !== undefined,
    })
  ) {
    return 'customer';
  }
  return 'platform';
}
