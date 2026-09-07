import type { Pool } from 'pg';

/** Idempotent receipt DDL only; historical anchor mutation is always an explicit operator action. */
export async function ensureAppPurgeReconciliationSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_purge_reconciliation_operations (
      idempotency_key_hash text PRIMARY KEY,
      request_fingerprint text NOT NULL,
      preview_checksum text NOT NULL,
      release_sha text NOT NULL,
      actor_subject_hash text NOT NULL,
      approval_reference_hash text NOT NULL,
      recovery_checkpoint_hash text NOT NULL,
      reason_hash text NOT NULL,
      operation_id uuid NOT NULL UNIQUE,
      candidate_count integer NOT NULL,
      deleted_count integer NOT NULL,
      applied_at timestamptz NOT NULL,
      safe_result jsonb NOT NULL,
      created_at timestamptz NOT NULL
    )
  `);
}
