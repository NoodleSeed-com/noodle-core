import { normalizeServerVersion } from '@noodle-borg/module';
import type { AccessMode } from '@noodle-borg/transport-http';
import {
  assertSameAppPackageSnapshot,
  sanitizeDeployRecordAppPackageSnapshot,
} from '../app-package-snapshot.js';
import {
  assertCustomerAuthRestorePrecondition,
  assertUniqueActiveCustomerAuthAudienceBindings,
  findActiveCustomerAuthAudienceConflict,
} from '../customer-auth-audience-binding.js';
import {
  assertDeploymentActivationUnlocked,
  assertDeploymentAppendUnlocked,
} from '../deployment-lock.js';
import {
  defaultActiveRecord,
  sameDeploymentScope,
  sameTenantRecord,
} from '../deployment-versioning.js';
import type {
  ActiveAccessUpdateInput,
  AppArchiveResult,
  AppRestorePrecondition,
  AppRestoreResult,
  AppSummary,
  ArtifactStore,
  DeploymentActivationResult,
  DeploymentListFilter,
  DeploymentLock,
  DeploymentLockUpdateResult,
  DeploymentSummary,
  DeployRecord,
  EnvSummary,
  ProductionEnvironmentChange,
  TenantAuthConfig,
  TenantRef,
} from '../store.js';
import {
  appArchivedAt,
  deploymentSummary,
  matchesDeploymentFilter,
  paginateAppSummaries,
  planAppArchive,
  planAppRestore,
  planArchivedAppSweep,
  preserveDeploymentOwnerState,
  resolveActiveAccessUpdate,
  resolveProductionEnvironment,
  summarizeApps,
  summarizeEnvs,
  validateDeploymentListFilter,
  withoutArchiveStamp,
} from './records.js';
import { validateSlug, validateTenantRef } from './validate.js';

/** In-memory store: keeps records in a Map. Used by tests and as an explicit, non-persistent option. */
export class InMemoryArtifactStore implements ArtifactStore {
  readonly #records = new Map<string, DeployRecord>();
  readonly #productionEnvironments = new Map<string, string>();

  async append(record: DeployRecord): Promise<void> {
    const existing = this.#records.get(record.deploymentId);
    if (existing !== undefined) assertSameAppPackageSnapshot(existing, record);
    record = sanitizeDeployRecordAppPackageSnapshot(record);
    if (existing !== undefined) record = preserveDeploymentOwnerState(existing, record);
    validateTenantRef({ org: record.orgSlug, app: record.appSlug, env: record.environment });
    if (!assertDeploymentAppendUnlocked([...this.#records.values()], record)) return;
    const proposed = new Map(this.#records);
    if (record.active) deactivateScope(proposed, record);
    proposed.set(record.deploymentId, record);
    assertUniqueActiveCustomerAuthAudienceBindings([...proposed.values()]);
    const appKey = `${record.orgSlug}/${record.appSlug}`;
    if (!this.#productionEnvironments.has(appKey)) {
      const existing = new Set(
        this.#appRecords(record.orgSlug, record.appSlug).map((item) => item.environment),
      );
      const production = resolveProductionEnvironment(existing) ?? record.environment;
      this.#productionEnvironments.set(appKey, production);
    }
    if (record.active) this.#deactivateTenant(record);
    this.#records.set(record.deploymentId, record);
    return Promise.resolve();
  }

  loadAll(): Promise<readonly DeployRecord[]> {
    return Promise.resolve([...this.#records.values()].map(sanitizeDeployRecordAppPackageSnapshot));
  }

  get(deploymentId: string): Promise<DeployRecord | undefined> {
    const record = this.#records.get(deploymentId);
    return Promise.resolve(
      record === undefined ? undefined : sanitizeDeployRecordAppPackageSnapshot(record),
    );
  }

  getActiveByTenant(ref: TenantRef): Promise<DeployRecord | undefined> {
    return Promise.resolve(
      defaultActiveRecord([...this.#records.values()], validateTenantRef(ref)),
    );
  }

  getActiveByTenantVersion(
    ref: TenantRef,
    serverVersion: string,
  ): Promise<DeployRecord | undefined> {
    const safe = validateTenantRef(ref);
    const safeVersion = normalizeServerVersion(serverVersion);
    return Promise.resolve(
      [...this.#records.values()]
        .filter(
          (record) =>
            record.active &&
            record.archivedAt === undefined &&
            sameTenantRecord(record, safe) &&
            record.serverVersion === safeVersion,
        )
        .sort((a, b) => b.deploymentVersion - a.deploymentVersion)[0],
    );
  }

  setDeploymentLock(
    ref: TenantRef,
    serverVersion: string,
    expectedDeploymentId: string,
    deploymentLock: DeploymentLock | undefined,
  ): Promise<DeploymentLockUpdateResult> {
    const safe = validateTenantRef(ref);
    const safeVersion = normalizeServerVersion(serverVersion);
    const active = [...this.#records.values()].find(
      (record) =>
        record.active &&
        record.archivedAt === undefined &&
        sameTenantRecord(record, safe) &&
        record.serverVersion === safeVersion,
    );
    if (active === undefined) return Promise.resolve({ ok: false, reason: 'no_active_deployment' });
    if (active.deploymentId !== expectedDeploymentId) {
      return Promise.resolve({ ok: false, reason: 'conflict' });
    }
    const changed = (active.deploymentLock === undefined) !== (deploymentLock === undefined);
    if (!changed) return Promise.resolve({ ok: true, record: active, changed: false });
    const updated =
      deploymentLock === undefined ? withoutDeploymentLock(active) : { ...active, deploymentLock };
    this.#records.set(active.deploymentId, updated);
    return Promise.resolve({ ok: true, record: updated, changed: true });
  }

  findActiveCustomerAuthAudienceConflict(
    ref: TenantRef,
    auth: TenantAuthConfig,
  ): Promise<TenantRef | undefined> {
    return Promise.resolve(
      findActiveCustomerAuthAudienceConflict(
        [...this.#records.values()],
        validateTenantRef(ref),
        auth,
      ),
    );
  }

  async activateDeployment(
    ref: TenantRef,
    deploymentId: string,
    precondition?: {
      readonly expectedAccessMode: AccessMode | undefined;
      readonly serverAuth?: TenantAuthConfig;
    },
    _options: { readonly automationId?: string } = {},
  ): Promise<DeploymentActivationResult | undefined> {
    const safe = validateTenantRef(ref);
    const target = this.#records.get(deploymentId);
    if (target === undefined || !sameTenantRecord(target, safe)) return Promise.resolve(undefined);
    assertDeploymentActivationUnlocked([...this.#records.values()], target);
    if (precondition !== undefined && target.accessMode !== precondition.expectedAccessMode) {
      return Promise.resolve(undefined);
    }
    const previousActive = [...this.#records.values()]
      .filter((record) => record.active && sameDeploymentScope(record, target))
      .sort((a, b) => b.deploymentVersion - a.deploymentVersion)[0];
    const alreadyActive = previousActive?.deploymentId === target.deploymentId;
    const activated = {
      ...target,
      active: true,
      ...(target.accessMode === 'customers' && precondition?.serverAuth !== undefined
        ? { serverAuth: precondition.serverAuth }
        : {}),
    };
    const proposed = new Map(this.#records);
    if (!alreadyActive) deactivateScope(proposed, target);
    proposed.set(target.deploymentId, activated);
    assertUniqueActiveCustomerAuthAudienceBindings([...proposed.values()]);
    if (!alreadyActive) {
      this.#deactivateTenant(target);
    }
    this.#records.set(target.deploymentId, activated);
    return Promise.resolve({
      active: activated,
      ...(previousActive !== undefined ? { previousActive } : {}),
      alreadyActive,
    });
  }

  #deactivateTenant(record: DeployRecord): void {
    for (const [id, existing] of this.#records) {
      if (existing.active && sameDeploymentScope(existing, record)) {
        this.#records.set(id, { ...existing, active: false });
      }
    }
  }

  async updateActiveAccess(
    ref: TenantRef,
    deploymentId: string,
    input: ActiveAccessUpdateInput,
  ): Promise<DeployRecord | undefined> {
    const safe = validateTenantRef(ref);
    const record = this.#records.get(deploymentId);
    const updated = resolveActiveAccessUpdate(record, safe, input);
    if (updated === undefined || updated === record) return Promise.resolve(updated);
    const proposed = new Map(this.#records).set(updated.deploymentId, updated);
    assertUniqueActiveCustomerAuthAudienceBindings([...proposed.values()]);
    this.#records.set(updated.deploymentId, updated);
    return Promise.resolve(updated);
  }

  listDeployments(filter: DeploymentListFilter): Promise<readonly DeploymentSummary[]> {
    const safe = validateDeploymentListFilter(filter);
    return Promise.resolve(
      [...this.#records.values()]
        .filter((record) => matchesDeploymentFilter(record, safe))
        .sort((a, b) => b.deploymentVersion - a.deploymentVersion)
        .map(deploymentSummary),
    );
  }

  getAppArchivedAt(org: string, app: string): Promise<string | undefined> {
    return Promise.resolve(appArchivedAt(this.#appRecords(org, app)));
  }

  archiveApp(org: string, app: string, at: string): Promise<AppArchiveResult | undefined> {
    const plan = planAppArchive(this.#appRecords(org, app), at);
    if (plan === undefined) return Promise.resolve(undefined);
    for (const record of plan.stamp) {
      this.#records.set(record.deploymentId, { ...record, archivedAt: plan.result.archivedAt });
    }
    return Promise.resolve(plan.result);
  }

  async restoreApp(
    org: string,
    app: string,
    precondition?: AppRestorePrecondition,
  ): Promise<AppRestoreResult | undefined> {
    const plan = planAppRestore(this.#appRecords(org, app));
    if (plan === undefined) return Promise.resolve(undefined);
    assertCustomerAuthRestorePrecondition(plan.clear, precondition);
    const proposed = new Map(this.#records);
    for (const record of plan.clear) {
      proposed.set(record.deploymentId, withoutArchiveStamp(record));
    }
    assertUniqueActiveCustomerAuthAudienceBindings([...proposed.values()]);
    for (const record of plan.clear) {
      this.#records.set(record.deploymentId, withoutArchiveStamp(record));
    }
    return Promise.resolve(plan.result);
  }

  sweepArchived(before: string): Promise<readonly DeployRecord[]> {
    const deleted = planArchivedAppSweep([...this.#records.values()], before);
    for (const record of deleted) this.#records.delete(record.deploymentId);
    return Promise.resolve(deleted);
  }

  async listApps(
    org: string,
    opts: { readonly includeArchived?: boolean; readonly limit?: number } = {},
  ): Promise<{ readonly apps: readonly AppSummary[]; readonly truncated: boolean }> {
    const safeOrg = validateSlug('org', org);
    const records = await this.listDeployments({ org: safeOrg, includeArchived: true });
    const summarized = summarizeApps(safeOrg, records, [], {
      includeArchived: opts.includeArchived ?? false,
    });
    return paginateAppSummaries(summarized, opts.limit);
  }

  async getApp(org: string, app: string): Promise<AppSummary | undefined> {
    const safeOrg = validateSlug('org', org);
    const safeApp = validateSlug('app', app);
    const records = await this.listDeployments({
      org: safeOrg,
      app: safeApp,
      includeArchived: true,
    });
    if (records.length === 0) return undefined;
    return summarizeApps(safeOrg, records, [], { includeArchived: true })[0];
  }

  async listEnvironments(
    org: string,
    app: string,
    opts: { readonly includeArchived?: boolean } = {},
  ): Promise<readonly EnvSummary[]> {
    const safeOrg = validateSlug('org', org);
    const safeApp = validateSlug('app', app);
    const records = await this.listDeployments({
      org: safeOrg,
      app: safeApp,
      includeArchived: true,
    });
    return summarizeEnvs(safeOrg, safeApp, records, [], {
      includeArchived: opts.includeArchived ?? false,
      productionEnvironment: this.#productionEnvironments.get(`${safeOrg}/${safeApp}`),
    });
  }

  async getEnvironment(org: string, app: string, env: string): Promise<EnvSummary | undefined> {
    const safeOrg = validateSlug('org', org);
    const safeApp = validateSlug('app', app);
    const safeEnv = validateSlug('env', env);
    const records = await this.listDeployments({
      org: safeOrg,
      app: safeApp,
      env: safeEnv,
      includeArchived: true,
    });
    if (records.length === 0) return undefined;
    return summarizeEnvs(safeOrg, safeApp, records, [], {
      includeArchived: true,
      productionEnvironment: this.#productionEnvironments.get(`${safeOrg}/${safeApp}`),
    })[0];
  }

  setProductionEnvironment(
    org: string,
    app: string,
    env: string,
  ): Promise<ProductionEnvironmentChange | undefined> {
    const safeOrg = validateSlug('org', org);
    const safeApp = validateSlug('app', app);
    const safeEnv = validateSlug('env', env);
    const envNames = new Set(
      this.#appRecords(safeOrg, safeApp).map((record) => record.environment),
    );
    if (!envNames.has(safeEnv)) return Promise.resolve(undefined);
    const key = `${safeOrg}/${safeApp}`;
    const previous = resolveProductionEnvironment(envNames, this.#productionEnvironments.get(key));
    this.#productionEnvironments.set(key, safeEnv);
    return Promise.resolve({
      orgSlug: safeOrg,
      appSlug: safeApp,
      productionEnvironment: safeEnv,
      previousProductionEnvironment: previous ?? null,
      changed: previous !== safeEnv,
    });
  }

  async getDeployment(org: string, deploymentId: string): Promise<DeploymentSummary | undefined> {
    const safeOrg = validateSlug('org', org);
    const record = await this.get(deploymentId);
    if (record === undefined || record.orgSlug !== safeOrg) return undefined;
    return deploymentSummary(record);
  }

  #appRecords(org: string, app: string): readonly DeployRecord[] {
    const safeOrg = validateSlug('org', org);
    const safeApp = validateSlug('app', app);
    return [...this.#records.values()].filter(
      (record) => record.orgSlug === safeOrg && record.appSlug === safeApp,
    );
  }
}

function deactivateScope(records: Map<string, DeployRecord>, candidate: DeployRecord): void {
  for (const [id, record] of records) {
    if (record.active && sameDeploymentScope(record, candidate)) {
      records.set(id, { ...record, active: false });
    }
  }
}

function withoutDeploymentLock(record: DeployRecord): DeployRecord {
  const { deploymentLock: _deploymentLock, ...unlocked } = record;
  return unlocked;
}
