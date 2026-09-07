import type { NamedDeploymentActivationHook } from '@noodle-borg/module';
import type { Pool } from 'pg';
import { pausePostgresInstallations } from '../business-information/postgres-application-lifecycle.js';
import {
  assertCustomerAuthRestorePrecondition,
  translateCustomerAuthAudienceDatabaseError,
} from '../customer-auth-audience-binding.js';
import {
  assertPreparedDeploymentActivation,
  prepareDeploymentActivation,
} from '../modules/context.js';
import type {
  AppArchiveResult,
  AppRestorePrecondition,
  AppRestoreResult,
  AppSummary,
  DeployRecord,
} from '../store.js';
import { validateSlug } from '../store.js';
import {
  DEPLOY_SUMMARY_COLUMNS,
  type DeployRow,
  type DeploySummaryRow,
  rowToDeploymentSummary,
  rowToRecord,
} from './postgres-rows.js';
import {
  type AppAnchor,
  paginateAppSummaries,
  planArchivedAppSweep,
  summarizeApps,
} from './records.js';

/**
 * Postgres backing for the `apps` resource (`ArtifactStore.listApps`/`getApp`), extracted from
 * `postgres.ts` to keep that file under the size gate. Reads the org's deployment metadata
 * plus its `apps` anchor rows (the only backend where an app can exist with zero deploy records because
 * an anchor may be created deliberately before a deployment). Retention purge removes the anchors it
 * created for a fully expired app. Grouping/ranking/sort math delegates to the shared, pure `summarizeApps`.
 */

interface AppAnchorRow {
  readonly slug: string;
  readonly created_at: Date;
}

/** Aggregate row for {@link PostgresArtifactStore.getAppArchivedAt}. */
interface AppArchiveCountRow {
  readonly total: number;
  readonly archived: number;
  readonly latest: Date | null;
}

function toAnchor(row: AppAnchorRow): AppAnchor {
  return { appSlug: row.slug, createdAt: new Date(row.created_at).toISOString() };
}

type AppQuery = Pick<Pool, 'query'>;

async function orgAnchors(pool: AppQuery, org: string): Promise<readonly AppAnchor[]> {
  const { rows } = await pool.query<AppAnchorRow>(
    'SELECT slug, created_at FROM apps WHERE org_slug = $1',
    [org],
  );
  return rows.map(toAnchor);
}

export async function listAppsRows(
  pool: AppQuery,
  org: string,
  opts: { readonly includeArchived?: boolean; readonly limit?: number },
): Promise<{ readonly apps: readonly AppSummary[]; readonly truncated: boolean }> {
  const safeOrg = validateSlug('org', org);
  const { rows } = await pool.query<DeploySummaryRow>(
    `SELECT ${DEPLOY_SUMMARY_COLUMNS} FROM deploy_records WHERE org_slug = $1 ORDER BY deployment_version DESC`,
    [safeOrg],
  );
  const records = rows.map(rowToDeploymentSummary);
  const anchors = await orgAnchors(pool, safeOrg);
  const summarized = summarizeApps(safeOrg, records, anchors, {
    includeArchived: opts.includeArchived ?? false,
  });
  return paginateAppSummaries(summarized, opts.limit);
}

export async function getAppRow(
  pool: AppQuery,
  org: string,
  app: string,
): Promise<AppSummary | undefined> {
  const safeOrg = validateSlug('org', org);
  const safeApp = validateSlug('app', app);
  const { rows } = await pool.query<DeploySummaryRow>(
    `SELECT ${DEPLOY_SUMMARY_COLUMNS} FROM deploy_records WHERE org_slug = $1 AND app_slug = $2 ORDER BY deployment_version DESC`,
    [safeOrg, safeApp],
  );
  const records = rows.map(rowToDeploymentSummary);
  const { rows: anchorRows } = await pool.query<AppAnchorRow>(
    'SELECT slug, created_at FROM apps WHERE org_slug = $1 AND slug = $2',
    [safeOrg, safeApp],
  );
  if (records.length === 0 && anchorRows.length === 0) return undefined;
  return summarizeApps(safeOrg, records, anchorRows.map(toAnchor), { includeArchived: true })[0];
}

export async function getAppArchivedAtRow(
  pool: AppQuery,
  org: string,
  app: string,
): Promise<string | undefined> {
  const { rows } = await pool.query<AppArchiveCountRow>(
    `SELECT count(*)::int AS total, count(archived_at)::int AS archived, max(archived_at) AS latest
     FROM deploy_records
     WHERE org_slug = $1 AND app_slug = $2`,
    [validateSlug('org', org), validateSlug('app', app)],
  );
  const row = rows[0];
  if (row === undefined || row.total === 0 || row.archived !== row.total || row.latest === null) {
    return undefined;
  }
  return new Date(row.latest).toISOString();
}

export async function archiveAppRows(
  pool: Pool,
  org: string,
  app: string,
  at: string,
): Promise<AppArchiveResult | undefined> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const safeOrg = validateSlug('org', org);
    const safeApp = validateSlug('app', app);
    const parent = await client.query(
      `SELECT slug FROM apps
       WHERE org_slug = $1 AND slug = $2
       FOR UPDATE`,
      [safeOrg, safeApp],
    );
    if (parent.rows[0] === undefined) {
      await client.query('ROLLBACK');
      return undefined;
    }
    const { rowCount } = await client.query(
      `UPDATE deploy_records
       SET archived_at = $3::timestamptz
       WHERE org_slug = $1 AND app_slug = $2 AND archived_at IS NULL`,
      [safeOrg, safeApp, at],
    );
    const business = await client.query<{ present: boolean }>(
      `SELECT to_regclass('business_solution_installations') IS NOT NULL AS present`,
    );
    if (business.rows[0]?.present) await pausePostgresInstallations(client, safeOrg, safeApp, at);
    const archivedDeployments = rowCount ?? 0;
    if (archivedDeployments > 0) {
      await client.query('COMMIT');
      return { archivedAt: at, archivedDeployments, alreadyArchived: false };
    }
    // Nothing stamped: either the app is already fully archived (no-op, original stamp preserved so
    // the retention clock never resets — ADR 0117 §5) or it has no records at all.
    const existing = await getAppArchivedAtRow(client, safeOrg, safeApp);
    await client.query('COMMIT');
    if (existing === undefined) return undefined;
    return { archivedAt: existing, archivedDeployments: 0, alreadyArchived: true };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw translateCustomerAuthAudienceDatabaseError(error);
  } finally {
    client.release();
  }
}

/** Restore one logical app while serializing its production-capacity decision with activation. */
export async function restoreAppRows(
  pool: Pool,
  org: string,
  app: string,
  precondition?: AppRestorePrecondition,
  activationHooks: readonly NamedDeploymentActivationHook[] = [],
): Promise<AppRestoreResult | undefined> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const safeOrg = validateSlug('org', org);
    const safeApp = validateSlug('app', app);
    const parent = await client.query(
      `SELECT slug FROM apps
       WHERE org_slug = $1 AND slug = $2
       FOR UPDATE`,
      [safeOrg, safeApp],
    );
    if (parent.rows[0] === undefined) {
      await client.query('ROLLBACK');
      return undefined;
    }
    const preparedActivation = await prepareDeploymentActivation(client, activationHooks, {
      operation: 'restore',
      org: safeOrg,
      app: safeApp,
    });
    const exists = await client.query(
      'SELECT 1 FROM deploy_records WHERE org_slug = $1 AND app_slug = $2 LIMIT 1',
      [safeOrg, safeApp],
    );
    if (exists.rows[0] === undefined) {
      await client.query('ROLLBACK');
      return undefined;
    }
    const locked = await client.query<DeployRow>(
      `SELECT *
       FROM deploy_records
       WHERE org_slug = $1 AND app_slug = $2
       FOR UPDATE`,
      [safeOrg, safeApp],
    );
    const archived = locked.rows.filter((row) => row.archived_at !== null);
    if (archived.length === 0) {
      await client.query('COMMIT');
      return { restoredDeployments: 0 };
    }
    const restoresActiveDeployment = archived.some((row) => row.active);
    assertCustomerAuthRestorePrecondition(archived.map(rowToRecord), precondition);
    if (restoresActiveDeployment) await assertPreparedDeploymentActivation(preparedActivation);
    const { rowCount } = await client.query(
      `UPDATE deploy_records
       SET archived_at = NULL
       WHERE org_slug = $1 AND app_slug = $2 AND archived_at IS NOT NULL`,
      [safeOrg, safeApp],
    );
    await client.query('COMMIT');
    return { restoredDeployments: rowCount ?? 0 };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw translateCustomerAuthAudienceDatabaseError(error);
  } finally {
    client.release();
  }
}

interface SweepCandidateRow {
  readonly org_slug: string;
  readonly slug: string;
}

/** Delete fully expired apps and their deployment/environment anchors under one parent-row lock. */
export async function sweepArchivedAppRows(
  pool: Pool,
  before: string,
): Promise<readonly DeployRecord[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const candidates = await client.query<SweepCandidateRow>(
      `SELECT app.org_slug, app.slug
       FROM apps app
       WHERE EXISTS (
         SELECT 1 FROM deploy_records deployment
         WHERE deployment.org_slug = app.org_slug AND deployment.app_slug = app.slug
       )
         AND NOT EXISTS (
           SELECT 1 FROM deploy_records deployment
           WHERE deployment.org_slug = app.org_slug
             AND deployment.app_slug = app.slug
             AND (deployment.archived_at IS NULL OR deployment.archived_at >= $1::timestamptz)
         )
       ORDER BY app.org_slug, app.slug
       FOR UPDATE OF app`,
      [before],
    );
    const deleted = [];
    for (const candidate of candidates.rows) {
      const locked = await client.query<DeployRow>(
        `SELECT * FROM deploy_records
         WHERE org_slug = $1 AND app_slug = $2
         ORDER BY deployment_id
         FOR UPDATE`,
        [candidate.org_slug, candidate.slug],
      );
      const appRecords = locked.rows.map(rowToRecord);
      if (planArchivedAppSweep(appRecords, before).length !== appRecords.length) continue;
      const removed = await client.query<DeployRow>(
        `DELETE FROM deploy_records
         WHERE org_slug = $1 AND app_slug = $2
         RETURNING *`,
        [candidate.org_slug, candidate.slug],
      );
      const business = await client.query<{ present: boolean }>(
        `SELECT to_regclass('business_solution_installations') IS NOT NULL AS present`,
      );
      if (business.rows[0]?.present)
        await pausePostgresInstallations(
          client,
          candidate.org_slug,
          candidate.slug,
          new Date().toISOString(),
          true,
        );
      deleted.push(...removed.rows.map(rowToRecord));
      await client.query('DELETE FROM apps WHERE org_slug = $1 AND slug = $2', [
        candidate.org_slug,
        candidate.slug,
      ]);
    }
    await client.query('COMMIT');
    return deleted;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
