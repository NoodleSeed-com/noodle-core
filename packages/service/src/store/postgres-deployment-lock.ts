import { normalizeServerVersion } from '@noodle-borg/module';
import type { Pool, PoolClient } from 'pg';
import { DeploymentLockedError } from '../deployment-lock.js';
import type { DeploymentLock, DeploymentLockUpdateResult, TenantRef } from '../store.js';
import { validateTenantRef } from '../store.js';
import { type DeployRow, rowToRecord } from './postgres-rows.js';

// Coordination marker for the trusted CAS transaction, not a permission boundary: the application
// database role has operator authority and can deliberately set custom GUCs (ADR 0199).
const LOCK_MUTATION_SETTING = 'noodle.deployment_lock_mutation';

/**
 * Serialize pointer mutations only within one versioned deployment scope. Including the database schema
 * keeps isolated Postgres test schemas independent even though advisory locks are database-wide.
 */
export async function lockDeploymentVersionScopeTx(
  client: PoolClient,
  ref: TenantRef,
  serverVersion: string | undefined,
): Promise<void> {
  if (serverVersion === undefined) return;
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended(
       jsonb_build_array(
         'noodle.deployment-version.v1', current_database(), current_schema(),
         $1::text, $2::text, $3::text, $4::text
       )::text,
       0
     ))`,
    [ref.org, ref.app, ref.env, serverVersion],
  );
}

/**
 * Install the lock columns and database guard as one DDL transaction. The table lock prevents an older
 * service revision from writing through the gap between the columns and trigger becoming available.
 */
export async function ensureDeploymentLockSchema(pool: Pool): Promise<void> {
  const client = await pool.connect();
  await client.query('BEGIN');
  try {
    await client.query('LOCK TABLE deploy_records IN SHARE ROW EXCLUSIVE MODE');
    await client.query(
      'ALTER TABLE deploy_records ADD COLUMN IF NOT EXISTS deployment_locked_at timestamptz',
    );
    await client.query(
      'ALTER TABLE deploy_records ADD COLUMN IF NOT EXISTS deployment_locked_by_subject text',
    );
    await client.query(
      'ALTER TABLE deploy_records ADD COLUMN IF NOT EXISTS deployment_locked_by_email text',
    );
    await client.query(`
      CREATE OR REPLACE FUNCTION enforce_deployment_version_lock()
      RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        locked_deployment_id text;
        changed_columns text;
        lock_mutation_allowed boolean :=
          COALESCE(current_setting('${LOCK_MUTATION_SETTING}', true), '') = '1';
      BEGIN
        IF TG_OP = 'DELETE' THEN
          IF OLD.active = true
             AND OLD.archived_at IS NULL
             AND OLD.deployment_locked_at IS NOT NULL THEN
            RAISE EXCEPTION 'deployment_locked:delete' USING ERRCODE = 'P0001';
          END IF;
          RETURN OLD;
        END IF;

        IF TG_OP = 'INSERT' THEN
          IF NEW.server_version IS NOT NULL THEN
            SELECT deployment_id INTO locked_deployment_id
            FROM deploy_records
            WHERE org_slug = NEW.org_slug
              AND app_slug = NEW.app_slug
              AND environment = NEW.environment
              AND server_version = NEW.server_version
              AND active = true
              AND deployment_locked_at IS NOT NULL
            LIMIT 1
            FOR UPDATE;
            IF locked_deployment_id IS NOT NULL
               AND locked_deployment_id <> NEW.deployment_id THEN
              RAISE EXCEPTION 'deployment_locked:insert' USING ERRCODE = 'P0001';
            END IF;
          END IF;
          RETURN NEW;
        END IF;

        IF (NEW.deployment_locked_at,
            NEW.deployment_locked_by_subject,
            NEW.deployment_locked_by_email)
             IS DISTINCT FROM
           (OLD.deployment_locked_at,
            OLD.deployment_locked_by_subject,
            OLD.deployment_locked_by_email)
           AND NOT lock_mutation_allowed THEN
          RAISE EXCEPTION 'deployment_locked:lock_mutation' USING ERRCODE = 'P0001';
        END IF;

        IF OLD.active = true
           AND OLD.deployment_locked_at IS NOT NULL
           AND (
             to_jsonb(NEW) - ARRAY[
               'access_mode', 'owner_subject', 'server_auth', 'archived_at',
               'deployment_locked_at', 'deployment_locked_by_subject',
               'deployment_locked_by_email'
             ]
           ) IS DISTINCT FROM (
             to_jsonb(OLD) - ARRAY[
               'access_mode', 'owner_subject', 'server_auth', 'archived_at',
               'deployment_locked_at', 'deployment_locked_by_subject',
               'deployment_locked_by_email'
             ]
           ) THEN
          SELECT string_agg(column_name, ',') INTO changed_columns
          FROM jsonb_object_keys(to_jsonb(NEW)) AS columns(column_name)
          WHERE column_name <> ALL (ARRAY[
            'access_mode', 'owner_subject', 'server_auth', 'archived_at',
            'deployment_locked_at', 'deployment_locked_by_subject',
            'deployment_locked_by_email'
          ])
            AND (to_jsonb(NEW) -> column_name) IS DISTINCT FROM
                (to_jsonb(OLD) -> column_name);
          RAISE EXCEPTION 'deployment_locked:immutable'
            USING ERRCODE = 'P0001', DETAIL = changed_columns;
        END IF;

        IF NEW.server_version IS NOT NULL AND NEW.active = true THEN
          SELECT deployment_id INTO locked_deployment_id
          FROM deploy_records
          WHERE org_slug = NEW.org_slug
            AND app_slug = NEW.app_slug
            AND environment = NEW.environment
            AND server_version = NEW.server_version
            AND active = true
            AND deployment_locked_at IS NOT NULL
            AND deployment_id <> NEW.deployment_id
          LIMIT 1
          FOR UPDATE;
          IF locked_deployment_id IS NOT NULL THEN
            RAISE EXCEPTION 'deployment_locked:activation' USING ERRCODE = 'P0001';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await client.query('DROP TRIGGER IF EXISTS deployment_version_lock_guard ON deploy_records');
    await client.query(`
      CREATE TRIGGER deployment_version_lock_guard
      BEFORE INSERT OR UPDATE OR DELETE ON deploy_records
      FOR EACH ROW EXECUTE FUNCTION enforce_deployment_version_lock()
    `);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function setDeploymentLockRow(
  pool: Pool,
  ref: TenantRef,
  serverVersion: string,
  expectedDeploymentId: string,
  deploymentLock: DeploymentLock | undefined,
): Promise<DeploymentLockUpdateResult> {
  const safe = validateTenantRef(ref);
  const safeVersion = normalizeServerVersion(serverVersion);
  const client = await pool.connect();
  await client.query('BEGIN');
  try {
    // Deploy and rollback pointer writes take this same scope lock. Lock/unlock must join that ordering so
    // a stale expected deployment is reported as a conflict instead of racing the move.
    await lockDeploymentVersionScopeTx(client, safe, safeVersion);
    const { rows } = await client.query<DeployRow>(
      `SELECT * FROM deploy_records
       WHERE org_slug = $1
         AND app_slug = $2
         AND environment = $3
         AND server_version = $4
         AND active = true
         AND archived_at IS NULL
       LIMIT 1
       FOR UPDATE`,
      [safe.org, safe.app, safe.env, safeVersion],
    );
    const activeRow = rows[0];
    if (activeRow === undefined) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'no_active_deployment' };
    }
    if (activeRow.deployment_id !== expectedDeploymentId) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'conflict' };
    }
    const currentlyLocked = activeRow.deployment_locked_at !== null;
    const changed = currentlyLocked !== (deploymentLock !== undefined);
    if (!changed) {
      await client.query('COMMIT');
      return { ok: true, record: rowToRecord(activeRow), changed: false };
    }
    await client.query(`SELECT set_config('${LOCK_MUTATION_SETTING}', '1', true)`);
    const { rows: updatedRows } = await client.query<DeployRow>(
      `UPDATE deploy_records
       SET deployment_locked_at = $2::timestamptz,
           deployment_locked_by_subject = $3,
           deployment_locked_by_email = $4
       WHERE deployment_id = $1
       RETURNING *`,
      [
        expectedDeploymentId,
        deploymentLock?.lockedAt ?? null,
        deploymentLock?.lockedBySubject ?? null,
        deploymentLock?.lockedByEmail ?? null,
      ],
    );
    await client.query('COMMIT');
    return { ok: true, record: rowToRecord(updatedRows[0] as DeployRow), changed: true };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw translateDeploymentLockDatabaseError(error);
  } finally {
    client.release();
  }
}

export function translateDeploymentLockDatabaseError(error: unknown): unknown {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P0001' &&
    'message' in error &&
    typeof error.message === 'string' &&
    error.message.includes('deployment_locked')
  ) {
    const detail = 'detail' in error && typeof error.detail === 'string' ? error.detail : undefined;
    return new DeploymentLockedError(
      detail === undefined ? error.message : `${error.message} (${detail})`,
    );
  }
  return error;
}
