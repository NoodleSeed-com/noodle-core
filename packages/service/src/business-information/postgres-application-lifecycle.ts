import type { Pool, PoolClient } from 'pg';
import type { InstallationScope } from './contracts.js';
import { inTransaction } from './postgres-transaction.js';

/** The app row is locked before installations, matching archive/restore/deployment ordering. */
export async function lockInstallationApplication(client: PoolClient, scope: InstallationScope) {
  const available = await client.query<{ present: boolean }>(
    `SELECT to_regclass('apps') IS NOT NULL AS present`,
  );
  // Owner-layer standalone storage fixtures have no executable application authority.
  if (!available.rows[0]?.present) return { enforced: false, active: false } as const;
  const app = await client.query<{ generation: string }>(
    `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS generation FROM apps WHERE org_slug=$1 AND slug=$2 FOR SHARE`,
    [scope.org, scope.app],
  );
  const generation = app.rows[0]?.generation;
  const deployment =
    generation === undefined
      ? undefined
      : await client.query(
          `SELECT deployment_id FROM deploy_records WHERE org_slug=$1 AND app_slug=$2
      AND environment=$3 AND active AND archived_at IS NULL LIMIT 1`,
          [scope.org, scope.app, scope.env],
        );
  return { enforced: true, generation, active: (deployment?.rowCount ?? 0) > 0 } as const;
}

export async function bindPostgresInstallationApplication(
  pool: Pool,
  scope: InstallationScope,
  generation: string,
): Promise<boolean> {
  if (!Number.isFinite(Date.parse(generation))) return false;
  return inTransaction(pool, async (client) => {
    const application = await lockInstallationApplication(client, scope);
    if (!application.active || application.generation !== generation) return false;
    const result = await client.query<{
      application_generation: string | null;
      generation_predates_installation: boolean;
    }>(
      `SELECT application_generation,created_at >= $5::timestamptz AS generation_predates_installation FROM business_solution_installations
       WHERE org_slug=$1 AND app_slug=$2 AND environment=$3 AND installation_id=$4 FOR UPDATE`,
      [scope.org, scope.app, scope.env, scope.installationId, generation],
    );
    const row = result.rows[0];
    if (!row) return false;
    if (row.application_generation === generation) return true;
    if (
      row.application_generation !== 'pending' &&
      (row.application_generation !== null || !row.generation_predates_installation)
    )
      return false;
    await client.query(
      `UPDATE business_solution_installations SET application_generation=$5
       WHERE org_slug=$1 AND app_slug=$2 AND environment=$3 AND installation_id=$4`,
      [scope.org, scope.app, scope.env, scope.installationId, generation],
    );
    return true;
  });
}

/** Pausing never grants payload authority and never deletes retained records or grants. */
export async function pausePostgresInstallations(
  pool: Pick<Pool, 'query'>,
  org: string,
  app: string,
  at: string,
  retired = false,
) {
  await pool.query(
    `UPDATE business_solution_installations SET intake_active=false,revision=revision+1,
      updated_at=$3,updated_by_subject=CASE WHEN $4 THEN 'noodle:application-purge' ELSE 'noodle:application-archive' END,
      application_generation=CASE WHEN $4 THEN 'retired' ELSE application_generation END
     WHERE org_slug=$1 AND app_slug=$2 AND (intake_active OR ($4 AND application_generation IS DISTINCT FROM 'retired'))`,
    [org, app, at, retired],
  );
}
