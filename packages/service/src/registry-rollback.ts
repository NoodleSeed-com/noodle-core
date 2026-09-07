import type { CapabilityName } from '@noodle-borg/capabilities';
import type { RollbackResult } from '@noodle-borg/control-plane/portable';
import type { ServedArtifact } from '@noodle-borg/protocol';
import type { OwnerTokenVerifier } from '@noodle-borg/transport-http';
import { withDeploymentConfiguration } from './registry-deploy-transaction.js';
import { deploymentOwnerSubject, missingCapabilityErrors } from './registry-helpers.js';
import { activateInMemory, type RegistryStateView } from './registry-state.js';
import {
  recordMatchesTenant,
  servedTargetFor,
  tenantDeploymentKey,
  tenantKey,
  tryServedTargetFor,
} from './registry-targets.js';
import type { DeployError } from './registry-types.js';
import type { ConfigStore, DeployRecord, TenantAuthConfig, TenantRef } from './store.js';

type CompilePersistedRecord = (record: DeployRecord) => Promise<
  | {
      readonly ok: true;
      readonly served: ServedArtifact;
      readonly bindDeployment: (deploymentId: string) => ServedArtifact;
    }
  | { readonly ok: false; readonly errors: readonly DeployError[] }
>;

type CustomerAuthConflictGuard = (
  record: DeployRecord,
  auth: TenantAuthConfig | undefined,
) => Promise<boolean>;

/**
 * Rollback with the registry's error mapping and knowledge revision pairing (ADR 0202):
 * a successful artifact rollback reselects every knowledge revision the target pinned.
 */
export async function rollbackWithMappedErrors(input: {
  readonly configStore: ConfigStore;
  readonly org: string;
  readonly run: () => Promise<RollbackResult>;
  readonly pairKnowledge: () => Promise<void>;
  readonly isAudienceConflict: (error: unknown) => boolean;
  readonly isDeploymentLocked: (error: unknown) => error is Error;
}): Promise<RollbackResult> {
  try {
    const result = await withDeploymentConfiguration(input.configStore, input.org, input.run);
    if (result.ok) await input.pairKnowledge();
    return result;
  } catch (error) {
    if (input.isAudienceConflict(error)) {
      return {
        ok: false,
        status: 409,
        error: 'deployment cannot be activated: customer_auth_audience_conflict',
      };
    }
    if (input.isDeploymentLocked(error)) {
      return { ok: false, status: 409, code: 'deployment_locked', error: error.message };
    }
    throw error;
  }
}

/** Validate and atomically activate a previous deployment within one tenant boundary. */
export async function rollbackDeployment(
  state: RegistryStateView,
  ref: TenantRef,
  deploymentId: string,
  compilePersistedRecord: CompilePersistedRecord,
  serviceCapabilities: readonly CapabilityName[],
  customerVerifierFactory: ((auth: TenantAuthConfig) => OwnerTokenVerifier) | undefined,
  hasCustomerAuthConflict: CustomerAuthConflictGuard,
): Promise<RollbackResult> {
  const target = state.store
    ? await state.store.get(deploymentId)
    : state.records.get(deploymentId);
  if (target === undefined || !recordMatchesTenant(target, ref)) {
    return { ok: false, status: 404, error: 'deployment not found for target environment' };
  }
  const built = await compilePersistedRecord(target);
  if (!built.ok) {
    return {
      ok: false,
      status: 409,
      error: `deployment cannot be activated: ${built.errors.map((error) => error.code).join(',')}`,
    };
  }
  const missingCapabilities = missingCapabilityErrors(
    built.served.artifact.requirements?.capabilities ?? [],
    serviceCapabilities,
  );
  if (missingCapabilities.length > 0) {
    return {
      ok: false,
      status: 409,
      error: `deployment cannot be activated: ${missingCapabilities.map((error) => error.code).join(',')}`,
    };
  }
  const compiledAuth = built.served.artifact.server.auth;
  const projectedTarget = {
    ...target,
    ...(target.accessMode === 'customers' && compiledAuth !== undefined
      ? { serverAuth: compiledAuth }
      : {}),
  };
  if (tryServedTargetFor(projectedTarget, built.served, customerVerifierFactory) === undefined) {
    return {
      ok: false,
      status: 409,
      error: 'deployment cannot be activated: server_auth_required',
    };
  }
  if (await hasCustomerAuthConflict({ ...projectedTarget, active: true }, compiledAuth)) {
    return {
      ok: false,
      status: 409,
      error: 'deployment cannot be activated: customer_auth_audience_conflict',
    };
  }

  const activation = state.store
    ? await state.store.activateDeployment(ref, deploymentId, {
        expectedAccessMode: target.accessMode,
        ...(compiledAuth !== undefined ? { serverAuth: compiledAuth } : {}),
      })
    : activateInMemory(state.records, ref, deploymentId, {
        expectedAccessMode: target.accessMode,
        ...(compiledAuth !== undefined ? { serverAuth: compiledAuth } : {}),
      });
  if (activation === undefined) {
    const latest = state.store
      ? await state.store.get(deploymentId)
      : state.records.get(deploymentId);
    return latest !== undefined && recordMatchesTenant(latest, ref)
      ? {
          ok: false,
          status: 409,
          error: 'deployment changed while rollback was being validated',
        }
      : { ok: false, status: 404, error: 'deployment not found for target environment' };
  }
  const active = activation.active;
  const previous = activation.previousActive;
  state.records.set(active.deploymentId, active);
  if (previous !== undefined && previous.deploymentId !== active.deploymentId) {
    state.records.set(previous.deploymentId, { ...previous, active: false });
  }
  state.servers.set(
    active.deploymentId,
    servedTargetFor(active, built.served, customerVerifierFactory),
  );
  state.activeTenants.set(tenantDeploymentKey(ref, active.serverVersion), active.deploymentId);
  state.activeTenants.delete(tenantKey(ref));
  const ownerSubject = deploymentOwnerSubject(active);
  return {
    ok: true,
    deploymentId: active.deploymentId,
    ...(active.serverVersion !== undefined ? { serverVersion: active.serverVersion } : {}),
    ...(previous !== undefined ? { previousDeploymentId: previous.deploymentId } : {}),
    alreadyActive: activation.alreadyActive,
    accessMode: active.accessMode ?? 'owner-only',
    ...(ownerSubject !== undefined ? { ownerSubject } : {}),
    ...(previous?.accessMode !== undefined ? { previousAccessMode: previous.accessMode } : {}),
    serverName: active.serverName,
    createdAt: active.createdAt,
  };
}
