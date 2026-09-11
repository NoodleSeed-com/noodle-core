/**
 * Registry state operations that work over the {@link ServerRegistry}'s private maps: the no-store
 * in-memory activation fallback and the app archive/restore/sweep cache reconciliation (ADR 0117).
 * The registry passes a {@link RegistryStateView} of its private fields; store-backed calls hit the
 * durable store first, then reconcile the in-process caches so no instance keeps serving stale state.
 */
import { normalizeServerVersion } from '@noodle-borg/module';
import type { ServedTarget } from '@noodle-borg/transport-http';
import {
  assertCustomerAuthRestorePrecondition,
  assertUniqueActiveCustomerAuthAudienceBindings,
  CustomerAuthAudienceProjectionError,
  hasExactCustomerAuthProjection,
  requiresCustomerAuthProjection,
} from './customer-auth-audience-binding.js';
import { matchesDeploymentActivation } from './deployment-activation-precondition.js';
import {
  assertDeploymentActivationUnlocked,
  assertDeploymentAppendUnlocked,
} from './deployment-lock.js';
import {
  assertDeploymentAppendPolicy,
  assertDeploymentAppendVersion,
} from './deployment-record-version.js';
import { defaultActiveRecord } from './deployment-versioning.js';
import { recordMatchesTenant, tenantDeploymentKey, tenantKey } from './registry-targets.js';
import {
  appArchivedAt,
  deploymentSummary,
  paginateAppSummaries,
  planAppArchive,
  planAppRestore,
  planArchivedAppSweep,
  resolveProductionEnvironment,
  summarizeApps,
  summarizeEnvs,
  withoutArchiveStamp,
} from './store/records.js';
import { validateSlug, validateTenantRef } from './store/validate.js';
import type {
  AppArchiveResult,
  AppRestorePrecondition,
  AppRestoreResult,
  AppSummary,
  ArtifactStore,
  CustomerAuthRestoreProjection,
  DeploymentActivationPrecondition,
  DeploymentLock,
  DeploymentLockUpdateResult,
  DeploymentPolicyPrecondition,
  DeploymentSummary,
  DeployRecord,
  EnvSummary,
  ProductionEnvironmentChange,
  TenantAuthConfig,
  TenantRef,
} from './store.js';

export interface RegistryStateView {
  readonly store: ArtifactStore | undefined;
  readonly records: Map<string, DeployRecord>;
  readonly servers: Map<string, ServedTarget>;
  readonly activeTenants: Map<string, string>;
  readonly productionEnvironments: Map<string, string>;
}

type CompileCustomerAuthRecord = (record: DeployRecord) => Promise<
  | {
      readonly ok: true;
      readonly served: {
        readonly artifact: { readonly server: { readonly auth?: TenantAuthConfig } };
      };
    }
  | { readonly ok: false }
>;

export function reconcilePlatformAccountResetRegistryCache(
  state: RegistryStateView,
  input: {
    readonly action: 'quarantine' | 'rollback';
    readonly apps: readonly { readonly org: string; readonly app: string }[];
    readonly archivedAt: string;
  },
): void {
  for (const app of input.apps) {
    const safeOrg = validateSlug('org', app.org);
    const safeApp = validateSlug('app', app.app);
    if (input.action === 'quarantine') evictArchivedApp(state, safeOrg, safeApp, input.archivedAt);
    else clearCachedArchiveStamps(state, safeOrg, safeApp, input.archivedAt);
  }
}

/**
 * Persist one new deploy record (moved verbatim from `ServerRegistry.deploy`). With a durable store the
 * store owns deactivation; without one the caches are reconciled in-process so no instance serves a stale
 * active record.
 */
export async function persistDeployRecord(
  view: RegistryStateView,
  record: DeployRecord,
  tenant: TenantRef,
  activatesNow: boolean,
  precondition?: DeploymentPolicyPrecondition,
): Promise<DeployRecord> {
  if (view.store) {
    await view.store.append(record, precondition);
    const persisted = (await view.store.get(record.deploymentId)) ?? record;
    view.records.set(record.deploymentId, persisted);
    return persisted;
  } else {
    assertDeploymentAppendVersion([...view.records.values()], record);
    assertDeploymentAppendPolicy([...view.records.values()], record, precondition);
    if (!assertDeploymentAppendUnlocked([...view.records.values()], record)) {
      return view.records.get(record.deploymentId) as DeployRecord;
    }
    const proposed = new Map(view.records);
    if (record.active) deactivateScope(proposed, record);
    proposed.set(record.deploymentId, record);
    assertUniqueActiveCustomerAuthAudienceBindings([...proposed.values()]);
    const productionKey = `${tenant.org}/${tenant.app}`;
    if (!view.productionEnvironments.has(productionKey)) {
      view.productionEnvironments.set(productionKey, tenant.env);
    }
    for (const [id, existing] of view.records) {
      if (
        activatesNow &&
        existing.active &&
        existing.orgSlug === tenant.org &&
        existing.appSlug === tenant.app &&
        existing.environment === tenant.env &&
        existing.serverVersion === record.serverVersion
      ) {
        view.records.set(id, { ...existing, active: false });
      }
    }
    view.records.set(record.deploymentId, record);
    return record;
  }
}

/** No-store activation fallback (moved verbatim from `ServerRegistry.#activateInMemory`). */
export function activateInMemory(
  records: Map<string, DeployRecord>,
  ref: TenantRef,
  deploymentId: string,
  precondition?: DeploymentActivationPrecondition,
):
  | {
      readonly active: DeployRecord;
      readonly previousActive?: DeployRecord;
      readonly alreadyActive: boolean;
    }
  | undefined {
  const target = records.get(deploymentId);
  if (target === undefined || !recordMatchesTenant(target, ref)) return undefined;
  assertDeploymentActivationUnlocked([...records.values()], target);
  if (!matchesDeploymentActivation(target, precondition)) {
    return undefined;
  }
  const previousActive = [...records.values()]
    .filter((record) => record.active && recordMatchesTenant(record, ref))
    .filter((record) => record.serverVersion === target.serverVersion)
    .sort((a, b) => b.deploymentVersion - a.deploymentVersion)[0];
  if (precondition === undefined && previousActive !== undefined) {
    assertDeploymentAppendVersion([previousActive], { ...target, active: true });
  }
  const alreadyActive = previousActive?.deploymentId === deploymentId;
  const activated = {
    ...target,
    active: true,
    ...(requiresCustomerAuthProjection(target, precondition?.serverAuth) &&
    precondition?.serverAuth !== undefined
      ? { serverAuth: precondition.serverAuth }
      : {}),
  };
  const proposed = new Map(records);
  if (!alreadyActive) deactivateScope(proposed, target);
  proposed.set(deploymentId, activated);
  assertUniqueActiveCustomerAuthAudienceBindings([...proposed.values()]);
  if (!alreadyActive) {
    for (const [id, record] of records) {
      if (
        record.active &&
        recordMatchesTenant(record, ref) &&
        record.serverVersion === target.serverVersion
      ) {
        records.set(id, { ...record, active: false });
      }
    }
  }
  records.set(deploymentId, activated);
  return {
    active: activated,
    ...(previousActive !== undefined ? { previousActive } : {}),
    alreadyActive,
  };
}

/**
 * The active deploy record for a tenant, store-first then over the in-process cache (moved verbatim
 * from `ServerRegistry.#activeRecord`). Store hits reconcile the caches so no instance serves stale
 * state; the no-store path falls back to the newest matching record.
 */
export async function activeRecord(
  state: RegistryStateView,
  ref: TenantRef,
): Promise<DeployRecord | undefined> {
  if (state.store) {
    const record = await state.store.getActiveByTenant(ref);
    if (record !== undefined) {
      state.records.set(record.deploymentId, record);
      state.activeTenants.set(tenantDeploymentKey(ref, record.serverVersion), record.deploymentId);
    }
    return record;
  }
  const cachedId = state.activeTenants.get(tenantKey(ref));
  if (cachedId !== undefined) {
    const cached = state.records.get(cachedId);
    if (cached !== undefined && cached.archivedAt === undefined) return cached;
  }
  return defaultActiveRecord([...state.records.values()], ref);
}

/** {@link activeRecord} pinned to one server version (moved verbatim from `#activeRecordVersion`). */
export async function activeRecordVersion(
  state: RegistryStateView,
  ref: TenantRef,
  serverVersion: string,
): Promise<DeployRecord | undefined> {
  const safeServerVersion = normalizeServerVersion(serverVersion);
  if (state.store) {
    const record = await state.store.getActiveByTenantVersion(ref, safeServerVersion);
    if (record !== undefined) {
      state.records.set(record.deploymentId, record);
      state.activeTenants.set(tenantDeploymentKey(ref, safeServerVersion), record.deploymentId);
    }
    return record;
  }
  const cachedId = state.activeTenants.get(tenantDeploymentKey(ref, safeServerVersion));
  if (cachedId !== undefined) {
    const cached = state.records.get(cachedId);
    if (cached !== undefined && cached.archivedAt === undefined) return cached;
  }
  return [...state.records.values()]
    .filter(
      (record) =>
        record.active &&
        record.archivedAt === undefined &&
        recordMatchesTenant(record, ref) &&
        record.serverVersion === safeServerVersion,
    )
    .sort((a, b) => b.deploymentVersion - a.deploymentVersion)[0];
}

/** Atomically freeze or unfreeze one exact active server-version pointer. */
export async function setRegistryDeploymentLock(
  state: RegistryStateView,
  ref: TenantRef,
  serverVersion: string,
  expectedDeploymentId: string,
  deploymentLock: DeploymentLock | undefined,
): Promise<DeploymentLockUpdateResult> {
  const safe = validateTenantRef(ref);
  const safeVersion = normalizeServerVersion(serverVersion);
  if (state.store !== undefined) {
    const result = await state.store.setDeploymentLock(
      safe,
      safeVersion,
      expectedDeploymentId,
      deploymentLock,
    );
    if (result.ok) state.records.set(result.record.deploymentId, result.record);
    return result;
  }

  const active = await activeRecordVersion(state, safe, safeVersion);
  if (active === undefined) return { ok: false, reason: 'no_active_deployment' };
  if (active.deploymentId !== expectedDeploymentId) return { ok: false, reason: 'conflict' };
  const changed = (active.deploymentLock === undefined) !== (deploymentLock === undefined);
  if (!changed) return { ok: true, record: active, changed: false };
  const updated =
    deploymentLock === undefined ? removeDeploymentLock(active) : { ...active, deploymentLock };
  state.records.set(active.deploymentId, updated);
  return { ok: true, record: updated, changed: true };
}

function removeDeploymentLock(record: DeployRecord): DeployRecord {
  const { deploymentLock: _deploymentLock, ...unlocked } = record;
  return unlocked;
}

export function registryAppArchivedAt(
  state: RegistryStateView,
  org: string,
  app: string,
): Promise<string | undefined> {
  const safeOrg = validateSlug('org', org);
  const safeApp = validateSlug('app', app);
  if (state.store !== undefined) return state.store.getAppArchivedAt(safeOrg, safeApp);
  return Promise.resolve(appArchivedAt(appRecordsFromMap(state.records, safeOrg, safeApp)));
}

export async function registryArchiveApp(
  state: RegistryStateView,
  org: string,
  app: string,
  at: string,
): Promise<AppArchiveResult | undefined> {
  const safeOrg = validateSlug('org', org);
  const safeApp = validateSlug('app', app);
  if (state.store !== undefined) {
    const result = await state.store.archiveApp(safeOrg, safeApp, at);
    if (result !== undefined) evictArchivedApp(state, safeOrg, safeApp, result.archivedAt);
    return result;
  }
  const plan = planAppArchive(appRecordsFromMap(state.records, safeOrg, safeApp), at);
  if (plan === undefined) return undefined;
  evictArchivedApp(state, safeOrg, safeApp, plan.result.archivedAt);
  return plan.result;
}

export async function registryRestoreApp(
  state: RegistryStateView,
  org: string,
  app: string,
  compileRecord: CompileCustomerAuthRecord,
): Promise<AppRestoreResult | undefined> {
  const safeOrg = validateSlug('org', org);
  const safeApp = validateSlug('app', app);
  const appRecords = state.store
    ? (await state.store.loadAll()).filter(
        (record) => record.orgSlug === safeOrg && record.appSlug === safeApp,
      )
    : appRecordsFromMap(state.records, safeOrg, safeApp);
  const plan = planAppRestore(appRecords);
  if (plan === undefined) return undefined;
  const projections: AppRestorePrecondition['customerAuthProjections'][number][] = [];
  for (const record of plan.clear) {
    if (!record.active || !requiresCustomerAuthProjection(record)) continue;
    const built = await compileRecord(record);
    const compiledAuth = built.ok ? built.served.artifact.server.auth : undefined;
    if (compiledAuth === undefined || !hasExactCustomerAuthProjection(record, compiledAuth)) {
      throw new CustomerAuthAudienceProjectionError();
    }
    projections.push({
      deploymentId: record.deploymentId,
      manifest: record.manifest,
      serverAuth: compiledAuth,
    });
  }
  const precondition: AppRestorePrecondition = { customerAuthProjections: projections };
  if (state.store !== undefined) {
    const result = await state.store.restoreApp(safeOrg, safeApp, precondition);
    if (result !== undefined) clearCachedArchiveStamps(state, safeOrg, safeApp);
    return result;
  }
  assertCustomerAuthRestorePrecondition(plan.clear, precondition);
  const proposed = new Map(state.records);
  for (const record of plan.clear) {
    proposed.set(record.deploymentId, withoutArchiveStamp(record));
  }
  assertUniqueActiveCustomerAuthAudienceBindings([...proposed.values()]);
  clearCachedArchiveStamps(state, safeOrg, safeApp);
  return plan.result;
}

/** Compile exact private auth snapshots for a later atomic bulk-restore precondition. */
export async function registryCustomerAuthRestoreProjections(
  state: RegistryStateView,
  deploymentIds: readonly string[],
  compileRecord: CompileCustomerAuthRecord,
): Promise<readonly CustomerAuthRestoreProjection[]> {
  const records = await Promise.all(
    deploymentIds.map((deploymentId) =>
      state.store === undefined
        ? Promise.resolve(state.records.get(deploymentId))
        : state.store.get(deploymentId),
    ),
  );
  const projections: CustomerAuthRestoreProjection[] = [];
  for (const record of records) {
    if (record === undefined || !record.active || !requiresCustomerAuthProjection(record)) continue;
    const built = await compileRecord(record);
    const compiledAuth = built.ok ? built.served.artifact.server.auth : undefined;
    if (compiledAuth === undefined || !hasExactCustomerAuthProjection(record, compiledAuth)) {
      throw new CustomerAuthAudienceProjectionError();
    }
    projections.push({
      deploymentId: record.deploymentId,
      manifest: record.manifest,
      serverAuth: compiledAuth,
    });
  }
  return projections;
}

function deactivateScope(records: Map<string, DeployRecord>, candidate: DeployRecord): void {
  for (const [id, record] of records) {
    if (
      record.active &&
      record.orgSlug === candidate.orgSlug &&
      record.appSlug === candidate.appSlug &&
      record.environment === candidate.environment &&
      record.serverVersion === candidate.serverVersion
    ) {
      records.set(id, { ...record, active: false });
    }
  }
}

export async function registrySweepArchived(
  state: RegistryStateView,
  before: string,
  onPurge?: (org: string, app: string, at: string, retired?: boolean) => Promise<void>,
): Promise<readonly DeployRecord[]> {
  let deleted: readonly DeployRecord[];
  if (state.store !== undefined) {
    deleted = await state.store.sweepArchived(before);
  } else {
    deleted = planArchivedAppSweep([...state.records.values()], before);
  }
  const ids = new Set(deleted.map((record) => record.deploymentId));
  for (const id of ids) {
    state.records.delete(id);
    state.servers.delete(id);
  }
  purgeActiveTenantEntries(state, ids);
  const apps = new Map(deleted.map((record) => [`${record.orgSlug}/${record.appSlug}`, record]));
  for (const app of apps.values())
    await onPurge?.(app.orgSlug, app.appSlug, new Date().toISOString(), true);
  return deleted;
}

/** The `apps` resource, store-first with a no-store fallback over the registry's own record cache. */
export function registryListApps(
  state: RegistryStateView,
  org: string,
  opts: { readonly includeArchived?: boolean; readonly limit?: number },
): Promise<{ readonly apps: readonly AppSummary[]; readonly truncated: boolean }> {
  const safeOrg = validateSlug('org', org);
  if (state.store !== undefined) return state.store.listApps(safeOrg, opts);
  const records = appRecordsFromMap(state.records, safeOrg).map(deploymentSummary);
  const summarized = summarizeApps(safeOrg, records, [], {
    includeArchived: opts.includeArchived ?? false,
  });
  return Promise.resolve(paginateAppSummaries(summarized, opts.limit));
}

export function registryGetApp(
  state: RegistryStateView,
  org: string,
  app: string,
): Promise<AppSummary | undefined> {
  const safeOrg = validateSlug('org', org);
  const safeApp = validateSlug('app', app);
  if (state.store !== undefined) return state.store.getApp(safeOrg, safeApp);
  const records = appRecordsFromMap(state.records, safeOrg, safeApp).map(deploymentSummary);
  if (records.length === 0) return Promise.resolve(undefined);
  return Promise.resolve(summarizeApps(safeOrg, records, [], { includeArchived: true })[0]);
}

/** The `envs` resource, store-first with a no-store fallback over the registry's own record cache. */
export function registryListEnvironments(
  state: RegistryStateView,
  org: string,
  app: string,
  opts: { readonly includeArchived?: boolean },
): Promise<readonly EnvSummary[]> {
  const safeOrg = validateSlug('org', org);
  const safeApp = validateSlug('app', app);
  if (state.store !== undefined) return state.store.listEnvironments(safeOrg, safeApp, opts);
  const records = appRecordsFromMap(state.records, safeOrg, safeApp).map(deploymentSummary);
  return Promise.resolve(
    summarizeEnvs(safeOrg, safeApp, records, [], {
      includeArchived: opts.includeArchived ?? false,
      productionEnvironment: state.productionEnvironments.get(`${safeOrg}/${safeApp}`),
    }),
  );
}

export function registryGetEnvironment(
  state: RegistryStateView,
  org: string,
  app: string,
  env: string,
): Promise<EnvSummary | undefined> {
  const safeOrg = validateSlug('org', org);
  const safeApp = validateSlug('app', app);
  const safeEnv = validateSlug('env', env);
  if (state.store !== undefined) return state.store.getEnvironment(safeOrg, safeApp, safeEnv);
  const records = appRecordsFromMap(state.records, safeOrg, safeApp)
    .filter((record) => record.environment === safeEnv)
    .map(deploymentSummary);
  if (records.length === 0) return Promise.resolve(undefined);
  return Promise.resolve(
    summarizeEnvs(safeOrg, safeApp, records, [], {
      includeArchived: true,
      productionEnvironment: state.productionEnvironments.get(`${safeOrg}/${safeApp}`),
    })[0],
  );
}

export function registrySetProductionEnvironment(
  state: RegistryStateView,
  org: string,
  app: string,
  env: string,
): Promise<ProductionEnvironmentChange | undefined> {
  const safeOrg = validateSlug('org', org);
  const safeApp = validateSlug('app', app);
  const safeEnv = validateSlug('env', env);
  if (state.store !== undefined) {
    return state.store.setProductionEnvironment(safeOrg, safeApp, safeEnv);
  }
  const envNames = new Set(
    appRecordsFromMap(state.records, safeOrg, safeApp).map((record) => record.environment),
  );
  if (!envNames.has(safeEnv)) return Promise.resolve(undefined);
  const key = `${safeOrg}/${safeApp}`;
  const previous = resolveProductionEnvironment(envNames, state.productionEnvironments.get(key));
  state.productionEnvironments.set(key, safeEnv);
  return Promise.resolve({
    orgSlug: safeOrg,
    appSlug: safeApp,
    productionEnvironment: safeEnv,
    previousProductionEnvironment: previous ?? null,
    changed: previous !== safeEnv,
  });
}

/**
 * One deployment by id, scoped to `org`, store-first with a no-store fallback over the registry's own
 * record cache. `undefined` both for an unknown id and for an id that belongs to a different org.
 */
export function registryGetDeployment(
  state: RegistryStateView,
  org: string,
  deploymentId: string,
): Promise<DeploymentSummary | undefined> {
  const safeOrg = validateSlug('org', org);
  if (state.store !== undefined) return state.store.getDeployment(safeOrg, deploymentId);
  const record = state.records.get(deploymentId);
  if (record === undefined || record.orgSlug !== safeOrg) return Promise.resolve(undefined);
  return Promise.resolve(deploymentSummary(record));
}

/** Every record for `org`, optionally narrowed to one `app` (omit to scan the whole org). */
function appRecordsFromMap(
  records: Map<string, DeployRecord>,
  org: string,
  app?: string,
): readonly DeployRecord[] {
  return [...records.values()].filter(
    (record) => record.orgSlug === org && (app === undefined || record.appSlug === app),
  );
}

/**
 * Stamp cached records and drop the app's active-tenant pointers so this instance stops serving
 * immediately (`ServerRegistry.get` fails closed on a stamped record). With a durable store the
 * compiled servers are also dropped — a restore recompiles lazily from the store. Without a store
 * the compiled servers are the only copy, so they stay cached (blocked by the record stamp) and
 * restore resumes serving instantly. Records already stamped keep their original stamp.
 */
function evictArchivedApp(
  state: RegistryStateView,
  org: string,
  app: string,
  archivedAt: string,
): void {
  const ids = new Set<string>();
  for (const [id, record] of state.records) {
    if (record.orgSlug !== org || record.appSlug !== app) continue;
    ids.add(id);
    if (record.archivedAt === undefined) state.records.set(id, { ...record, archivedAt });
    if (state.store !== undefined) state.servers.delete(id);
  }
  purgeActiveTenantEntries(state, ids);
}

function clearCachedArchiveStamps(
  state: RegistryStateView,
  org: string,
  app: string,
  archivedAt?: string,
): void {
  for (const [id, record] of state.records) {
    if (
      record.orgSlug === org &&
      record.appSlug === app &&
      record.archivedAt !== undefined &&
      (archivedAt === undefined || record.archivedAt === archivedAt)
    ) {
      state.records.set(id, withoutArchiveStamp(record));
    }
  }
}

function purgeActiveTenantEntries(state: RegistryStateView, ids: ReadonlySet<string>): void {
  for (const [key, id] of state.activeTenants) {
    if (ids.has(id)) state.activeTenants.delete(key);
  }
}
