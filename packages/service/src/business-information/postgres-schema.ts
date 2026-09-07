import type { Pool } from 'pg';
import { builtInManagedReleaseDefinitions } from './managed-releases.js';
import { ensureBusinessNoticeSchema } from './postgres-business-notice.js';
import { ensureInstallationCapacity } from './postgres-installation-capacity.js';
import { ensureNativeStorageBudget } from './postgres-storage-budget.js';

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
      intake_active boolean NOT NULL DEFAULT true,
      revision bigint NOT NULL CHECK (revision > 0),
      create_fingerprint text NOT NULL,
      created_at timestamptz NOT NULL,
      created_by_subject text NOT NULL,
      updated_at timestamptz NOT NULL,
      updated_by_subject text NOT NULL,
      definition_snapshot jsonb,
      PRIMARY KEY (org_slug, app_slug, environment, installation_id),
      UNIQUE (org_slug, installation_id)
    )
  `);
  await pool.query(
    `ALTER TABLE business_solution_installations ADD COLUMN IF NOT EXISTS definition_snapshot jsonb`,
  );
  await ensureInstallationCapacity(pool);
  await ensureBusinessNoticeSchema(pool);
  await pool.query(
    `ALTER TABLE business_solution_installations ADD COLUMN IF NOT EXISTS application_generation text`,
  );
  for (const definition of builtInManagedReleaseDefinitions()) {
    if (definition.reference.kind !== 'managed') continue;
    await pool.query(
      `UPDATE business_solution_installations
       SET definition_snapshot=$1::jsonb
       WHERE definition_snapshot IS NULL AND profile_key=$2 AND profile_version=$3`,
      [JSON.stringify(definition), definition.reference.definitionId, definition.reference.release],
    );
  }
  await pool.query(
    `ALTER TABLE business_solution_installations ADD COLUMN IF NOT EXISTS intake_active boolean NOT NULL DEFAULT true`,
  );
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
    CREATE TABLE IF NOT EXISTS business_installation_invitations (
      org_slug text NOT NULL,
      app_slug text NOT NULL,
      environment text NOT NULL,
      installation_id text NOT NULL,
      invitation_id text NOT NULL,
      email text NOT NULL,
      role text NOT NULL CHECK (role IN ('administrator', 'manager', 'operator', 'viewer')),
      token_digest text NOT NULL UNIQUE,
      idempotency_digest text NOT NULL,
      create_fingerprint text NOT NULL,
      revision bigint NOT NULL CHECK (revision > 0),
      created_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL,
      created_by_subject text NOT NULL,
      accepted_at timestamptz,
      accepted_by_subject text,
      revoked_at timestamptz,
      revoked_by_subject text,
      PRIMARY KEY (org_slug, app_slug, environment, installation_id, invitation_id),
      UNIQUE (org_slug, app_slug, environment, installation_id, idempotency_digest),
      FOREIGN KEY (org_slug, app_slug, environment, installation_id)
        REFERENCES business_solution_installations(org_slug, app_slug, environment, installation_id)
        ON DELETE RESTRICT,
      CONSTRAINT business_invitation_terminal_state CHECK (
        NOT (accepted_at IS NOT NULL AND revoked_at IS NOT NULL)
      )
    )
  `);
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
      status text CHECK (status IN ('new', 'in_progress', 'resolved', 'closed')),
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
  await pool.query(`ALTER TABLE managed_request_records ALTER COLUMN status DROP NOT NULL`);
  await pool.query(
    `ALTER TABLE managed_request_records ADD COLUMN IF NOT EXISTS original_schema_identity jsonb`,
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
      status text CHECK (status IN ('new', 'in_progress', 'resolved', 'closed')),
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
  await pool.query(`ALTER TABLE managed_request_activities ALTER COLUMN status DROP NOT NULL`);
  await pool.query(`ALTER TABLE managed_request_activities
    DROP CONSTRAINT IF EXISTS managed_request_activities_kind_check,
    ADD CONSTRAINT managed_request_activities_kind_check CHECK (kind IN (
      'created','updated','assigned','status_changed','note_added','schema_migrated','deleted','retention_expired'
    ))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS business_installations_org_created_idx
    ON business_solution_installations (org_slug, created_at, installation_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS business_invitations_scope_created_idx
    ON business_installation_invitations (
      org_slug, app_slug, environment, installation_id, created_at DESC
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS managed_requests_scope_created_idx
    ON managed_request_records (
      org_slug, app_slug, environment, installation_id, collection_key, created_at, record_id
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS managed_requests_retention_idx
    ON managed_request_records (retention_expires_at)
    WHERE deleted_at IS NULL`);
  await ensureNativeStorageBudget(pool);
}
