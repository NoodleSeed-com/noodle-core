import type { Pool } from 'pg';
import { translateCustomerAuthAudienceDatabaseError } from '../customer-auth-audience-binding.js';
import type { ActiveAccessUpdateInput, DeployRecord, TenantRef } from '../store.js';
import { DEPLOYMENT_ID_PATTERN, validateTenantRef } from '../store.js';
import { type DeployRow, rowToRecord } from './postgres-rows.js';

/** Compare-and-set one active deployment's access mode and customer auth projection atomically. */
export async function updateActiveDeploymentAccessRow(
  pool: Pool,
  ref: TenantRef,
  deploymentId: string,
  input: ActiveAccessUpdateInput,
): Promise<DeployRecord | undefined> {
  const safe = validateTenantRef(ref);
  if (!DEPLOYMENT_ID_PATTERN.test(deploymentId)) return undefined;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<DeployRow>(
      `UPDATE deploy_records
       SET access_mode = CASE
         WHEN COALESCE(access_mode, 'owner-only') = $5 THEN access_mode
         ELSE $5
       END,
       server_auth = CASE
         WHEN $5 = 'customers' AND $7::jsonb IS NOT NULL THEN $7::jsonb
         ELSE server_auth
       END,
       owner_subject = CASE
         WHEN $9::text IS NULL THEN owner_subject
         ELSE $9::text
       END
       WHERE deployment_id = $1
         AND org_slug = $2
         AND app_slug = $3
         AND environment = $4
         AND active = true
         AND archived_at IS NULL
         AND access_mode IS NOT DISTINCT FROM $6
         AND COALESCE(owner_subject, created_by_subject) IS NOT DISTINCT FROM $8::text
       RETURNING *`,
      [
        deploymentId,
        safe.org,
        safe.app,
        safe.env,
        input.accessMode,
        input.expectedAccessMode ?? null,
        input.serverAuth === undefined ? null : JSON.stringify(input.serverAuth),
        input.expectedOwnerSubject ?? null,
        input.ownerSubject ?? null,
      ],
    );
    const updated = rows[0];
    if (updated === undefined) {
      await client.query('ROLLBACK');
      return undefined;
    }
    await client.query('COMMIT');
    return rowToRecord(updated);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw translateCustomerAuthAudienceDatabaseError(error);
  } finally {
    client.release();
  }
}
