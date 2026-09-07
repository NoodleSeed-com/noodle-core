import type { Pool } from 'pg';

/** Idempotent initial schema for solution installations and managed request custody. */
export async function ensureBusinessInformationSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS business_solution_installations (
      org_slug text NOT NULL,
      app_slug text NOT NULL,
      environment text NOT NULL,
      installation_id text NOT NULL,
      public_id text NOT NULL UNIQUE,
      profile_key text NOT NULL,
      profile_version integer NOT NULL,
      managed_collections text[] NOT NULL,
      retention_days integer NOT NULL CHECK (retention_days IN (7, 30, 90)),
      revision bigint NOT NULL CHECK (revision > 0),
      create_fingerprint text NOT NULL,
      created_at timestamptz NOT NULL,
      created_by_subject text NOT NULL,
      updated_at timestamptz NOT NULL,
      updated_by_subject text NOT NULL,
      PRIMARY KEY (org_slug, app_slug, environment, installation_id),
      UNIQUE (org_slug, installation_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS business_installation_grants (
      org_slug text NOT NULL,
      app_slug text NOT NULL,
      environment text NOT NULL,
      installation_id text NOT NULL,
      subject text NOT NULL,
      email text,
      role text NOT NULL CHECK (role IN ('administrator', 'manager', 'operator', 'viewer')),
      revision bigint NOT NULL CHECK (revision > 0),
      created_at timestamptz NOT NULL,
      created_by_subject text NOT NULL,
      updated_at timestamptz NOT NULL,
      updated_by_subject text NOT NULL,
      revoked_at timestamptz,
      PRIMARY KEY (org_slug, app_slug, environment, installation_id, subject),
      FOREIGN KEY (org_slug, app_slug, environment, installation_id)
        REFERENCES business_solution_installations(org_slug, app_slug, environment, installation_id)
        ON DELETE RESTRICT
    )
  `);
  await pool.query(`ALTER TABLE business_installation_grants ADD COLUMN IF NOT EXISTS email text`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS managed_request_records (
      org_slug text NOT NULL,
      app_slug text NOT NULL,
      environment text NOT NULL,
      installation_id text NOT NULL,
      collection_key text NOT NULL,
      record_id text NOT NULL,
      profile_key text NOT NULL,
      profile_version integer NOT NULL,
      schema_version integer NOT NULL,
      schema_digest text NOT NULL,
      status text NOT NULL CHECK (status IN ('new', 'in_progress', 'resolved', 'closed')),
      assignee_subject text,
      origin_kind text NOT NULL CHECK (origin_kind IN ('embedded', 'mcp', 'portal', 'api', 'import')),
      revision bigint NOT NULL CHECK (revision > 0),
      retention_expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL,
      created_by_subject text NOT NULL,
      updated_at timestamptz NOT NULL,
      updated_by_subject text NOT NULL,
      deleted_at timestamptz,
      deletion_reason text CHECK (deletion_reason IN ('customer_request', 'retention_expired')),
      content_ciphertext jsonb,
      idempotency_digest text NOT NULL,
      create_fingerprint text NOT NULL,
      PRIMARY KEY (org_slug, app_slug, environment, installation_id, collection_key, record_id),
      UNIQUE (org_slug, app_slug, environment, installation_id, collection_key, idempotency_digest),
      FOREIGN KEY (org_slug, app_slug, environment, installation_id)
        REFERENCES business_solution_installations(org_slug, app_slug, environment, installation_id)
        ON DELETE RESTRICT,
      CONSTRAINT managed_request_content_lifecycle CHECK (
        (deleted_at IS NULL AND deletion_reason IS NULL AND content_ciphertext IS NOT NULL) OR
        (deleted_at IS NOT NULL AND deletion_reason IS NOT NULL AND content_ciphertext IS NULL)
      )
    )
  `);
  await pool.query(
    `ALTER TABLE managed_request_records ADD COLUMN IF NOT EXISTS create_fingerprint text`,
  );
  await pool.query(
    `UPDATE managed_request_records SET create_fingerprint='' WHERE create_fingerprint IS NULL`,
  );
  await pool.query(
    `ALTER TABLE managed_request_records ALTER COLUMN create_fingerprint SET NOT NULL`,
  );
  await pool.query(`
    CREATE TABLE IF NOT EXISTS managed_request_activities (
      org_slug text NOT NULL,
      app_slug text NOT NULL,
      environment text NOT NULL,
      installation_id text NOT NULL,
      collection_key text NOT NULL,
      record_id text NOT NULL,
      revision bigint NOT NULL CHECK (revision > 0),
      kind text NOT NULL CHECK (kind IN (
        'created', 'updated', 'assigned', 'status_changed', 'note_added', 'deleted', 'retention_expired'
      )),
      status text NOT NULL CHECK (status IN ('new', 'in_progress', 'resolved', 'closed')),
      assignee_subject text,
      occurred_at timestamptz NOT NULL,
      actor_subject text NOT NULL,
      content_ciphertext jsonb,
      PRIMARY KEY (
        org_slug, app_slug, environment, installation_id, collection_key, record_id, revision
      ),
      FOREIGN KEY (
        org_slug, app_slug, environment, installation_id, collection_key, record_id
      ) REFERENCES managed_request_records(
        org_slug, app_slug, environment, installation_id, collection_key, record_id
      ) ON DELETE RESTRICT
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS business_installations_org_created_idx
    ON business_solution_installations (org_slug, created_at, installation_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS managed_requests_scope_created_idx
    ON managed_request_records (
      org_slug, app_slug, environment, installation_id, collection_key, created_at, record_id
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS managed_requests_retention_idx
    ON managed_request_records (retention_expires_at)
    WHERE deleted_at IS NULL`);
}
