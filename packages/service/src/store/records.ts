/**
 * Pure record-level helpers shared by every {@link ArtifactStore} backend: the canonical
 * deployment-summary mapping, list filtering, app archive/restore planning (ADR 0117), and the
 * `apps` resource aggregation (`summarizeApps`). No I/O here — backends apply the plans to their
 * own persistence and feed their own raw records/anchors through these pure functions so every
 * backend groups, ranks, and sorts identically.
 */

import { requiresCustomerAuthProjection } from '../customer-auth-audience-binding.js';
import { sameTenantRecord } from '../deployment-versioning.js';
import { deploymentOwnerSubject } from '../registry-helpers.js';
import type {
  ActiveAccessUpdateInput,
  AppArchiveResult,
  AppRestoreResult,
  AppSummary,
  DeploymentListFilter,
  DeploymentSummary,
  DeployRecord,
  EnvSummary,
  TenantRef,
} from '../store.js';
import { validateSlug } from './validate.js';

/** Metadata needed for summaries; payloads and credential material never need to be loaded. */
export type DeploymentMetadata = Omit<
  DeployRecord,
  'manifest' | 'connectors' | 'hostedAssets' | 'secrets' | 'serverAuth' | 'appPackageSnapshot'
>;

/** The canonical, secret-free list projection of a {@link DeployRecord}. */
export function deploymentSummary(record: DeploymentMetadata): DeploymentSummary {
  const ownerSubject = deploymentOwnerSubject(record);
  return {
    deploymentId: record.deploymentId,
    orgSlug: record.orgSlug,
    appSlug: record.appSlug,
    environment: record.environment,
    ...(record.serverVersion !== undefined ? { serverVersion: record.serverVersion } : {}),
    active: record.active,
    serverName: record.serverName,
    createdAt: record.createdAt,
    ...(record.createdByEmail !== undefined ? { createdByEmail: record.createdByEmail } : {}),
    ...(ownerSubject !== undefined ? { ownerSubject } : {}),
    ...(record.deploymentSource !== undefined ? { deploymentSource: record.deploymentSource } : {}),
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
    ...(record.archivedAt !== undefined ? { archivedAt: record.archivedAt } : {}),
  };
}

/** Validate a deployments-list filter's slugs; archived records are excluded unless opted in. */
export function validateDeploymentListFilter(filter: DeploymentListFilter): DeploymentListFilter {
  return {
    org: validateSlug('org', filter.org),
    ...(filter.app !== undefined ? { app: validateSlug('app', filter.app) } : {}),
    ...(filter.env !== undefined ? { env: validateSlug('env', filter.env) } : {}),
    ...(filter.includeArchived === true ? { includeArchived: true } : {}),
  };
}

/** Whether a record belongs in a (pre-validated) deployments list. */
export function matchesDeploymentFilter(
  record: DeployRecord,
  filter: DeploymentListFilter,
): boolean {
  return (
    record.orgSlug === filter.org &&
    (filter.app === undefined || record.appSlug === filter.app) &&
    (filter.env === undefined || record.environment === filter.env) &&
    (filter.includeArchived === true || record.archivedAt === undefined)
  );
}

/**
 * The app's archived stamp: defined iff the app has at least one record and **every** record is
 * stamped. The latest stamp wins — it is the retention clock (ADR 0117 §6).
 */
export function appArchivedAt(records: readonly DeployRecord[]): string | undefined {
  if (records.length === 0) return undefined;
  let latest: string | undefined;
  for (const record of records) {
    if (record.archivedAt === undefined) return undefined;
    if (latest === undefined || record.archivedAt > latest) latest = record.archivedAt;
  }
  return latest;
}

/**
 * Plan an app archive over the app's records (all environments/versions): which records to stamp
 * plus the caller-facing result. `undefined` when the app has no records at all. Re-archiving an
 * already-archived app is a no-op that preserves the original stamp (the retention clock never
 * resets — ADR 0117 §5).
 */
export function planAppArchive(
  records: readonly DeployRecord[],
  at: string,
): { readonly result: AppArchiveResult; readonly stamp: readonly DeployRecord[] } | undefined {
  if (records.length === 0) return undefined;
  const stamp = records.filter((record) => record.archivedAt === undefined);
  if (stamp.length === 0) {
    return {
      result: {
        archivedAt: appArchivedAt(records) as string,
        archivedDeployments: 0,
        alreadyArchived: true,
      },
      stamp,
    };
  }
  return {
    result: { archivedAt: at, archivedDeployments: stamp.length, alreadyArchived: false },
    stamp,
  };
}

/** Plan an app restore: which records to clear. `undefined` when the app has no records at all. */
export function planAppRestore(
  records: readonly DeployRecord[],
): { readonly result: AppRestoreResult; readonly clear: readonly DeployRecord[] } | undefined {
  if (records.length === 0) return undefined;
  const clear = records.filter((record) => record.archivedAt !== undefined);
  return { result: { restoredDeployments: clear.length }, clear };
}

/** Plan a retention sweep: only delete an app when every deployment is archived before the cutoff. */
export function planArchivedAppSweep(
  records: readonly DeployRecord[],
  before: string,
): readonly DeployRecord[] {
  const apps = new Map<string, Map<string, DeployRecord[]>>();
  for (const record of records) {
    let byApp = apps.get(record.orgSlug);
    if (byApp === undefined) {
      byApp = new Map();
      apps.set(record.orgSlug, byApp);
    }
    const bucket = byApp.get(record.appSlug);
    if (bucket === undefined) byApp.set(record.appSlug, [record]);
    else bucket.push(record);
  }
  return [...apps.values()].flatMap((byApp) =>
    [...byApp.values()].flatMap((appRecords) =>
      appRecords.length > 0 &&
      appRecords.every((record) => record.archivedAt !== undefined && record.archivedAt < before)
        ? appRecords
        : [],
    ),
  );
}

/** Strip the archive stamp from a record (exact-optional safe). */
export function withoutArchiveStamp(record: DeployRecord): DeployRecord {
  const { archivedAt: _cleared, ...rest } = record;
  return rest;
}

export function preserveDeploymentOwnerState(
  existing: DeployRecord,
  candidate: DeployRecord,
): DeployRecord {
  const { ownerSubject: _candidateOwnerSubject, ...deployFields } = candidate;
  return {
    ...deployFields,
    ...(existing.ownerSubject !== undefined ? { ownerSubject: existing.ownerSubject } : {}),
  };
}

export function resolveActiveAccessUpdate(
  record: DeployRecord | undefined,
  ref: TenantRef,
  input: ActiveAccessUpdateInput,
): DeployRecord | undefined {
  if (
    record === undefined ||
    !record.active ||
    record.archivedAt !== undefined ||
    !sameTenantRecord(record, ref) ||
    record.accessMode !== input.expectedAccessMode ||
    record.schemaVersion !== (input.expectedSchemaVersion ?? 1) ||
    (input.expectedManifest !== undefined && record.manifest !== input.expectedManifest) ||
    deploymentOwnerSubject(record) !== input.expectedOwnerSubject
  )
    return undefined;
  if (
    (record.accessMode ?? 'owner-only') === input.accessMode &&
    (input.schemaVersion === undefined || record.schemaVersion === input.schemaVersion) &&
    (input.ownerSubject === undefined || deploymentOwnerSubject(record) === input.ownerSubject) &&
    !requiresCustomerAuthProjection(
      {
        ...record,
        accessMode: input.accessMode,
        schemaVersion: input.schemaVersion ?? record.schemaVersion,
      },
      input.serverAuth,
    )
  )
    return record;
  return {
    ...record,
    accessMode: input.accessMode,
    schemaVersion: input.schemaVersion ?? record.schemaVersion,
    ...(input.ownerSubject !== undefined ? { ownerSubject: input.ownerSubject } : {}),
    ...(requiresCustomerAuthProjection(
      {
        ...record,
        accessMode: input.accessMode,
        schemaVersion: input.schemaVersion ?? record.schemaVersion,
      },
      input.serverAuth,
    ) && input.serverAuth !== undefined
      ? { serverAuth: input.serverAuth }
      : {}),
  };
}

/**
 * One org's app-anchor row: `{appSlug, createdAt}` for an app that exists even with zero deploy
 * records. Only Postgres has a real `apps` table to source these from; deliberate zero-deployment
 * anchors may exist independently, while retention purge removes the app anchors it created for
 * fully expired apps. The in-memory and json-file backends have no separate anchor concept, so they
 * always pass `[]`.
 */
export interface AppAnchor {
  readonly appSlug: string;
  readonly createdAt: string;
}

const ENVIRONMENT_RANK: Readonly<Record<string, number>> = { prod: 0, staging: 1, dev: 2 };

function environmentRank(environment: string): number {
  return ENVIRONMENT_RANK[environment] ?? 3;
}

/** The deployment an app "faces" as: the newest active record across every env, or — with no
 * active record at all — the newest record overall. */
function facingDeployment(records: readonly DeploymentSummary[]): DeploymentSummary {
  const active = records.filter((candidate) => candidate.active);
  const pool = active.length > 0 ? active : records;
  return pool.reduce((newest, candidate) =>
    candidate.createdAt > newest.createdAt ? candidate : newest,
  );
}

function rankedEnvironments(records: readonly DeploymentSummary[]): readonly string[] {
  return [...new Set(records.map((candidate) => candidate.environment))].sort(
    (a, b) => environmentRank(a) - environmentRank(b) || a.localeCompare(b),
  );
}

function earliestCreatedAt(records: readonly DeploymentSummary[]): string {
  return records
    .map((candidate) => candidate.createdAt)
    .reduce((earliest, createdAt) => (createdAt < earliest ? createdAt : earliest));
}

function latestCreatedAt(records: readonly DeploymentSummary[]): string {
  return records
    .map((candidate) => candidate.createdAt)
    .reduce((latest, createdAt) => (createdAt > latest ? createdAt : latest));
}

/**
 * Group an org's raw deploy records (+ any empty-anchor apps) into one {@link AppSummary} per app —
 * the canonical `apps` resource aggregation, shared by every {@link ArtifactStore} backend so the
 * facing-deployment pick, environment ranking, and app sort order can never drift between them.
 * `records` should already be scoped to `org` and include archived records (`includeArchived: true`
 * at the backend's raw read) — this function does the archived-app filtering itself, from each app's
 * *facing* record, since an archived app has every one of its records stamped (ADR 0117).
 */
export function summarizeApps(
  org: string,
  records: readonly DeploymentSummary[],
  anchors: readonly AppAnchor[],
  opts: { readonly includeArchived: boolean },
): AppSummary[] {
  const byApp = new Map<string, DeploymentSummary[]>();
  for (const candidate of records) {
    const bucket = byApp.get(candidate.appSlug);
    if (bucket !== undefined) bucket.push(candidate);
    else byApp.set(candidate.appSlug, [candidate]);
  }
  const appSlugs = new Set(byApp.keys());
  for (const anchor of anchors) appSlugs.add(anchor.appSlug);

  const summaries: AppSummary[] = [];
  for (const appSlug of appSlugs) {
    const appRecords = byApp.get(appSlug);
    if (appRecords === undefined) {
      const anchor = anchors.find((candidate) => candidate.appSlug === appSlug);
      if (anchor === undefined) continue; // unreachable: every slug came from byApp or anchors
      summaries.push({
        orgSlug: org,
        appSlug,
        environments: [],
        active: false,
        createdAt: anchor.createdAt,
      });
      continue;
    }
    const facing = facingDeployment(appRecords);
    if (facing.archivedAt !== undefined && !opts.includeArchived) continue;
    summaries.push({
      orgSlug: org,
      appSlug,
      environments: rankedEnvironments(appRecords),
      latest: facing,
      accessMode: facing.accessMode,
      active: facing.active,
      ...(facing.archivedAt !== undefined ? { archivedAt: facing.archivedAt } : {}),
      createdAt: earliestCreatedAt(appRecords),
      lastActivityAt: latestCreatedAt(appRecords),
    });
  }
  return summaries.sort(compareAppSummaries);
}

/** Sort by last activity desc; apps with no activity (empty anchors) sort last; ties by slug asc. */
function compareAppSummaries(a: AppSummary, b: AppSummary): number {
  if (a.lastActivityAt === undefined || b.lastActivityAt === undefined) {
    if (a.lastActivityAt === b.lastActivityAt) return a.appSlug.localeCompare(b.appSlug);
    return a.lastActivityAt === undefined ? 1 : -1;
  }
  if (a.lastActivityAt !== b.lastActivityAt) return a.lastActivityAt > b.lastActivityAt ? -1 : 1;
  return a.appSlug.localeCompare(b.appSlug);
}

/** Default + hard cap for a single `apps` list page (the route surfaces `truncated`, never drops silently). */
const DEFAULT_APPS_LIMIT = 200;

/** Cap an already-sorted {@link AppSummary} list at `limit` (default {@link DEFAULT_APPS_LIMIT}). */
export function paginateAppSummaries(
  apps: readonly AppSummary[],
  limit: number | undefined,
): { readonly apps: readonly AppSummary[]; readonly truncated: boolean } {
  const safeLimit = limit ?? DEFAULT_APPS_LIMIT;
  return { apps: apps.slice(0, safeLimit), truncated: apps.length > safeLimit };
}

/**
 * One app's env-anchor row: `{envName, createdAt}` for an environment that exists even with zero
 * deploy records. Mirrors {@link AppAnchor} — only Postgres has a real `environments` table to source
 * these from; deliberate zero-deployment anchors may exist independently, while retention purge
 * removes the environment anchors it created for fully expired apps. The in-memory and json-file
 * backends have no separate anchor concept, so they always pass `[]`.
 */
export interface EnvAnchor {
  readonly envName: string;
  readonly createdAt: string;
}

/** Deterministic legacy migration: explicit marker, conventional `prod`, sole env, or unresolved. */
export function resolveProductionEnvironment(
  envNames: ReadonlySet<string>,
  explicit?: string | null,
): string | undefined {
  if (explicit !== undefined) {
    return explicit !== null && envNames.has(explicit) ? explicit : undefined;
  }
  if (envNames.has('prod')) return 'prod';
  if (envNames.size === 1) return envNames.values().next().value as string;
  return undefined;
}

/**
 * Group one app's raw deploy records (+ any empty-anchor envs) into one {@link EnvSummary} per
 * environment — the `envs` resource aggregation, shared by every {@link ArtifactStore} backend so the
 * facing-deployment pick and archived-env filtering can never drift between them. `records` should
 * already be scoped to `org`/`app` and include archived records (`includeArchived: true` at the
 * backend's raw read) — this function does the archived-env filtering itself, from each env's *facing*
 * record. Unlike {@link summarizeApps}, envs are ordered with the designated production environment
 * first, then alphabetically rather than by recency.
 */
export function summarizeEnvs(
  org: string,
  app: string,
  records: readonly DeploymentSummary[],
  anchors: readonly EnvAnchor[],
  opts: {
    readonly includeArchived: boolean;
    readonly productionEnvironment?: string | null | undefined;
  },
): EnvSummary[] {
  const byEnv = new Map<string, DeploymentSummary[]>();
  for (const candidate of records) {
    const bucket = byEnv.get(candidate.environment);
    if (bucket !== undefined) bucket.push(candidate);
    else byEnv.set(candidate.environment, [candidate]);
  }
  const envNames = new Set(byEnv.keys());
  for (const anchor of anchors) envNames.add(anchor.envName);
  const productionEnvironment = resolveProductionEnvironment(envNames, opts.productionEnvironment);

  const summaries: EnvSummary[] = [];
  for (const envName of envNames) {
    const envRecords = byEnv.get(envName);
    if (envRecords === undefined) {
      const anchor = anchors.find((candidate) => candidate.envName === envName);
      if (anchor === undefined) continue; // unreachable: every name came from byEnv or anchors
      summaries.push({
        orgSlug: org,
        appSlug: app,
        envName,
        isProduction: envName === productionEnvironment,
        active: false,
        createdAt: anchor.createdAt,
        deploymentCount: 0,
      });
      continue;
    }
    const facing = facingDeployment(envRecords);
    if (facing.archivedAt !== undefined && !opts.includeArchived) continue;
    const counted = opts.includeArchived
      ? envRecords
      : envRecords.filter((candidate) => candidate.archivedAt === undefined);
    summaries.push({
      orgSlug: org,
      appSlug: app,
      envName,
      isProduction: envName === productionEnvironment,
      latest: facing,
      accessMode: facing.accessMode,
      active: facing.active,
      ...(facing.archivedAt !== undefined ? { archivedAt: facing.archivedAt } : {}),
      createdAt: earliestCreatedAt(envRecords),
      lastActivityAt: latestCreatedAt(envRecords),
      deploymentCount: counted.length,
    });
  }
  return summaries.sort(compareEnvSummaries);
}

/** Production first, then alphabetically — never sorted by recency. */
function compareEnvSummaries(a: EnvSummary, b: EnvSummary): number {
  return Number(b.isProduction) - Number(a.isProduction) || a.envName.localeCompare(b.envName);
}
