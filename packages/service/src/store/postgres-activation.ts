import { randomUUID } from 'node:crypto';
import type { NamedDeploymentActivationHook } from '@noodle-borg/module';
import type { AccessMode } from '@noodle-borg/transport-http';
import { translateCustomerAuthAudienceDatabaseError } from '../customer-auth-audience-binding.js';
import type { SqlClientProvider } from '../modules/context.js';
import {
  assertPreparedDeploymentActivation,
  prepareDeploymentActivation,
} from '../modules/context.js';
import type { DeploymentActivationResult, TenantAuthConfig, TenantRef } from '../store.js';
import { DEPLOYMENT_ID_PATTERN, validateTenantRef } from '../store.js';
import {
  lockDeploymentVersionScopeTx,
  translateDeploymentLockDatabaseError,
} from './postgres-deployment-lock.js';
import { type DeployRow, rowToRecord } from './postgres-rows.js';
import { withPostgresTransaction } from './postgres-transaction.js';

export async function activateDeploymentRows(
  pool: SqlClientProvider,
  ref: TenantRef,
  deploymentId: string,
  precondition:
    | {
        readonly expectedAccessMode: AccessMode | undefined;
        readonly serverAuth?: TenantAuthConfig;
      }
    | undefined,
  activationHooks: readonly NamedDeploymentActivationHook[],
  options: { readonly automationId?: string } = {},
): Promise<DeploymentActivationResult | undefined> {
  const safe = validateTenantRef(ref);
  if (!DEPLOYMENT_ID_PATTERN.test(deploymentId)) return undefined;
  try {
    return await withPostgresTransaction(pool, async (client) => {
      const savepoint = `activation_${randomUUID().replaceAll('-', '')}`;
      await client.query(`SAVEPOINT ${savepoint}`);
      const notActivated = async () => {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        return undefined;
      };
      const preparedActivation = await prepareDeploymentActivation(client, activationHooks, {
        operation: 'activate',
        org: safe.org,
        app: safe.app,
        environment: safe.env,
        deploymentId,
        ...(options.automationId === undefined ? {} : { automationId: options.automationId }),
      });
      const targetExists = await client.query<{ server_version: string | null }>(
        `SELECT server_version
       FROM deploy_records
       WHERE deployment_id = $1
         AND org_slug = $2
         AND app_slug = $3
         AND environment = $4`,
        [deploymentId, safe.org, safe.app, safe.env],
      );
      if (targetExists.rows[0] === undefined) {
        return notActivated();
      }
      const targetVersion = targetExists.rows[0].server_version ?? undefined;
      await lockDeploymentVersionScopeTx(client, safe, targetVersion);
      const { rows: targetRows } = await client.query<DeployRow>(
        `SELECT *
       FROM deploy_records
       WHERE deployment_id = $1
         AND org_slug = $2
         AND app_slug = $3
         AND environment = $4
         AND server_version IS NOT DISTINCT FROM $5
       FOR UPDATE`,
        [deploymentId, safe.org, safe.app, safe.env, targetVersion ?? null],
      );
      const target = targetRows[0];
      if (target === undefined) {
        return notActivated();
      }
      const targetRecord = rowToRecord(target);
      if (
        precondition !== undefined &&
        targetRecord.accessMode !== precondition.expectedAccessMode
      ) {
        return notActivated();
      }
      const { rows: activeRows } = await client.query<DeployRow>(
        `SELECT *
       FROM deploy_records
       WHERE org_slug = $1
         AND app_slug = $2
         AND environment = $3
         AND active = true
         AND server_version IS NOT DISTINCT FROM $4
       ORDER BY deployment_version DESC
       LIMIT 1
       FOR UPDATE`,
        [safe.org, safe.app, safe.env, target.server_version],
      );
      const previousActive = activeRows[0] ? rowToRecord(activeRows[0]) : undefined;
      const alreadyActive = previousActive?.deploymentId === deploymentId;
      if (!alreadyActive) {
        await assertPreparedDeploymentActivation(preparedActivation);
        await client.query(
          `UPDATE deploy_records
         SET active = false
         WHERE org_slug = $1
           AND app_slug = $2
           AND environment = $3
           AND active = true
           AND server_version IS NOT DISTINCT FROM $4`,
          [safe.org, safe.app, safe.env, target.server_version],
        );
        await client.query('UPDATE deploy_records SET active = true WHERE deployment_id = $1', [
          deploymentId,
        ]);
      }
      if (targetRecord.accessMode === 'customers' && precondition?.serverAuth !== undefined) {
        await client.query(
          'UPDATE deploy_records SET server_auth = $2::jsonb WHERE deployment_id = $1',
          [deploymentId, JSON.stringify(precondition.serverAuth)],
        );
      }
      const active = {
        ...targetRecord,
        active: true,
        ...(targetRecord.accessMode === 'customers' && precondition?.serverAuth !== undefined
          ? { serverAuth: precondition.serverAuth }
          : {}),
      };
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      return {
        active,
        ...(previousActive !== undefined ? { previousActive } : {}),
        alreadyActive,
      };
    });
  } catch (error) {
    throw translateCustomerAuthAudienceDatabaseError(translateDeploymentLockDatabaseError(error));
  }
}
