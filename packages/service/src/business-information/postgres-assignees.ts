import type { PoolClient } from 'pg';
import { createModuleSqlTransaction } from '../modules/context.js';
import type { ManagedRequestRecord } from './contracts.js';
import type { BusinessPrincipalAuthority } from './principal-authority.js';

export async function validAssignee(
  client: PoolClient,
  scope: ManagedRequestRecord['scope'],
  subject: string,
  principals: BusinessPrincipalAuthority,
): Promise<boolean> {
  if (!(await principals.allows(subject, createModuleSqlTransaction(client)))) return false;
  const result = await client.query<{ role: string; revoked_at: Date | null }>(
    `SELECT role, revoked_at FROM business_installation_grants
     WHERE org_slug=$1 AND app_slug=$2 AND environment=$3 AND installation_id=$4
       AND subject=$5 FOR SHARE`,
    [scope.org, scope.app, scope.env, scope.installationId, subject],
  );
  const grant = result.rows[0];
  return grant !== undefined && grant.revoked_at === null && grant.role !== 'viewer';
}
