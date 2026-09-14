import { normalizeServerVersion } from '@noodle-borg/module';
import type { Pool } from 'pg';
import { planDeploymentDeletion } from '../deployment-deletion.js';
import type { DeploymentDeleteResult, DeploymentDeleteSelection, TenantRef } from '../store.js';
import { lockDeploymentVersionScopeTx } from './postgres-deployment-lock.js';
import { type DeployRow, rowToRecord } from './postgres-rows.js';
import { withPostgresTransaction } from './postgres-transaction.js';
import { validateTenantRef } from './validate.js';

export async function deleteDeploymentRows(
  pool: Pool,
  ref: TenantRef,
  selection: DeploymentDeleteSelection,
): Promise<DeploymentDeleteResult> {
  const safe = validateTenantRef(ref);
  return withPostgresTransaction(pool, async (client) => {
    let version: string | undefined;
    if (selection.kind === 'deployment') {
      const target = await client.query<{ server_version: string | null }>(
        'SELECT server_version FROM deploy_records WHERE deployment_id = $1 AND org_slug = $2 AND app_slug = $3 AND environment = $4',
        [selection.deploymentId, safe.org, safe.app, safe.env],
      );
      if (target.rows[0] === undefined) return { ok: false, code: 'deployment_not_found' };
      version = target.rows[0].server_version ?? undefined;
    } else
      version =
        selection.serverVersion === undefined
          ? undefined
          : normalizeServerVersion(selection.serverVersion);
    // Follow append's scope -> parent -> records order. The parent also serializes archive and restore.
    await lockDeploymentVersionScopeTx(client, safe, version);
    await client.query('SELECT slug FROM apps WHERE org_slug = $1 AND slug = $2 FOR UPDATE', [
      safe.org,
      safe.app,
    ]);
    const { rows } = await client.query<DeployRow>(
      `SELECT * FROM deploy_records WHERE org_slug = $1 AND app_slug = $2 AND environment = $3 AND server_version IS NOT DISTINCT FROM $4 ORDER BY deployment_id FOR UPDATE`,
      [safe.org, safe.app, safe.env, version ?? null],
    );
    const result = planDeploymentDeletion(rows.map(rowToRecord), safe, selection);
    if (!result.ok) return result;
    await client.query('DELETE FROM deploy_records WHERE deployment_id = ANY($1::text[])', [
      result.deleted.map((record) => record.deploymentId),
    ]);
    return result;
  });
}
