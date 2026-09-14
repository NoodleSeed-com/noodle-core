import type { ServedTarget } from '@noodle-borg/transport-http';
import { planDeploymentDeletion } from './deployment-deletion.js';
import type { RegistryStateView } from './registry-state.js';
import { targetForPersistedRecord } from './registry-targets.js';
import { validateTenantRef } from './store/validate.js';
import type {
  DeploymentDeleteResult,
  DeploymentDeleteSelection,
  DeployRecord,
  TenantRef,
} from './store.js';

export function evictDeletedDeployments(state: RegistryStateView, ids: ReadonlySet<string>): void {
  for (const id of ids) {
    state.records.delete(id);
    state.servers.delete(id);
  }
  for (const [key, id] of state.activeTenants) if (ids.has(id)) state.activeTenants.delete(key);
}

export async function deleteRegistryDeployments(
  state: RegistryStateView,
  ref: TenantRef,
  selection: DeploymentDeleteSelection,
): Promise<DeploymentDeleteResult> {
  const safe = validateTenantRef(ref);
  const result =
    state.store === undefined
      ? planDeploymentDeletion([...state.records.values()], safe, selection)
      : await state.store.deleteDeployments(safe, selection);
  if (result.ok)
    evictDeletedDeployments(state, new Set(result.deleted.map((record) => record.deploymentId)));
  return result;
}

/** Async compilation must rejoin authority before publishing a result into the disposable cache. */
export async function registryRecordStillExists(
  state: RegistryStateView,
  deploymentId: string,
): Promise<boolean> {
  const current =
    state.store === undefined
      ? state.records.get(deploymentId)
      : await state.store.get(deploymentId);
  if (current !== undefined && current.archivedAt === undefined) return true;
  evictDeletedDeployments(state, new Set([deploymentId]));
  return false;
}

/** Refresh warmed cache entries from authority and coalesce compilation on a cache miss. */
export async function readRegistryTarget(
  state: RegistryStateView,
  deploymentId: string,
  inflight: Map<string, Promise<ServedTarget | undefined>>,
  targetForRecord: (record: DeployRecord) => Promise<ServedTarget | undefined>,
  load: (deploymentId: string) => Promise<ServedTarget | undefined>,
): Promise<ServedTarget | undefined> {
  if (state.records.get(deploymentId)?.archivedAt !== undefined) return undefined;
  if (state.servers.has(deploymentId)) {
    const record = state.store
      ? await state.store.get(deploymentId)
      : state.records.get(deploymentId);
    if (record === undefined) evictDeletedDeployments(state, new Set([deploymentId]));
    return record === undefined || record.archivedAt !== undefined
      ? undefined
      : targetForRecord(record);
  }
  const pending = inflight.get(deploymentId);
  if (pending) return pending;
  const promise = load(deploymentId).finally(() => {
    inflight.delete(deploymentId);
  });
  inflight.set(deploymentId, promise);
  return promise;
}

/** No-store records are authority, so stale reconciliation must never repopulate absent records. */
export async function reconcileRegistryTarget(
  state: RegistryStateView,
  record: DeployRecord,
  context: Pick<
    Parameters<typeof targetForPersistedRecord>[1],
    'customerVerifierFactory' | 'hasCustomerAuthConflict'
  > & { readonly load: () => Promise<ServedTarget | undefined> },
): Promise<ServedTarget | undefined> {
  let loaded = false;
  const target = await targetForPersistedRecord(record, {
    ...context,
    load: () => {
      loaded = true;
      return context.load();
    },
    records: state.records,
    servers: state.servers,
    recordStillPresent: () => state.store !== undefined || state.records.has(record.deploymentId),
  });
  // A cold load already checks store authority just before publication; warm reconciliation must too.
  // No async presence snapshot in no-store mode: deletion and publication share one synchronous turn.
  const exists =
    state.store === undefined
      ? state.records.has(record.deploymentId)
      : loaded || (await registryRecordStillExists(state, record.deploymentId));
  return exists ? target : undefined;
}
