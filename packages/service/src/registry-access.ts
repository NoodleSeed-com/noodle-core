import type { OwnerTokenVerifier, ServedTarget } from '@noodle-borg/transport-http';
import {
  assertUniqueActiveCustomerAuthAudienceBindings,
  CustomerAuthAudienceConflictError,
} from './customer-auth-audience-binding.js';
import { deploymentOwnerSubject } from './registry-helpers.js';
import { activeRecord, activeRecordVersion, type RegistryStateView } from './registry-state.js';
import { tenantDeploymentKey, tryServedTargetFor } from './registry-targets.js';
import type { AccessUpdateOptions, AccessUpdateResult } from './registry-types.js';
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
  if (options.accessMode === 'customers') {
    const record =
      options.serverVersion === undefined
        ? await activeRecord(state, tenant)
        : await activeRecordVersion(state, tenant, options.serverVersion);
    const served = record === undefined ? undefined : await loadServed(record.deploymentId);
    const auth = served?.served.artifact.server.auth;
    if (
      record !== undefined &&
      auth !== undefined &&
      (await hasCustomerAuthConflict({ ...record, accessMode: 'customers' }, auth))
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

  const nextAccessMode = options.accessMode;
  const previousAccessMode = record.accessMode ?? 'owner-only';
  const previousOwnerSubject = deploymentOwnerSubject(record);
  const nextOwnerSubject = options.ownerSubject ?? previousOwnerSubject;
  const accessChanged = previousAccessMode !== nextAccessMode;
  const ownerChanged = previousOwnerSubject !== nextOwnerSubject;
  const served =
    accessChanged || ownerChanged || nextAccessMode === 'customers'
      ? await loadServed(record.deploymentId)
      : undefined;
  const serverAuth = served?.served.artifact.server.auth;
  if (nextAccessMode === 'customers' && serverAuth === undefined) {
    return {
      ok: false,
      status: 409,
      code: 'server_auth_required',
      message: 'Customer access requires server authentication.',
    };
  }
  if (!accessChanged && !ownerChanged) {
    const committed =
      state.store === undefined
        ? commitInMemoryAccessUpdate(state, tenant, record, {
            accessMode: nextAccessMode,
            expectedAccessMode: record.accessMode,
            expectedOwnerSubject: previousOwnerSubject,
            ...(serverAuth !== undefined ? { serverAuth } : {}),
          })
        : await state.store.updateActiveAccess(tenant, record.deploymentId, {
            accessMode: nextAccessMode,
            expectedAccessMode: record.accessMode,
            expectedOwnerSubject: previousOwnerSubject,
            ...(serverAuth !== undefined ? { serverAuth } : {}),
          });
    if (committed === undefined) return accessUpdateConflict();
    reconcileCommittedAccess(state, tenant, committed);
    return {
      ok: true,
      changed: false,
      accessChanged: false,
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
    ...(ownerChanged && nextOwnerSubject !== undefined ? { ownerSubject: nextOwnerSubject } : {}),
    ...(nextAccessMode === 'customers' && serverAuth !== undefined ? { serverAuth } : {}),
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
          expectedOwnerSubject: previousOwnerSubject,
          ...(serverAuth !== undefined ? { serverAuth } : {}),
        })
      : await state.store.updateActiveAccess(tenant, record.deploymentId, {
          accessMode: nextAccessMode,
          ...(ownerChanged && nextOwnerSubject !== undefined
            ? { ownerSubject: nextOwnerSubject }
            : {}),
          expectedAccessMode: record.accessMode,
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
  const current = state.records.get(observed.deploymentId);
  if (
    current === undefined ||
    !current.active ||
    current.archivedAt !== undefined ||
    current.orgSlug !== tenant.org ||
    current.appSlug !== tenant.app ||
    current.environment !== tenant.env ||
    current.accessMode !== input.expectedAccessMode ||
    deploymentOwnerSubject(current) !== input.expectedOwnerSubject
  ) {
    return undefined;
  }
  if (
    (current.accessMode ?? 'owner-only') === input.accessMode &&
    (input.ownerSubject === undefined || deploymentOwnerSubject(current) === input.ownerSubject) &&
    input.accessMode !== 'customers'
  ) {
    return current;
  }
  const committed = {
    ...current,
    accessMode: input.accessMode,
    ...(input.ownerSubject !== undefined ? { ownerSubject: input.ownerSubject } : {}),
    ...(input.accessMode === 'customers' && input.serverAuth !== undefined
      ? { serverAuth: input.serverAuth }
      : {}),
  };
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
