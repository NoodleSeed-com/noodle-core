import type { Pool } from 'pg';

// Match ECMAScript String.trim() exactly, independent of the database locale.
const SQL_TRIM_CHARACTERS = String.raw`U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'`;

export interface CustomerAuthAudienceReconciliation {
  readonly invalidBoundaries: number;
  readonly conflictingBindings: number;
  readonly conflictingBoundaries: number;
}

interface CustomerAuthAudienceReconciliationRow {
  readonly invalid_boundaries: number;
  readonly conflicting_bindings: number;
  readonly conflicting_boundaries: number;
}

/**
 * Install and backfill the database-owned customer audience invariant.
 *
 * Row triggers retain released ownership reservations and use compatible NOWAIT key-share/update locks to
 * claim or transfer them instead of deleting OLD bindings. A non-blocking per-binding advisory lock closes
 * the absent-row insertion race. This removes OLD→NEW cycles while letting preceding revisions participate
 * without a global lock or rolling-version lock inversion.
 */
export async function ensureCustomerAuthAudienceSchema(
  pool: Pick<Pool, 'connect'>,
): Promise<CustomerAuthAudienceReconciliation> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE deploy_records IN SHARE ROW EXCLUSIVE MODE');
    await client.query(`
      CREATE INDEX IF NOT EXISTS deploy_records_active_customer_auth_v2
      ON deploy_records(org_slug, app_slug, environment)
      INCLUDE(server_auth)
      WHERE active AND archived_at IS NULL AND server_auth IS NOT NULL
        AND (access_mode = 'customers' OR (access_mode = 'mixed' AND schema_version = 2))
    `);
    // Install the replacement before retiring the v1 predicate; repeated startup keeps the v2 index.
    await client.query('DROP INDEX IF EXISTS deploy_records_active_customer_auth');
    await client.query(`
      CREATE TABLE IF NOT EXISTS customer_auth_audience_bindings (
        issuer      text NOT NULL,
        audience    text NOT NULL,
        org_slug    text NOT NULL,
        app_slug    text NOT NULL,
        environment text NOT NULL,
        PRIMARY KEY (issuer, audience)
      )
    `);
    await client.query(`
      CREATE OR REPLACE FUNCTION noodle_customer_auth_is_valid(auth jsonb)
      RETURNS boolean
      LANGUAGE sql
      IMMUTABLE
      AS $$
        SELECT CASE
          WHEN auth IS NULL OR jsonb_typeof(auth) <> 'object'
            THEN false
          WHEN auth ? 'kind' AND jsonb_typeof(auth->'kind') <> 'string'
            THEN false
          WHEN COALESCE(auth->>'kind', 'oidc') = 'bridge'
            THEN jsonb_typeof(auth->'provider') = 'string'
              AND COALESCE(btrim(auth->>'provider', ${SQL_TRIM_CHARACTERS}), '') <> ''
          WHEN COALESCE(auth->>'kind', 'oidc') = 'federatedOidc'
            THEN jsonb_typeof(auth->'issuers') = 'array'
              AND jsonb_array_length(
                CASE
                  WHEN jsonb_typeof(auth->'issuers') = 'array' THEN auth->'issuers'
                  ELSE '[]'::jsonb
                END
              ) > 0
              AND NOT EXISTS (
                SELECT 1
                FROM jsonb_array_elements(
                  CASE
                    WHEN jsonb_typeof(auth->'issuers') = 'array' THEN auth->'issuers'
                    ELSE '[]'::jsonb
                  END
                ) issuer
                WHERE jsonb_typeof(issuer) <> 'object'
                  OR jsonb_typeof(issuer->'issuer') IS DISTINCT FROM 'string'
                  OR jsonb_typeof(issuer->'audience') IS DISTINCT FROM 'string'
                  OR COALESCE(btrim(issuer->>'issuer', ${SQL_TRIM_CHARACTERS}), '') = ''
                  OR COALESCE(btrim(issuer->>'audience', ${SQL_TRIM_CHARACTERS}), '') = ''
              )
          WHEN COALESCE(auth->>'kind', 'oidc') = 'oidc'
            THEN jsonb_typeof(auth->'issuer') = 'string'
              AND jsonb_typeof(auth->'audience') = 'string'
              AND COALESCE(btrim(auth->>'issuer', ${SQL_TRIM_CHARACTERS}), '') <> ''
              AND COALESCE(btrim(auth->>'audience', ${SQL_TRIM_CHARACTERS}), '') <> ''
          ELSE false
        END
      $$
    `);
    await client.query(`
      CREATE OR REPLACE FUNCTION noodle_customer_auth_bindings(auth jsonb)
      RETURNS TABLE(issuer text, audience text)
      LANGUAGE sql
      IMMUTABLE
      AS $$
        SELECT regexp_replace(auth->>'issuer', '/+$', ''), auth->>'audience'
        WHERE COALESCE(auth->>'kind', 'oidc') = 'oidc'
        UNION ALL
        SELECT regexp_replace(candidate->>'issuer', '/+$', ''), candidate->>'audience'
        FROM jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(auth->'issuers') = 'array' THEN auth->'issuers'
            ELSE '[]'::jsonb
          END
        ) candidate
        WHERE auth->>'kind' = 'federatedOidc'
      $$
    `);
    await client.query(`
      CREATE OR REPLACE FUNCTION noodle_reconcile_customer_auth_audiences()
      RETURNS void
      LANGUAGE plpgsql
      AS $$
      BEGIN
        DELETE FROM customer_auth_audience_bindings;
        INSERT INTO customer_auth_audience_bindings
          (issuer, audience, org_slug, app_slug, environment)
        SELECT DISTINCT ON (binding.issuer, binding.audience)
                        binding.issuer, binding.audience,
                        record.org_slug, record.app_slug, record.environment
        FROM deploy_records record
        CROSS JOIN LATERAL noodle_customer_auth_bindings(record.server_auth) binding
        WHERE record.active
          AND record.archived_at IS NULL
          AND (record.access_mode = 'customers'
            OR (record.access_mode = 'mixed' AND record.schema_version = 2
                AND record.server_auth IS NOT NULL))
          AND noodle_customer_auth_is_valid(record.server_auth)
        ORDER BY binding.issuer, binding.audience,
                 record.org_slug, record.app_slug, record.environment;
      END
      $$
    `);
    await client.query(`
      CREATE OR REPLACE FUNCTION noodle_customer_auth_audience_row_trigger()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        binding record;
        owner_org text;
        owner_app text;
        owner_environment text;
      BEGIN
        IF TG_OP <> 'DELETE'
          AND NEW.active
          AND NEW.archived_at IS NULL
          AND (NEW.access_mode = 'customers'
            OR (NEW.access_mode = 'mixed' AND NEW.schema_version = 2
                AND NEW.server_auth IS NOT NULL))
        THEN
          IF NOT noodle_customer_auth_is_valid(NEW.server_auth) THEN
            RAISE EXCEPTION USING
              ERRCODE = 'NDA02',
              MESSAGE = 'customer auth audience projection invalid';
          END IF;
          FOR binding IN
            SELECT *
            FROM noodle_customer_auth_bindings(NEW.server_auth)
            ORDER BY issuer, audience
          LOOP
            IF EXISTS (
              SELECT 1
              FROM deploy_records current_record
              CROSS JOIN LATERAL
                noodle_customer_auth_bindings(current_record.server_auth) current_binding
              WHERE current_record.active
                AND current_record.archived_at IS NULL
                AND (current_record.access_mode = 'customers'
                  OR (current_record.access_mode = 'mixed' AND current_record.schema_version = 2
                      AND current_record.server_auth IS NOT NULL))
                AND noodle_customer_auth_is_valid(current_record.server_auth)
                AND current_binding.issuer = binding.issuer
                AND current_binding.audience = binding.audience
                AND (
                  current_record.org_slug <> NEW.org_slug
                  OR current_record.app_slug <> NEW.app_slug
                  OR current_record.environment <> NEW.environment
                )
            ) THEN
              RAISE EXCEPTION USING
                ERRCODE = 'NDA01',
                MESSAGE = 'customer auth audience conflict';
            END IF;
            <<claim_binding>>
            LOOP
              SELECT ownership.org_slug, ownership.app_slug, ownership.environment
                INTO owner_org, owner_app, owner_environment
              FROM customer_auth_audience_bindings ownership
              WHERE ownership.issuer = binding.issuer
                AND ownership.audience = binding.audience;
              IF NOT FOUND THEN
                IF NOT pg_try_advisory_xact_lock(
                  hashtextextended(
                    jsonb_build_array(binding.issuer, binding.audience)::text,
                    0
                  )
                ) THEN
                  RAISE EXCEPTION USING
                    ERRCODE = 'NDA01',
                    MESSAGE = 'customer auth audience conflict';
                END IF;
                SELECT ownership.org_slug, ownership.app_slug, ownership.environment
                  INTO owner_org, owner_app, owner_environment
                FROM customer_auth_audience_bindings ownership
                WHERE ownership.issuer = binding.issuer
                  AND ownership.audience = binding.audience;
                IF FOUND THEN
                  CONTINUE claim_binding;
                END IF;
                INSERT INTO customer_auth_audience_bindings
                  (issuer, audience, org_slug, app_slug, environment)
                VALUES (
                  binding.issuer,
                  binding.audience,
                  NEW.org_slug,
                  NEW.app_slug,
                  NEW.environment
                );
                EXIT claim_binding;
              END IF;

              IF owner_org = NEW.org_slug
                AND owner_app = NEW.app_slug
                AND owner_environment = NEW.environment
              THEN
                PERFORM 1
                FROM customer_auth_audience_bindings ownership
                WHERE ownership.issuer = binding.issuer
                  AND ownership.audience = binding.audience
                  AND ownership.org_slug = owner_org
                  AND ownership.app_slug = owner_app
                  AND ownership.environment = owner_environment
                FOR KEY SHARE NOWAIT;
                IF FOUND THEN
                  EXIT claim_binding;
                END IF;
                CONTINUE claim_binding;
              END IF;

              SELECT ownership.org_slug, ownership.app_slug, ownership.environment
                INTO owner_org, owner_app, owner_environment
              FROM customer_auth_audience_bindings ownership
              WHERE ownership.issuer = binding.issuer
                AND ownership.audience = binding.audience
              FOR UPDATE NOWAIT;
              IF NOT FOUND THEN
                CONTINUE claim_binding;
              END IF;
              IF owner_org = NEW.org_slug
                AND owner_app = NEW.app_slug
                AND owner_environment = NEW.environment
              THEN
                EXIT claim_binding;
              END IF;
              IF EXISTS (
                SELECT 1
                FROM deploy_records current_record
                CROSS JOIN LATERAL
                  noodle_customer_auth_bindings(current_record.server_auth) current_binding
                WHERE current_record.active
                  AND current_record.archived_at IS NULL
                  AND (current_record.access_mode = 'customers'
                    OR (current_record.access_mode = 'mixed' AND current_record.schema_version = 2
                        AND current_record.server_auth IS NOT NULL))
                  AND current_record.org_slug = owner_org
                  AND current_record.app_slug = owner_app
                  AND current_record.environment = owner_environment
                  AND current_binding.issuer = binding.issuer
                  AND current_binding.audience = binding.audience
              ) THEN
                RAISE EXCEPTION USING
                  ERRCODE = 'NDA01',
                  MESSAGE = 'customer auth audience conflict';
              END IF;
              UPDATE customer_auth_audience_bindings ownership
                SET org_slug = NEW.org_slug,
                    app_slug = NEW.app_slug,
                    environment = NEW.environment
              WHERE ownership.issuer = binding.issuer
                AND ownership.audience = binding.audience;
              EXIT claim_binding;
            END LOOP claim_binding;
          END LOOP;
        END IF;
        RETURN NULL;
      EXCEPTION
        WHEN lock_not_available OR unique_violation THEN
          RAISE EXCEPTION USING
            ERRCODE = 'NDA01',
            MESSAGE = 'customer auth audience conflict';
      END
      $$
    `);
    await client.query(
      'DROP TRIGGER IF EXISTS deploy_records_customer_auth_audience ON deploy_records',
    );
    await client.query(`
      CREATE TRIGGER deploy_records_customer_auth_audience
      AFTER INSERT OR UPDATE OR DELETE ON deploy_records
      FOR EACH ROW
      EXECUTE FUNCTION noodle_customer_auth_audience_row_trigger()
    `);
    await client.query('SELECT noodle_reconcile_customer_auth_audiences()');
    const report = await client.query<CustomerAuthAudienceReconciliationRow>(`
      WITH active_customer_records AS (
        SELECT org_slug, app_slug, environment, server_auth
        FROM deploy_records
        WHERE active
          AND archived_at IS NULL
          AND (access_mode = 'customers'
            OR (access_mode = 'mixed' AND schema_version = 2
                AND server_auth IS NOT NULL))
      ),
      valid_bindings AS (
        SELECT DISTINCT binding.issuer, binding.audience,
                        record.org_slug, record.app_slug, record.environment
        FROM active_customer_records record
        CROSS JOIN LATERAL noodle_customer_auth_bindings(record.server_auth) binding
        WHERE noodle_customer_auth_is_valid(record.server_auth)
      ),
      conflicting_bindings AS (
        SELECT issuer, audience
        FROM valid_bindings
        GROUP BY issuer, audience
        HAVING count(*) > 1
      ),
      conflicting_boundaries AS (
        SELECT DISTINCT binding.org_slug, binding.app_slug, binding.environment
        FROM valid_bindings binding
        INNER JOIN conflicting_bindings conflict
          ON conflict.issuer = binding.issuer
         AND conflict.audience = binding.audience
      )
      SELECT
        (
          SELECT count(DISTINCT ROW(org_slug, app_slug, environment))::int
          FROM active_customer_records
          WHERE NOT noodle_customer_auth_is_valid(server_auth)
        ) AS invalid_boundaries,
        (SELECT count(*)::int FROM conflicting_bindings) AS conflicting_bindings,
        (SELECT count(*)::int FROM conflicting_boundaries) AS conflicting_boundaries
    `);
    const row = report.rows[0];
    if (row === undefined) {
      throw new Error('customer auth audience reconciliation report missing');
    }
    await client.query('COMMIT');
    return {
      invalidBoundaries: row.invalid_boundaries,
      conflictingBindings: row.conflicting_bindings,
      conflictingBoundaries: row.conflicting_boundaries,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
