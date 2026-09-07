import { type EndpointUrlOptions, tenantMcpUrl } from '@noodle-borg/module';
import type { ServedArtifact } from '@noodle-borg/protocol';
import { deploymentOwnerSubject, missingSecretNames } from './registry-helpers.js';
import type { DeployError } from './registry-types.js';
import type { DeploymentStatus, DeployRecord, TenantRef } from './store.js';

type PersistedBuild =
  | { readonly ok: true; readonly served: ServedArtifact }
  | { readonly ok: false; readonly errors: readonly DeployError[] };

/** Project one compiled deployment into the control-plane status contract. */
export function deploymentStatusFor(
  ref: TenantRef,
  record: DeployRecord,
  built: PersistedBuild,
  baseUrl: string,
  endpointOptions: EndpointUrlOptions,
): DeploymentStatus {
  const missingSecrets = built.ok ? [] : missingSecretNames(built.errors);
  const missingCustomerAuth =
    built.ok &&
    record.accessMode === 'customers' &&
    built.served.artifact.server.auth === undefined;
  const unhealthy = missingCustomerAuth || (!built.ok && missingSecrets.length === 0);
  const ownerSubject = deploymentOwnerSubject(record);
  return {
    target: ref,
    deployment: {
      deploymentId: record.deploymentId,
      endpointUrl: tenantMcpUrl(baseUrl, ref, record.serverVersion, endpointOptions),
      ...(record.serverVersion !== undefined ? { serverVersion: record.serverVersion } : {}),
      active: record.active,
      serverName: record.serverName,
      createdAt: record.createdAt,
      ...(record.createdByEmail !== undefined ? { createdByEmail: record.createdByEmail } : {}),
      ...(ownerSubject !== undefined ? { ownerSubject } : {}),
      accessMode: record.accessMode ?? 'owner-only',
      ...(record.deploymentLock !== undefined
        ? {
            deploymentLock: {
              lockedAt: record.deploymentLock.lockedAt,
              ...(record.deploymentLock.lockedByEmail !== undefined
                ? { lockedByEmail: record.deploymentLock.lockedByEmail }
                : {}),
            },
          }
        : {}),
    },
    health: {
      state:
        built.ok && !missingCustomerAuth ? 'ready' : unhealthy ? 'unhealthy' : 'missing-config',
    },
    config: {
      ok: missingSecrets.length === 0,
      missingSecrets,
    },
  };
}
