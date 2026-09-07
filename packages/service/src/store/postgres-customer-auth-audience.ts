import type { Pool } from 'pg';
import {
  customerAuthAudienceBindings,
  isTenantAuthConfig,
} from '../customer-auth-audience-binding.js';
import type { TenantAuthConfig, TenantRef } from '../store.js';
import { validateTenantRef } from '../store.js';

interface ActiveCustomerAuthRow {
  readonly org_slug: string;
  readonly app_slug: string;
  readonly environment: string;
  readonly server_auth: unknown;
}

/** Efficient shared-store lookup used to fail closed on cross-boundary OIDC audience reuse. */
export async function findActiveCustomerAuthAudienceConflictRow(
  pool: Pick<Pool, 'query'>,
  ref: TenantRef,
  auth: TenantAuthConfig,
): Promise<TenantRef | undefined> {
  const safe = validateTenantRef(ref);
  const keys = new Set(
    customerAuthAudienceBindings(auth).map((binding) =>
      JSON.stringify([binding.issuer, binding.audience]),
    ),
  );
  if (keys.size === 0) return undefined;
  const { rows } = await pool.query<ActiveCustomerAuthRow>(
    `SELECT org_slug, app_slug, environment, server_auth
     FROM deploy_records
     WHERE active = true
       AND archived_at IS NULL
       AND access_mode = 'customers'
       AND NOT (org_slug = $1 AND app_slug = $2 AND environment = $3)`,
    [safe.org, safe.app, safe.env],
  );
  for (const row of rows) {
    if (!isTenantAuthConfig(row.server_auth)) continue;
    if (
      customerAuthAudienceBindings(row.server_auth).some((binding) =>
        keys.has(JSON.stringify([binding.issuer, binding.audience])),
      )
    ) {
      return { org: row.org_slug, app: row.app_slug, env: row.environment };
    }
  }
  return undefined;
}
