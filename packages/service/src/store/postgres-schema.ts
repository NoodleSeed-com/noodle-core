import {
  ensureAppPurgeReconciliationSchema,
  ensureOrganizationSchema,
} from '@noodle-borg/control-plane';
import { ensureAuditSchema } from '@noodle-borg/module-audit';
import { ensureRequestEventSchema } from '@noodle-borg/observability';
import { ensureStateHandleSchema } from '@noodle-borg/runtime/postgres';
import type { Pool } from 'pg';
import { ensureAlertRuleSchema } from './postgres-alerts.js';
import {
  type CustomerAuthAudienceReconciliation,
  ensureCustomerAuthAudienceSchema,
} from './postgres-customer-auth-audience-schema.js';
import { ensureDeploymentLockSchema } from './postgres-deployment-lock.js';

/**
 * Idempotent DDL for the relational deploy store (extracted from `PostgresArtifactStore` to keep that
 * file under the size gate). Creates every table/index the store needs and runs additive
 * `ADD COLUMN IF NOT EXISTS` / type-widening migrations so existing alpha databases upgrade in place.
 * The `secrets` column is `jsonb` and holds the tagged `SecretEnvelope` (AES-256-GCM ciphertext when a
 * master key is configured — never cleartext at rest); `schema_version` carries a forward-migration
 * hook. Run once at startup before serving.
 */
export async function ensureArtifactSchema(
  pool: Pool,
): Promise<CustomerAuthAudienceReconciliation> {
  await ensureAuditSchema(pool);
  await ensureAppPurgeReconciliationSchema(pool);
  await ensureOrganizationSchema(pool);
  await pool.query(`
      CREATE TABLE IF NOT EXISTS apps (
        org_slug     text NOT NULL REFERENCES orgs(slug) ON DELETE CASCADE,
        slug         text NOT NULL,
        display_name text,
        created_at   timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (org_slug, slug)
      )
    `);
  await pool.query(`
      CREATE TABLE IF NOT EXISTS environments (
        org_slug    text NOT NULL,
        app_slug    text NOT NULL,
        name        text NOT NULL,
        is_production boolean NOT NULL DEFAULT false,
        created_at  timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (org_slug, app_slug, name),
        FOREIGN KEY (org_slug, app_slug) REFERENCES apps(org_slug, slug) ON DELETE CASCADE
      )
    `);
  await pool.query(`
      DO $$
      DECLARE production_column_missing boolean;
      BEGIN
        SELECT NOT EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'environments'
            AND column_name = 'is_production'
        ) INTO production_column_missing;

        IF production_column_missing THEN
          ALTER TABLE environments
            ADD COLUMN IF NOT EXISTS is_production boolean NOT NULL DEFAULT false;

          UPDATE environments candidate
          SET is_production = true
          WHERE candidate.name = 'prod'
            AND NOT EXISTS (
              SELECT 1 FROM environments current
              WHERE current.org_slug = candidate.org_slug
                AND current.app_slug = candidate.app_slug
                AND current.is_production = true
            );

          UPDATE environments candidate
          SET is_production = true
          WHERE NOT EXISTS (
              SELECT 1 FROM environments current
              WHERE current.org_slug = candidate.org_slug
                AND current.app_slug = candidate.app_slug
                AND current.is_production = true
            )
            AND 1 = (
              SELECT count(*) FROM environments sibling
              WHERE sibling.org_slug = candidate.org_slug
                AND sibling.app_slug = candidate.app_slug
            );
        END IF;
      END $$
    `);
  await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS environments_one_production_per_app
      ON environments (org_slug, app_slug)
      WHERE is_production = true
    `);
  await pool.query(`
      CREATE TABLE IF NOT EXISTS deploy_records (
        deployment_id       text PRIMARY KEY,
        org_slug            text NOT NULL,
        app_slug            text NOT NULL,
        environment         text NOT NULL,
        deployment_version  bigint NOT NULL,
        active              boolean NOT NULL,
        server_name         text NOT NULL,
        created_at          timestamptz NOT NULL,
        created_by_subject  text,
        created_by_email    text,
        access_mode         text NOT NULL DEFAULT 'owner-only',
        server_auth         jsonb,
        caller_key_hash     text,
        manifest            text NOT NULL,
        connectors          text,
        hosted_assets       jsonb,
        secrets             jsonb NOT NULL,
        schema_version      int NOT NULL,
        deployment_source   text CHECK (
          deployment_source IS NULL OR
          deployment_source IN ('console-example', 'cli', 'github', 'api')
        ),
        app_package_snapshot jsonb,
        owner_subject       text,
        FOREIGN KEY (org_slug, app_slug, environment)
          REFERENCES environments(org_slug, app_slug, name) ON DELETE CASCADE
      )
    `);
  // Keep old physical caller-key columns for alpha data compatibility, but new writers no longer use
  // them. Idempotent, so re-running boot is safe.
  await pool.query(
    `ALTER TABLE deploy_records ADD COLUMN IF NOT EXISTS access_mode text NOT NULL DEFAULT 'owner-only'`,
  );
  await pool.query(
    `ALTER TABLE deploy_records ADD COLUMN IF NOT EXISTS org_membership_sources text[]`,
  );
  await pool.query(`ALTER TABLE deploy_records ADD COLUMN IF NOT EXISTS server_auth jsonb`);
  await pool.query(`ALTER TABLE deploy_records ADD COLUMN IF NOT EXISTS server_version text`);
  // Hosted packaged-asset mappings (P1.5 B2): the recovery source of truth for compiled asset URLs.
  // Additive + idempotent so existing alpha deploy_records tables gain the column on next boot.
  await pool.query(`ALTER TABLE deploy_records ADD COLUMN IF NOT EXISTS hosted_assets jsonb`);
  await pool.query(
    `ALTER TABLE deploy_records ADD COLUMN IF NOT EXISTS app_package_snapshot jsonb`,
  );
  await pool.query(`ALTER TABLE deploy_records ADD COLUMN IF NOT EXISTS owner_subject text`);
  await pool.query(
    `ALTER TABLE deploy_records ADD COLUMN IF NOT EXISTS deployment_source text CHECK (
      deployment_source IS NULL OR
      deployment_source IN ('console-example', 'cli', 'github', 'api')
    )`,
  );
  await pool.query(`ALTER TABLE deploy_records ALTER COLUMN caller_key_hash DROP NOT NULL`);
  // `deployment_version` holds `Date.now()` (a 13-digit ms timestamp), which overflows a 32-bit `int`.
  // Widen in place (idempotent; no data loss) so existing `int` columns become `bigint`.
  await pool.query(`ALTER TABLE deploy_records ALTER COLUMN deployment_version TYPE bigint`);
  // App soft-delete stamp (ADR 0117): additive + idempotent so existing alpha tables gain the column
  // on next boot. NULL = live; the partial index keeps sweeper scans cheap.
  await pool.query(`ALTER TABLE deploy_records ADD COLUMN IF NOT EXISTS archived_at timestamptz`);
  await ensureDeploymentLockSchema(pool);
  await pool.query(`
      CREATE INDEX IF NOT EXISTS deploy_records_archived_sweep
      ON deploy_records(archived_at)
      WHERE archived_at IS NOT NULL
    `);
  await pool.query(`DROP INDEX IF EXISTS deploy_records_one_active_env`);
  await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS deploy_records_one_active_legacy_env
      ON deploy_records(org_slug, app_slug, environment)
      WHERE active AND server_version IS NULL
    `);
  await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS deploy_records_one_active_version_env
      ON deploy_records(org_slug, app_slug, environment, server_version)
      WHERE active AND server_version IS NOT NULL
    `);
  await pool.query(`
      CREATE INDEX IF NOT EXISTS deploy_records_tenant_lookup
      ON deploy_records(org_slug, app_slug, environment, active, deployment_version DESC)
    `);
  await pool.query(`
      CREATE INDEX IF NOT EXISTS deploy_records_tenant_version_lookup
      ON deploy_records(org_slug, app_slug, environment, server_version, active, deployment_version DESC)
    `);
  const customerAuthAudience = await ensureCustomerAuthAudienceSchema(pool);
  await pool.query(`
      CREATE INDEX IF NOT EXISTS deploy_records_active_logical_app_idx
      ON deploy_records(org_slug, app_slug)
      WHERE active AND archived_at IS NULL
    `);
  // Backs the `apps` resource aggregation (`listApps`/`getApp`): one org-scoped scan grouped by
  // app/env, ordered by recency for the facing-deployment pick.
  await pool.query(`
      CREATE INDEX IF NOT EXISTS deploy_records_org_app_env_created_idx
      ON deploy_records(org_slug, app_slug, environment, created_at)
    `);
  await pool.query(`
      CREATE TABLE IF NOT EXISTS config_values (
        kind                text NOT NULL CHECK (kind IN ('secret', 'variable')),
        scope_level         text NOT NULL CHECK (scope_level IN ('org', 'app', 'env')),
        org_slug            text NOT NULL,
        app_slug            text NOT NULL DEFAULT '',
        environment         text NOT NULL DEFAULT '',
        name                text NOT NULL,
        secret_value        jsonb,
        variable_value      text,
        updated_at          timestamptz NOT NULL DEFAULT now(),
        updated_by_subject  text,
        updated_by_email    text,
        PRIMARY KEY (kind, scope_level, org_slug, app_slug, environment, name)
      )
    `);
  await pool.query(
    "ALTER TABLE config_values ADD COLUMN IF NOT EXISTS value_origin text CHECK (value_origin IS NULL OR value_origin = 'default')",
  );
  await pool.query(`ALTER TABLE config_values ADD COLUMN IF NOT EXISTS generation uuid NOT NULL DEFAULT gen_random_uuid();
    CREATE OR REPLACE FUNCTION refresh_config_generation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN NEW.generation:=gen_random_uuid(); RETURN NEW; END $$;
    DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='config_values'::regclass AND tgname='config_generation') THEN
      CREATE TRIGGER config_generation BEFORE INSERT OR UPDATE ON config_values FOR EACH ROW EXECUTE FUNCTION refresh_config_generation();
    END IF; END $$`);
  await ensurePersonalWorkspaceBindingSchema(pool);
  await ensureStateHandleSchema(pool);
  await ensureRequestEventSchema(pool);
  await ensureAlertRuleSchema(pool);
  await ensureDeveloperGrantSchema(pool);
  return customerAuthAudience;
}

/** Immutable canonical-principal ownership for the one personal organization. */
async function ensurePersonalWorkspaceBindingSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS personal_workspace_bindings (
      principal_subject       text PRIMARY KEY,
      org_slug                text NOT NULL UNIQUE REFERENCES orgs(slug) ON DELETE RESTRICT,
      created_at              timestamptz NOT NULL DEFAULT now()
    )
  `);
  // Older hosted schemas coupled this neutral principal binding to billing columns. Retain their data,
  // but permit portable/self-hosted writers to create a binding without commercial state.
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'personal_workspace_bindings'
          AND column_name = 'billing_identity_issuer'
      ) THEN
        ALTER TABLE personal_workspace_bindings ALTER COLUMN billing_identity_issuer DROP NOT NULL;
        ALTER TABLE personal_workspace_bindings ALTER COLUMN billing_subject DROP NOT NULL;
        ALTER TABLE personal_workspace_bindings ALTER COLUMN billing_account_id DROP NOT NULL;
      END IF;
    END $$
  `);
  await pool.query(`
    CREATE OR REPLACE FUNCTION reject_personal_workspace_binding_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'personal workspace binding is immutable';
    END
    $$
  `);
  await pool.query(`
    DROP TRIGGER IF EXISTS personal_workspace_bindings_immutable
    ON personal_workspace_bindings
  `);
  await pool.query(`
    CREATE TRIGGER personal_workspace_bindings_immutable
    BEFORE UPDATE OR DELETE ON personal_workspace_bindings
    FOR EACH ROW EXECUTE FUNCTION reject_personal_workspace_binding_mutation()
  `);
  await pool.query(`
    CREATE OR REPLACE FUNCTION reject_personal_workspace_owner_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP IN ('INSERT', 'UPDATE') AND EXISTS (
        SELECT 1 FROM personal_workspace_bindings
        WHERE principal_subject = NEW.subject AND org_slug = NEW.org_slug
      ) AND NEW.role <> 'owner' THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'personal workspace owner is immutable',
          CONSTRAINT = 'personal_workspace_owner_immutable';
      END IF;
      IF TG_OP IN ('UPDATE', 'DELETE') AND EXISTS (
        SELECT 1 FROM personal_workspace_bindings
        WHERE principal_subject = OLD.subject AND org_slug = OLD.org_slug
      ) THEN
        IF TG_OP = 'DELETE' OR NEW.subject <> OLD.subject OR NEW.org_slug <> OLD.org_slug
           OR NEW.role <> 'owner' THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'personal workspace owner is immutable',
            CONSTRAINT = 'personal_workspace_owner_immutable';
        END IF;
      END IF;
      IF TG_OP = 'DELETE' THEN
        RETURN OLD;
      END IF;
      RETURN NEW;
    END
    $$
  `);
  await pool.query(`
    DROP TRIGGER IF EXISTS personal_workspace_owner_immutable
    ON org_members
  `);
  await pool.query(`
    CREATE TRIGGER personal_workspace_owner_immutable
    BEFORE INSERT OR UPDATE OR DELETE ON org_members
    FOR EACH ROW EXECUTE FUNCTION reject_personal_workspace_owner_mutation()
  `);
}

/** Idempotent persistence schema for revocable, client-bound Developer Access Grants. */
export async function ensureDeveloperGrantSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS developer_access_grants (
      id            text PRIMARY KEY,
      client_id     text NOT NULL,
      subject       text NOT NULL,
      org_slug      text NOT NULL,
      environments  jsonb NOT NULL,
      capabilities  jsonb NOT NULL,
      created_at    timestamptz NOT NULL,
      updated_at    timestamptz NOT NULL,
      expires_at    timestamptz,
      revoked_at    timestamptz,
      grant_version smallint NOT NULL DEFAULT 1,
      resource      text,
      access_model  text,
      CHECK (jsonb_typeof(environments) = 'array' AND jsonb_array_length(environments) > 0),
      CHECK (jsonb_typeof(capabilities) = 'array' AND jsonb_array_length(capabilities) > 0),
      CHECK (updated_at >= created_at),
      CHECK (expires_at IS NULL OR expires_at > created_at),
      CHECK (revoked_at IS NULL OR revoked_at >= created_at)
    )
  `);
  await pool.query(
    `ALTER TABLE developer_access_grants
       ADD COLUMN IF NOT EXISTS grant_version smallint NOT NULL DEFAULT 1`,
  );
  await pool.query(`ALTER TABLE developer_access_grants ADD COLUMN IF NOT EXISTS resource text`);
  await pool.query(
    `ALTER TABLE developer_access_grants ADD COLUMN IF NOT EXISTS access_model text`,
  );
  await pool.query(`ALTER TABLE developer_access_grants ALTER COLUMN org_slug DROP NOT NULL`);
  await pool.query(`ALTER TABLE developer_access_grants ALTER COLUMN environments DROP NOT NULL`);
  await pool.query(`
    UPDATE developer_access_grants
       SET revoked_at = COALESCE(revoked_at, now()),
           updated_at = CASE WHEN revoked_at IS NULL THEN now() ELSE updated_at END
     WHERE grant_version = 1
       AND revoked_at IS NULL
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS developer_access_grants_subject_idx
    ON developer_access_grants(subject)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS developer_access_grants_client_idx
    ON developer_access_grants(client_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS developer_access_grants_org_idx
    ON developer_access_grants(org_slug)
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS developer_access_grants_active_tuple_idx
    ON developer_access_grants(client_id, subject, resource)
    WHERE grant_version = 2 AND revoked_at IS NULL
  `);
}
