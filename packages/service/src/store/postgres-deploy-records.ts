import type { NamedDeploymentActivationHook } from '@noodle-borg/module';
import type { Pool } from 'pg';
import {
  assertSameAppPackageSnapshot,
  sanitizeDeployRecordAppPackageSnapshot,
} from '../app-package-snapshot.js';
import { translateCustomerAuthAudienceDatabaseError } from '../customer-auth-audience-binding.js';
import { assertDeploymentAppendUnlocked } from '../deployment-lock.js';
import {
  assertPreparedDeploymentActivation,
  prepareDeploymentActivation,
} from '../modules/context.js';
import type { DeployRecord } from '../store.js';
import { DEPLOYMENT_ID_PATTERN, validateTenantRef } from '../store.js';
import {
  lockDeploymentVersionScopeTx,
  translateDeploymentLockDatabaseError,
} from './postgres-deployment-lock.js';
import { type DeployRow, deployRecordParams, rowToRecord } from './postgres-rows.js';
import { withPostgresTransaction } from './postgres-transaction.js';
import { preserveDeploymentOwnerState } from './records.js';

/**
 * Persist one deploy record and its parent app/environment rows in a single transaction. Extracted from
 * `PostgresArtifactStore.append` so the deploy-record write SQL has its own home, mirroring the
 * extracted control-plane row module.
 */
export async function appendDeployRecordRows(
  pool: Pool,
  record: DeployRecord,
  activationHooks: readonly NamedDeploymentActivationHook[] = [],
): Promise<void> {
  // Defence in depth (mirrors the file store): `deploymentId` is always minted as `[a-z0-9-]`.
  // Parameterized queries make injection impossible regardless; this just rejects malformed callers.
  validateTenantRef({ org: record.orgSlug, app: record.appSlug, env: record.environment });
  if (!DEPLOYMENT_ID_PATTERN.test(record.deploymentId)) {
    throw new Error(`invalid deploymentId for persistence: "${record.deploymentId}"`);
  }
  record = sanitizeDeployRecordAppPackageSnapshot(record);
  try {
    await withPostgresTransaction(pool, async (client) => {
      const preparedActivation = record.active
        ? await prepareDeploymentActivation(client, activationHooks, {
            operation: 'append',
            org: record.orgSlug,
            app: record.appSlug,
            environment: record.environment,
            deploymentId: record.deploymentId,
            ...(record.serverVersion === undefined ? {} : { serverVersion: record.serverVersion }),
          })
        : undefined;
      await lockDeploymentVersionScopeTx(
        client,
        { org: record.orgSlug, app: record.appSlug, env: record.environment },
        record.serverVersion,
      );
      const organization = await client.query('SELECT slug FROM orgs WHERE slug = $1 FOR UPDATE', [
        record.orgSlug,
      ]);
      if (organization.rows.length === 0) {
        throw new Error('organization must be created before deploy');
      }
      await client.query(
        `INSERT INTO apps (org_slug, slug) VALUES ($1, $2)
       ON CONFLICT (org_slug, slug) DO UPDATE
       SET slug = apps.slug
       RETURNING slug`,
        [record.orgSlug, record.appSlug],
      );
      const { rows: existingRows } = await client.query<DeployRow>(
        `SELECT * FROM deploy_records
       WHERE deployment_id = $1
       FOR UPDATE`,
        [record.deploymentId],
      );
      const existing = existingRows[0] === undefined ? undefined : rowToRecord(existingRows[0]);
      if (existing !== undefined) assertSameAppPackageSnapshot(existing, record);
      if (existing !== undefined) record = preserveDeploymentOwnerState(existing, record);
      if (existing !== undefined && !assertDeploymentAppendUnlocked([existing], record)) {
        return;
      }
      await client.query(
        `INSERT INTO environments (org_slug, app_slug, name, is_production)
       SELECT $1, $2, $3, NOT EXISTS (
         SELECT 1 FROM environments WHERE org_slug = $1 AND app_slug = $2
       )
       ON CONFLICT (org_slug, app_slug, name) DO NOTHING`,
        [record.orgSlug, record.appSlug, record.environment],
      );
      if (record.active) {
        if (preparedActivation !== undefined) {
          await assertPreparedDeploymentActivation(preparedActivation);
        }
        await client.query(
          `UPDATE deploy_records
         SET active = false
         WHERE org_slug = $1
           AND app_slug = $2
           AND environment = $3
           AND server_version IS NOT DISTINCT FROM $4`,
          [record.orgSlug, record.appSlug, record.environment, record.serverVersion ?? null],
        );
      }
      // Upsert: a record is immutable per minted id, but ON CONFLICT keeps `append` idempotent under retries.
      await client.query(
        `INSERT INTO deploy_records
       (deployment_id, org_slug, app_slug, environment, server_version, deployment_version, active, server_name,
        created_at, created_by_subject, created_by_email, access_mode, server_auth, caller_key_hash,
        manifest, connectors, hosted_assets, secrets, schema_version, archived_at, deployment_source,
        org_membership_sources, deployment_locked_at, deployment_locked_by_subject,
        deployment_locked_by_email, app_package_snapshot, owner_subject)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16, $17::jsonb, $18::jsonb, $19, $20::timestamptz, $21, $22, $23::timestamptz, $24, $25, $26::jsonb, $27)
     ON CONFLICT (deployment_id) DO UPDATE SET
       org_slug           = EXCLUDED.org_slug,
       app_slug           = EXCLUDED.app_slug,
       environment        = EXCLUDED.environment,
       server_version     = EXCLUDED.server_version,
       deployment_version = EXCLUDED.deployment_version,
       active             = EXCLUDED.active,
       server_name        = EXCLUDED.server_name,
       created_at         = EXCLUDED.created_at,
       created_by_subject = EXCLUDED.created_by_subject,
       created_by_email   = EXCLUDED.created_by_email,
       access_mode        = EXCLUDED.access_mode,
       server_auth        = EXCLUDED.server_auth,
       caller_key_hash    = EXCLUDED.caller_key_hash,
       manifest           = EXCLUDED.manifest,
       connectors         = EXCLUDED.connectors,
       hosted_assets      = EXCLUDED.hosted_assets,
       secrets            = EXCLUDED.secrets,
       schema_version     = EXCLUDED.schema_version,
       archived_at        = EXCLUDED.archived_at,
       deployment_source  = EXCLUDED.deployment_source,
       org_membership_sources = EXCLUDED.org_membership_sources,
       owner_subject      = EXCLUDED.owner_subject`,
        deployRecordParams(record),
      );
    });
  } catch (error) {
    throw translateCustomerAuthAudienceDatabaseError(translateDeploymentLockDatabaseError(error));
  }
}
