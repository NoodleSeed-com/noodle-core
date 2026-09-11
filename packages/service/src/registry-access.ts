import type { OwnerTokenVerifier, ServedTarget } from '@noodle-borg/transport-http';
import {
  assertUniqueActiveCustomerAuthAudienceBindings,
  CustomerAuthAudienceConflictError,
  hasExactCustomerAuthProjection,
} from './customer-auth-audience-binding.js';
import { deploymentRecordVersionError } from './deployment-record-version.js';
import { deploymentOwnerSubject } from './registry-helpers.js';
import { activeRecord, activeRecordVersion, type RegistryStateView } from './registry-state.js';
import { tenantDeploymentKey, tryServedTargetFor } from './registry-targets.js';
import type { AccessUpdateOptions, AccessUpdateResult } from './registry-types.js';
import { resolveActiveAccessUpdate } from './store/records.js';
import type {
  ActiveAccessUpdateInput,
  DeployRecord,
  TenantAuthConfig,
  TenantRef,
} from './store.js';

export type CustomerVerifierFactory = (auth: TenantAuthConfig) => OwnerTokenVerifier;

type CustomerAuthConflictGuard = (
  record: DeployRecord,
  auth: TenantAuthConfig | undefined,
) => Promise<boolean>;

/** Registry-facing access transition with customer audience ownership preflight and atomic translation. */
export async function updateRegistryAccess(
  state: RegistryStateView,
  tenant: TenantRef,
  options: AccessUpdateOptions,
  loadServed: (deploymentId: string) => Promise<ServedTarget | undefined>,
  customerVerifierFactory: CustomerVerifierFactory | undefined,
  hasCustomerAuthConflict: CustomerAuthConflictGuard,
): Promise<AccessUpdateResult> {
  if (options.accessMode === 'customers' || options.accessMode === 'mixed') {
    const record =
      options.serverVersion === undefined
        ? await activeRecord(state, tenant)
        : await activeRecordVersion(state, tenant, options.serverVersion);
    const served = record === undefined ? undefined : await loadServed(record.deploymentId);
    const auth = served?.served.artifact.server.auth;
    if (
      record !== undefined &&
      auth !== undefined &&
      (await hasCustomerAuthConflict(
        {
          ...record,
          accessMode: options.accessMode,
          ...(options.accessMode === 'mixed' ? { schemaVersion: 2 } : {}),
        },
        auth,
      ))
    ) {
      return customerAuthAudienceConflict();
    }
  }
  try {
    return await updateActiveAccess(state, tenant, options, loadServed, customerVerifierFactory);
  } catch (error) {
    if (error instanceof CustomerAuthAudienceConflictError) {
      return customerAuthAudienceConflict();
    }
    throw error;
  }
}

/** Whether a manifest has an expression rooted at the caller's identity object. */
export function manifestUsesUserRoot(manifest: unknown): boolean {
  return /\$\{\s*user(?:[.[]|\s*\})/.test(JSON.stringify(manifest));
}

/**
 * Atomically validate and persist an access-mode transition for one active deployment. The observed raw
 * access mode supplies the optimistic guard; in-memory state is reconciled only after the store accepts
 * the compare-and-set.
 */
export async function updateActiveAccess(
  state: RegistryStateView,
  tenant: TenantRef,
  options: AccessUpdateOptions,
  loadServed: (deploymentId: string) => Promise<ServedTarget | undefined>,
  customerVerifierFactory?: CustomerVerifierFactory,
): Promise<AccessUpdateResult> {
  const record =
    options.serverVersion === undefined
      ? await activeRecord(state, tenant)
      : await activeRecordVersion(state, tenant, options.serverVersion);
  if (record === undefined) return noActiveDeployment();
  const versionError = deploymentRecordVersionError(record);
  if (versionError !== undefined) {
    return {
      ok: false,
      status: 409,
      code: 'unsupported_deployment_record_version',
      message: versionError.message,
    };
  }

  const nextAccessMode = options.accessMode;
  const previousAccessMode = record.accessMode ?? 'owner-only';
  const previousOwnerSubject = deploymentOwnerSubject(record);
  const nextOwnerSubject = options.ownerSubject ?? previousOwnerSubject;
  const accessChanged = previousAccessMode !== nextAccessMode;
  const ownerChanged = previousOwnerSubject !== nextOwnerSubject;
  const served =
    accessChanged || ownerChanged || nextAccessMode === 'customers' || nextAccessMode === 'mixed'
      ? await loadServed(record.deploymentId)
      : undefined;
  const serverAuth = served?.served.artifact.server.auth;
  const schemaVersion =
    record.schemaVersion === 2 || (nextAccessMode === 'mixed' && serverAuth !== undefined) ? 2 : 1;
  const policyChanged = schemaVersion !== record.schemaVersion;
  if (
    (nextAccessMode === 'customers' && serverAuth === undefined) ||
    !hasExactCustomerAuthProjection(
      {
        ...record,
        schemaVersion,
        accessMode: nextAccessMode,
        ...(record.serverAuth === undefined && serverAuth !== undefined ? { serverAuth } : {}),
      },
      serverAuth,
    )
  ) {
    return {
      ok: false,
      status: 409,
      code: 'server_auth_required',
      message: 'Customer access requires server authentication.',
    };
  }
  if (!accessChanged && !ownerChanged && !policyChanged) {
    const committed =
      state.store === undefined
        ? commitInMemoryAccessUpdate(state, tenant, record, {
            accessMode: nextAccessMode,
            expectedAccessMode: record.accessMode,
            ...(schemaVersion === 2 ? { schemaVersion: 2 as const } : {}),
            expectedSchemaVersion: record.schemaVersion,
            expectedManifest: record.manifest,
            expectedOwnerSubject: previousOwnerSubject,
            ...(serverAuth !== undefined ? { serverAuth } : {}),
          })
        : await state.store.updateActiveAccess(tenant, record.deploymentId, {
            accessMode: nextAccessMode,
            expectedAccessMode: record.accessMode,
            ...(schemaVersion === 2 ? { schemaVersion: 2 as const } : {}),
            expectedSchemaVersion: record.schemaVersion,
            expectedManifest: record.manifest,
            expectedOwnerSubject: previousOwnerSubject,
            ...(serverAuth !== undefined ? { serverAuth } : {}),
          });
    if (committed === undefined) return accessUpdateConflict();
    reconcileCommittedAccess(state, tenant, committed);
    return {
      ok: true,
      changed: false,
      accessChanged: false,
      policyChanged: false,
      ownerChanged: false,
      previousAccessMode,
      ...(previousOwnerSubject !== undefined ? { previousOwnerSubject } : {}),
      record: committed,
    };
  }

  if (nextAccessMode === 'public' && manifestUsesUserRoot(record.manifest)) {
    return {
      ok: false,
      status: 409,
      code: 'public_user_context_conflict',
      message: 'Public access cannot reference the user context.',
    };
  }
  if (nextAccessMode === 'owner-only' && nextOwnerSubject === undefined) {
    return {
      ok: false,
      status: 409,
      code: 'owner_identity_required',
      message: 'Owner-only access requires a recorded deployer identity.',
    };
  }
  if (served === undefined) return accessUpdateConflict();

  const updated = {
    ...record,
    accessMode: nextAccessMode,
    schemaVersion,
    ...(ownerChanged && nextOwnerSubject !== undefined ? { ownerSubject: nextOwnerSubject } : {}),
    ...(serverAuth !== undefined ? { serverAuth } : {}),
  };
  const target = tryServedTargetFor(updated, served.served, customerVerifierFactory);
  if (target === undefined) return accessUpdateConflict();
  const committed =
    state.store === undefined
      ? commitInMemoryAccessUpdate(state, tenant, record, {
          accessMode: nextAccessMode,
          ...(ownerChanged && nextOwnerSubject !== undefined
            ? { ownerSubject: nextOwnerSubject }
            : {}),
          expectedAccessMode: record.accessMode,
          ...(schemaVersion === 2 ? { schemaVersion: 2 as const } : {}),
          expectedSchemaVersion: record.schemaVersion,
          expectedManifest: record.manifest,
          expectedOwnerSubject: previousOwnerSubject,
          ...(serverAuth !== undefined ? { serverAuth } : {}),
        })
      : await state.store.updateActiveAccess(tenant, record.deploymentId, {
          accessMode: nextAccessMode,
          ...(ownerChanged && nextOwnerSubject !== undefined
            ? { ownerSubject: nextOwnerSubject }
            : {}),
          expectedAccessMode: record.accessMode,
          ...(schemaVersion === 2 ? { schemaVersion: 2 as const } : {}),
          expectedSchemaVersion: record.schemaVersion,
          expectedManifest: record.manifest,
          expectedOwnerSubject: previousOwnerSubject,
          ...(serverAuth !== undefined ? { serverAuth } : {}),
        });
  if (committed === undefined) return accessUpdateConflict();

  reconcileCommittedAccess(state, tenant, committed);
  state.servers.set(committed.deploymentId, target);
  return {
    ok: true,
    changed: true,
    accessChanged,
    policyChanged,
    ownerChanged,
    previousAccessMode,
    ...(previousOwnerSubject !== undefined ? { previousOwnerSubject } : {}),
    record: committed,
  };
}

function commitInMemoryAccessUpdate(
  state: RegistryStateView,
  tenant: TenantRef,
  observed: DeployRecord,
  input: ActiveAccessUpdateInput,
): DeployRecord | undefined {
  const committed = resolveActiveAccessUpdate(
    state.records.get(observed.deploymentId),
    tenant,
    input,
  );
  if (committed === undefined) return undefined;
  const proposed = new Map(state.records).set(committed.deploymentId, committed);
  assertUniqueActiveCustomerAuthAudienceBindings([...proposed.values()]);
  state.records.set(committed.deploymentId, committed);
  return committed;
}

function reconcileCommittedAccess(
  state: RegistryStateView,
  tenant: TenantRef,
  committed: DeployRecord,
): void {
  state.records.set(committed.deploymentId, committed);
  state.activeTenants.set(
    tenantDeploymentKey(tenant, committed.serverVersion),
    committed.deploymentId,
  );
}

function noActiveDeployment(): AccessUpdateResult {
  return {
    ok: false,
    status: 404,
    code: 'no_active_deployment',
    message: 'No active deployment exists for this environment.',
  };
}

function accessUpdateConflict(): AccessUpdateResult {
  return {
    ok: false,
    status: 409,
    code: 'access_update_conflict',
    message: 'The active deployment changed before access could be updated.',
  };
}

function customerAuthAudienceConflict(): AccessUpdateResult {
  return {
    ok: false,
    status: 409,
    code: 'customer_auth_audience_conflict',
    message: 'Customer OIDC issuer/audience bindings must be unique to one app and environment.',
  };
}
