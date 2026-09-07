import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
import { DEPLOYMENT_ID_PATTERN, validateSlug, validateTenantRef } from './validate.js';

/**
 * JSON-file store: one file per deployment at `<dataDir>/deployments/<deploymentId>.json`, written atomically
 * (write a temp file, then `rename` over the target — no partial file is ever read). `deploymentId` is a
 * slug + random hex suffix (`mintDeploymentId`), so it is a safe, collision-free filename. No new
 * dependency — `node:fs/promises` only.
 */
export class JsonFileArtifactStore implements ArtifactStore {
  readonly #dir: string;
  readonly #environmentMetadataDir: string;
  #lifecycleTail: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.#dir = join(dataDir, 'deployments');
    this.#environmentMetadataDir = join(dataDir, 'environment-metadata');
  }

  append(record: DeployRecord): Promise<void> {
    return this.#serializeLifecycle(() => this.#appendUnlocked(record));
  }

  async #appendUnlocked(record: DeployRecord): Promise<void> {
    // Defence in depth: `deploymentId` becomes a filename, so reject anything outside the minted shape
    // (`mintDeploymentId` only ever produces `[a-z0-9-]`). Guards this public class against a caller that
    // passes an untrusted id (no path traversal, no escaping the data dir).
    validateTenantRef({ org: record.orgSlug, app: record.appSlug, env: record.environment });
    if (!DEPLOYMENT_ID_PATTERN.test(record.deploymentId)) {
      throw new Error(`invalid deploymentId for persistence: "${record.deploymentId}"`);
    }
    const records = await this.loadAll();
    const existing = records.find((candidate) => candidate.deploymentId === record.deploymentId);
    if (existing !== undefined) assertSameAppPackageSnapshot(existing, record);
    record = sanitizeDeployRecordAppPackageSnapshot(record);
    if (existing !== undefined) record = preserveDeploymentOwnerState(existing, record);
    if (!assertDeploymentAppendUnlocked(records, record)) return;
    const proposed = new Map(records.map((item) => [item.deploymentId, item]));
    if (record.active) deactivateScope(proposed, record);
    proposed.set(record.deploymentId, record);
    assertUniqueActiveCustomerAuthAudienceBindings([...proposed.values()]);
    await this.#ensureProductionBeforeAppend(record);
    if (record.active) {
      await Promise.all(
        records
          .filter((existing) => existing.active && sameDeploymentScope(existing, record))
          .map((existing) => this.#writeRecord({ ...existing, active: false })),
      );
    }
    await this.#writeRecord(record);
  }

  async get(deploymentId: string): Promise<DeployRecord | undefined> {
    // An invalid id can never be a file we wrote; treat as absent (also closes off any traversal).
    if (!DEPLOYMENT_ID_PATTERN.test(deploymentId)) return undefined;
    try {
      const text = await readFile(join(this.#dir, `${deploymentId}.json`), 'utf8');
      return sanitizeDeployRecordAppPackageSnapshot(JSON.parse(text) as DeployRecord);
    } catch {
      // Fail-soft: ENOENT (no such server) or a corrupt/unreadable file both read as `undefined`.
      return undefined;
    }
  }

  async getActiveByTenant(ref: TenantRef): Promise<DeployRecord | undefined> {
    return defaultActiveRecord(await this.loadAll(), validateTenantRef(ref));
  }

  async getActiveByTenantVersion(
    ref: TenantRef,
    serverVersion: string,
  ): Promise<DeployRecord | undefined> {
    const safe = validateTenantRef(ref);
    const safeVersion = normalizeServerVersion(serverVersion);
    return (await this.loadAll())
      .filter(
        (record) =>
          record.active &&
          record.archivedAt === undefined &&
          sameTenantRecord(record, safe) &&
          record.serverVersion === safeVersion,
      )
      .sort((a, b) => b.deploymentVersion - a.deploymentVersion)[0];
  }

  setDeploymentLock(
    ref: TenantRef,
    serverVersion: string,
    expectedDeploymentId: string,
    deploymentLock: DeploymentLock | undefined,
  ): Promise<DeploymentLockUpdateResult> {
    const safe = validateTenantRef(ref);
    const safeVersion = normalizeServerVersion(serverVersion);
    return this.#serializeLifecycle(async () => {
      const active = (await this.loadAll()).find(
        (record) =>
          record.active &&
          record.archivedAt === undefined &&
          sameTenantRecord(record, safe) &&
          record.serverVersion === safeVersion,
      );
      if (active === undefined) return { ok: false, reason: 'no_active_deployment' };
      if (active.deploymentId !== expectedDeploymentId) return { ok: false, reason: 'conflict' };
      const changed = (active.deploymentLock === undefined) !== (deploymentLock === undefined);
      if (!changed) return { ok: true, record: active, changed: false };
      const updated =
        deploymentLock === undefined
          ? withoutDeploymentLock(active)
          : { ...active, deploymentLock };
      await this.#writeRecord(updated);
      return { ok: true, record: updated, changed: true };
    });
  }

  async findActiveCustomerAuthAudienceConflict(
    ref: TenantRef,
    auth: TenantAuthConfig,
  ): Promise<TenantRef | undefined> {
    return findActiveCustomerAuthAudienceConflict(
      await this.loadAll(),
      validateTenantRef(ref),
      auth,
    );
  }

  async updateActiveAccess(
    ref: TenantRef,
    deploymentId: string,
    input: ActiveAccessUpdateInput,
  ): Promise<DeployRecord | undefined> {
    const safe = validateTenantRef(ref);
    return this.#serializeLifecycle(async () => {
      const record = await this.get(deploymentId);
      const updated = resolveActiveAccessUpdate(record, safe, input);
      if (updated === undefined || updated === record) return updated;
      const proposed = new Map((await this.loadAll()).map((item) => [item.deploymentId, item])).set(
        updated.deploymentId,
        updated,
      );
      assertUniqueActiveCustomerAuthAudienceBindings([...proposed.values()]);
      await this.#writeRecord(updated);
      return updated;
    });
  }

  async activateDeployment(
    ref: TenantRef,
    deploymentId: string,
    precondition?: {
      readonly expectedAccessMode: AccessMode | undefined;
      readonly serverAuth?: TenantAuthConfig;
    },
  ): Promise<DeploymentActivationResult | undefined> {
    const safe = validateTenantRef(ref);
    if (!DEPLOYMENT_ID_PATTERN.test(deploymentId)) return undefined;
    return this.#serializeLifecycle(async () => {
      const target = await this.get(deploymentId);
      if (target === undefined || !sameTenantRecord(target, safe)) return undefined;
      if (precondition !== undefined && target.accessMode !== precondition.expectedAccessMode) {
        return undefined;
      }
      const records = await this.loadAll();
      assertDeploymentActivationUnlocked(records, target);
      const previousActive = records
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
      const proposed = new Map(records.map((record) => [record.deploymentId, record]));
      if (!alreadyActive) deactivateScope(proposed, target);
      proposed.set(target.deploymentId, activated);
      assertUniqueActiveCustomerAuthAudienceBindings([...proposed.values()]);
      if (!alreadyActive) {
        await Promise.all(
          records
            .filter((record) => record.active && sameTenantRecord(record, safe))
            .filter((record) => sameDeploymentScope(record, target))
            .map((record) => this.#writeRecord({ ...record, active: false })),
        );
      }
      await this.#writeRecord(activated);
      return {
        active: activated,
        ...(previousActive !== undefined ? { previousActive } : {}),
        alreadyActive,
      };
    });
  }

  #serializeLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#lifecycleTail.then(
      () => operation(),
      () => operation(),
    );
    this.#lifecycleTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async loadAll(): Promise<readonly DeployRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.#dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const records: DeployRecord[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue; // skip in-flight *.tmp files
      try {
        const text = await readFile(join(this.#dir, name), 'utf8');
        records.push(sanitizeDeployRecordAppPackageSnapshot(JSON.parse(text) as DeployRecord));
      } catch {
        // Fail-soft: a corrupt/unreadable record file must NOT crash startup — skip it and let the
        // other servers recover. (Visibility of skipped files lands with structured logging, Slice 27.)
      }
    }
    return records;
  }

  async listDeployments(filter: DeploymentListFilter): Promise<readonly DeploymentSummary[]> {
    const safe = validateDeploymentListFilter(filter);
    return (await this.loadAll())
      .filter((record) => matchesDeploymentFilter(record, safe))
      .sort((a, b) => b.deploymentVersion - a.deploymentVersion)
      .map(deploymentSummary);
  }

  async getAppArchivedAt(org: string, app: string): Promise<string | undefined> {
    return appArchivedAt(await this.#appRecords(org, app));
  }

  async archiveApp(org: string, app: string, at: string): Promise<AppArchiveResult | undefined> {
    return this.#serializeLifecycle(() => this.#archiveAppUnlocked(org, app, at));
  }

  async #archiveAppUnlocked(
    org: string,
    app: string,
    at: string,
  ): Promise<AppArchiveResult | undefined> {
    const plan = planAppArchive(await this.#appRecords(org, app), at);
    if (plan === undefined) return undefined;
    await Promise.all(
      plan.stamp.map((record) =>
        this.#writeRecord({ ...record, archivedAt: plan.result.archivedAt }),
      ),
    );
    return plan.result;
  }

  async restoreApp(
    org: string,
    app: string,
    precondition?: AppRestorePrecondition,
  ): Promise<AppRestoreResult | undefined> {
    return this.#serializeLifecycle(() => this.#restoreAppUnlocked(org, app, precondition));
  }

  async #restoreAppUnlocked(
    org: string,
    app: string,
    precondition?: AppRestorePrecondition,
  ): Promise<AppRestoreResult | undefined> {
    const plan = planAppRestore(await this.#appRecords(org, app));
    if (plan === undefined) return undefined;
    assertCustomerAuthRestorePrecondition(plan.clear, precondition);
    const proposed = new Map((await this.loadAll()).map((record) => [record.deploymentId, record]));
    for (const record of plan.clear) {
      proposed.set(record.deploymentId, withoutArchiveStamp(record));
    }
    assertUniqueActiveCustomerAuthAudienceBindings([...proposed.values()]);
    await Promise.all(plan.clear.map((record) => this.#writeRecord(withoutArchiveStamp(record))));
    return plan.result;
  }

  sweepArchived(before: string): Promise<readonly DeployRecord[]> {
    return this.#serializeLifecycle(() => this.#sweepArchivedUnlocked(before));
  }

  async #sweepArchivedUnlocked(before: string): Promise<readonly DeployRecord[]> {
    const deleted = planArchivedAppSweep(await this.loadAll(), before);
    await Promise.all(
      deleted.map((record) => rm(join(this.#dir, `${record.deploymentId}.json`), { force: true })),
    );
    return deleted;
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
      productionEnvironment: await this.#productionEnvironment(safeOrg, safeApp, records),
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
    const appRecords = await this.#appRecords(safeOrg, safeApp);
    return summarizeEnvs(safeOrg, safeApp, records, [], {
      includeArchived: true,
      productionEnvironment: await this.#productionEnvironment(safeOrg, safeApp, appRecords),
    })[0];
  }

  async setProductionEnvironment(
    org: string,
    app: string,
    env: string,
  ): Promise<ProductionEnvironmentChange | undefined> {
    const safeOrg = validateSlug('org', org);
    const safeApp = validateSlug('app', app);
    const safeEnv = validateSlug('env', env);
    const records = await this.#appRecords(safeOrg, safeApp);
    const envNames = new Set(records.map((record) => record.environment));
    if (!envNames.has(safeEnv)) return undefined;
    const previous = await this.#productionEnvironment(safeOrg, safeApp, records);
    await this.#writeProductionEnvironment(safeOrg, safeApp, safeEnv);
    return {
      orgSlug: safeOrg,
      appSlug: safeApp,
      productionEnvironment: safeEnv,
      previousProductionEnvironment: previous ?? null,
      changed: previous !== safeEnv,
    };
  }

  async getDeployment(org: string, deploymentId: string): Promise<DeploymentSummary | undefined> {
    const safeOrg = validateSlug('org', org);
    const record = await this.get(deploymentId);
    if (record === undefined || record.orgSlug !== safeOrg) return undefined;
    return deploymentSummary(record);
  }

  async #appRecords(org: string, app: string): Promise<readonly DeployRecord[]> {
    const safeOrg = validateSlug('org', org);
    const safeApp = validateSlug('app', app);
    return (await this.loadAll()).filter(
      (record) => record.orgSlug === safeOrg && record.appSlug === safeApp,
    );
  }

  async #writeRecord(record: DeployRecord): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    const target = join(this.#dir, `${record.deploymentId}.json`);
    const tmp = `${target}.${randomUUID()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    await rename(tmp, target);
  }

  async #ensureProductionBeforeAppend(record: DeployRecord): Promise<void> {
    const existing = await this.#appRecords(record.orgSlug, record.appSlug);
    const explicit = await this.#readProductionEnvironment(record.orgSlug, record.appSlug);
    if (explicit !== undefined) return;
    const envNames = new Set(existing.map((item) => item.environment));
    const production =
      envNames.size === 0 ? record.environment : resolveProductionEnvironment(envNames);
    await this.#writeProductionEnvironment(record.orgSlug, record.appSlug, production ?? null);
  }

  async #productionEnvironment(
    org: string,
    app: string,
    records: readonly { readonly environment: string }[],
  ): Promise<string | null | undefined> {
    const envNames = new Set(records.map((record) => record.environment));
    const explicit = await this.#readProductionEnvironment(org, app);
    return explicit === null ? null : resolveProductionEnvironment(envNames, explicit);
  }

  async #readProductionEnvironment(org: string, app: string): Promise<string | null | undefined> {
    try {
      const text = await readFile(join(this.#environmentMetadataDir, org, `${app}.json`), 'utf8');
      const value = JSON.parse(text) as { readonly productionEnvironment?: unknown };
      if (value.productionEnvironment === null) return null;
      return typeof value.productionEnvironment === 'string'
        ? validateSlug('env', value.productionEnvironment)
        : undefined;
    } catch {
      return undefined;
    }
  }

  async #writeProductionEnvironment(org: string, app: string, env: string | null): Promise<void> {
    const dir = join(this.#environmentMetadataDir, org);
    await mkdir(dir, { recursive: true });
    const target = join(dir, `${app}.json`);
    const tmp = `${target}.${randomUUID()}.tmp`;
    await writeFile(
      tmp,
      `${JSON.stringify({ schemaVersion: 1, productionEnvironment: env }, null, 2)}\n`,
      'utf8',
    );
    await rename(tmp, target);
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
