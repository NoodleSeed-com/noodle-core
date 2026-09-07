import type { Pool } from 'pg';
import type { EnvSummary, ProductionEnvironmentChange } from '../store.js';
import { validateSlug } from '../store.js';
import {
  DEPLOY_SUMMARY_COLUMNS,
  type DeploySummaryRow,
  rowToDeploymentSummary,
} from './postgres-rows.js';
import { type EnvAnchor, resolveProductionEnvironment, summarizeEnvs } from './records.js';

/**
 * Postgres backing for the `envs` resource (`ArtifactStore.listEnvironments`/`getEnvironment`),
 * extracted from `postgres.ts` to keep that file under the size gate — mirrors `postgres-apps.ts`.
 * Reads deployment metadata plus `environments` anchor rows (the only backend where
 * an env can exist with zero deploy records because an anchor may be created deliberately before a
 * deployment). Retention purge removes the anchors it created for a fully expired app, then grouping and
 * ranking delegate to the shared, pure `summarizeEnvs`.
 */

interface EnvAnchorRow {
  readonly name: string;
  readonly is_production: boolean;
  readonly created_at: Date;
}

function toAnchor(row: EnvAnchorRow): EnvAnchor {
  return { envName: row.name, createdAt: new Date(row.created_at).toISOString() };
}

async function appEnvAnchors(
  pool: Pool,
  org: string,
  app: string,
): Promise<{
  readonly anchors: readonly EnvAnchor[];
  readonly productionEnvironment: string | null;
}> {
  const { rows } = await pool.query<EnvAnchorRow>(
    'SELECT name, is_production, created_at FROM environments WHERE org_slug = $1 AND app_slug = $2',
    [org, app],
  );
  return {
    anchors: rows.map(toAnchor),
    productionEnvironment:
      resolveProductionEnvironment(
        new Set(rows.map((row) => row.name)),
        rows.find((row) => row.is_production)?.name ?? null,
      ) ?? null,
  };
}

export async function listEnvironmentsRows(
  pool: Pool,
  org: string,
  app: string,
  opts: { readonly includeArchived?: boolean },
): Promise<readonly EnvSummary[]> {
  const safeOrg = validateSlug('org', org);
  const safeApp = validateSlug('app', app);
  const { rows } = await pool.query<DeploySummaryRow>(
    `SELECT ${DEPLOY_SUMMARY_COLUMNS} FROM deploy_records WHERE org_slug = $1 AND app_slug = $2 ORDER BY deployment_version DESC`,
    [safeOrg, safeApp],
  );
  const records = rows.map(rowToDeploymentSummary);
  const metadata = await appEnvAnchors(pool, safeOrg, safeApp);
  return summarizeEnvs(safeOrg, safeApp, records, metadata.anchors, {
    includeArchived: opts.includeArchived ?? false,
    productionEnvironment: metadata.productionEnvironment,
  });
}

export async function getEnvironmentRow(
  pool: Pool,
  org: string,
  app: string,
  env: string,
): Promise<EnvSummary | undefined> {
  const safeOrg = validateSlug('org', org);
  const safeApp = validateSlug('app', app);
  const safeEnv = validateSlug('env', env);
  const { rows } = await pool.query<DeploySummaryRow>(
    `SELECT ${DEPLOY_SUMMARY_COLUMNS} FROM deploy_records WHERE org_slug = $1 AND app_slug = $2 AND environment = $3 ORDER BY deployment_version DESC`,
    [safeOrg, safeApp, safeEnv],
  );
  const records = rows.map(rowToDeploymentSummary);
  const metadata = await appEnvAnchors(pool, safeOrg, safeApp);
  const anchorRows = metadata.anchors.filter((anchor) => anchor.envName === safeEnv);
  if (records.length === 0 && anchorRows.length === 0) return undefined;
  return summarizeEnvs(safeOrg, safeApp, records, anchorRows, {
    includeArchived: true,
    productionEnvironment: metadata.productionEnvironment,
  })[0];
}

export async function setProductionEnvironmentRow(
  pool: Pool,
  org: string,
  app: string,
  env: string,
): Promise<ProductionEnvironmentChange | undefined> {
  const safeOrg = validateSlug('org', org);
  const safeApp = validateSlug('app', app);
  const safeEnv = validateSlug('env', env);
  const client = await pool.connect();
  await client.query('BEGIN');
  try {
    const appResult = await client.query(
      'SELECT slug FROM apps WHERE org_slug = $1 AND slug = $2 FOR UPDATE',
      [safeOrg, safeApp],
    );
    if (appResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return undefined;
    }
    const envResult = await client.query<Pick<EnvAnchorRow, 'name' | 'is_production'>>(
      'SELECT name, is_production FROM environments WHERE org_slug = $1 AND app_slug = $2',
      [safeOrg, safeApp],
    );
    if (!envResult.rows.some((row) => row.name === safeEnv)) {
      await client.query('ROLLBACK');
      return undefined;
    }
    const marked = envResult.rows.find((row) => row.is_production)?.name ?? null;
    const previous =
      resolveProductionEnvironment(new Set(envResult.rows.map((row) => row.name)), marked) ?? null;
    if (previous !== safeEnv || marked !== safeEnv) {
      await client.query(
        'UPDATE environments SET is_production = false WHERE org_slug = $1 AND app_slug = $2 AND is_production = true',
        [safeOrg, safeApp],
      );
      await client.query(
        'UPDATE environments SET is_production = true WHERE org_slug = $1 AND app_slug = $2 AND name = $3',
        [safeOrg, safeApp, safeEnv],
      );
    }
    await client.query('COMMIT');
    return {
      orgSlug: safeOrg,
      appSlug: safeApp,
      productionEnvironment: safeEnv,
      previousProductionEnvironment: previous,
      changed: previous !== safeEnv,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
