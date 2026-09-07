import type { Pool } from 'pg';
import { ensureBusinessInformationSchema } from './postgres-schema.js';
import { ensureSourceCustody } from './source-custody-postgres.js';

/** Idempotent portable-PostgreSQL schema for external collection custody and ingestion coordination. */
export async function ensureSourceIngestionSchema(pool: Pool): Promise<void> {
  await ensureBusinessInformationSchema(pool);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS business_source_bindings (
      org_slug text NOT NULL,
      app_slug text NOT NULL,
      environment text NOT NULL,
      installation_id text NOT NULL,
      collection_key text NOT NULL,
      binding_id text NOT NULL,
      binding_generation bigint NOT NULL CHECK (binding_generation > 0),
      schema_version integer NOT NULL CHECK (schema_version > 0),
      schema_digest text NOT NULL,
      query_fingerprint text NOT NULL,
      retention_days integer NOT NULL CHECK (retention_days IN (7, 30, 90)),
      poll_interval_ms integer NOT NULL CHECK (poll_interval_ms BETWEEN 5000 AND 86400000),
      state text NOT NULL CHECK (state IN ('active', 'paused', 'revoked')),
      health text NOT NULL CHECK (health IN (
        'initializing', 'current', 'stale', 'paused', 'reauth_required', 'failed'
      )),
      completeness text NOT NULL CHECK (completeness IN ('complete', 'incomplete')),
      revision bigint NOT NULL CHECK (revision > 0),
      fence bigint NOT NULL CHECK (fence >= 0),
      scan_generation bigint NOT NULL CHECK (scan_generation >= 0),
      scan_mode text CHECK (scan_mode IN ('snapshot', 'changes')),
      lease_owner text,
      lease_expires_at timestamptz,
      last_successful_sync_at timestamptz,
      next_attempt_at timestamptz,
      error_code text,
      content_ciphertext jsonb NOT NULL,
      create_fingerprint text NOT NULL,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      PRIMARY KEY (
        org_slug, app_slug, environment, installation_id, collection_key, binding_id
      ),
      UNIQUE (
        org_slug, app_slug, environment, installation_id, collection_key,
        binding_id, binding_generation
      ),
      FOREIGN KEY (org_slug, app_slug, environment, installation_id)
        REFERENCES business_solution_installations(org_slug, app_slug, environment, installation_id)
        ON DELETE RESTRICT,
      CONSTRAINT business_source_lease_pair CHECK (
        (lease_owner IS NULL AND lease_expires_at IS NULL) OR
        (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
      )
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS business_external_records (
      org_slug text NOT NULL,
      app_slug text NOT NULL,
      environment text NOT NULL,
      installation_id text NOT NULL,
      collection_key text NOT NULL,
      binding_id text NOT NULL,
      binding_generation bigint NOT NULL CHECK (binding_generation > 0),
      source_identity_digest text NOT NULL,
      record_id text NOT NULL,
      schema_version integer NOT NULL CHECK (schema_version > 0),
      schema_digest text NOT NULL,
      revision bigint NOT NULL CHECK (revision > 0),
      content_digest text NOT NULL,
      last_seen_generation bigint NOT NULL CHECK (last_seen_generation > 0),
      completeness text NOT NULL CHECK (completeness IN ('complete', 'incomplete')),
      observed_at timestamptz NOT NULL,
      last_successful_sync_at timestamptz,
      retention_expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      deleted_at timestamptz,
      content_ciphertext jsonb,
      PRIMARY KEY (
        org_slug, app_slug, environment, installation_id, collection_key,
        binding_id, binding_generation, source_identity_digest
      ),
      FOREIGN KEY (
        org_slug, app_slug, environment, installation_id, collection_key,
        binding_id, binding_generation
      ) REFERENCES business_source_bindings(
        org_slug, app_slug, environment, installation_id, collection_key,
        binding_id, binding_generation
      ) ON DELETE RESTRICT,
      CONSTRAINT business_external_content_lifecycle CHECK (
        (deleted_at IS NULL AND content_ciphertext IS NOT NULL) OR
        (deleted_at IS NOT NULL AND content_ciphertext IS NULL)
      )
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS business_source_suppressions (
      org_slug text NOT NULL,
      app_slug text NOT NULL,
      environment text NOT NULL,
      installation_id text NOT NULL,
      collection_key text NOT NULL,
      binding_id text NOT NULL,
      binding_generation bigint NOT NULL CHECK (binding_generation > 0),
      source_identity_digest text NOT NULL,
      reason text NOT NULL CHECK (reason IN ('customer_request', 'source_access_revoked')),
      erased_at timestamptz NOT NULL,
      PRIMARY KEY (
        org_slug, app_slug, environment, installation_id, collection_key,
        binding_id, binding_generation, source_identity_digest
      ),
      FOREIGN KEY (
        org_slug, app_slug, environment, installation_id, collection_key,
        binding_id, binding_generation
      ) REFERENCES business_source_bindings(
        org_slug, app_slug, environment, installation_id, collection_key,
        binding_id, binding_generation
      ) ON DELETE RESTRICT
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS business_source_refresh_requests (
      org_slug text NOT NULL,
      app_slug text NOT NULL,
      environment text NOT NULL,
      installation_id text NOT NULL,
      collection_key text NOT NULL,
      binding_id text NOT NULL,
      binding_generation bigint NOT NULL CHECK (binding_generation > 0),
      idempotency_digest text NOT NULL,
      job_id text NOT NULL,
      state text NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'superseded')),
      requested_at timestamptz NOT NULL,
      terminal_at timestamptz,
      target_scan_generation bigint NOT NULL DEFAULT 1 CHECK (target_scan_generation > 0),
      PRIMARY KEY (
        org_slug, app_slug, environment, installation_id, collection_key,
        binding_id, binding_generation, idempotency_digest
      )
    )
  `);
  await pool.query(`ALTER TABLE business_source_refresh_requests
    ADD COLUMN IF NOT EXISTS target_scan_generation bigint NOT NULL DEFAULT 1`);
  await pool.query(`CREATE INDEX IF NOT EXISTS business_source_due_idx
    ON business_source_bindings (next_attempt_at, updated_at)
    WHERE state = 'active'`);
  await pool.query(`CREATE INDEX IF NOT EXISTS business_external_retention_idx
    ON business_external_records (retention_expires_at)
    WHERE deleted_at IS NULL`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS business_external_record_id_idx
    ON business_external_records (
      org_slug, app_slug, environment, installation_id, collection_key,
      binding_id, binding_generation, record_id
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS business_source_refresh_pending_idx
    ON business_source_refresh_requests (
      org_slug, app_slug, environment, installation_id, collection_key,
      binding_id, binding_generation, requested_at
    ) WHERE state IN ('queued', 'running')`);
  await pool.query(`ALTER TABLE business_source_refresh_requests ADD COLUMN IF NOT EXISTS terminal_at timestamptz;
    ALTER TABLE business_source_refresh_requests DROP CONSTRAINT IF EXISTS business_source_refresh_requests_state_check;
    ALTER TABLE business_source_refresh_requests ADD CONSTRAINT business_source_refresh_requests_state_check
      CHECK(state IN ('queued','running','completed','superseded'));
    UPDATE business_source_refresh_requests SET terminal_at=clock_timestamp()
      WHERE state IN ('completed','superseded') AND terminal_at IS NULL;
    CREATE INDEX IF NOT EXISTS business_source_refresh_retention_idx ON business_source_refresh_requests(terminal_at)
      WHERE state IN ('completed','superseded')`);
  await ensureSourceCustody(pool);
}
