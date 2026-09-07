import type { Pool } from 'pg';

/** Install and reconcile the append-only MCP-subdomain claim ledger in one organization-locked migration. */
export async function ensureMcpSubdomainClaimSchema(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE orgs IN SHARE ROW EXCLUSIVE MODE');
    await client.query(`
      CREATE TABLE IF NOT EXISTS org_mcp_subdomain_claims (
        subdomain            text PRIMARY KEY,
        org_slug             text NOT NULL REFERENCES orgs(slug) ON DELETE RESTRICT,
        state                text NOT NULL CHECK (state IN ('active', 'retired')),
        claimed_at           timestamptz NOT NULL DEFAULT now(),
        retired_at           timestamptz,
        retired_by_principal text,
        CONSTRAINT org_mcp_subdomain_claim_label_valid CHECK (
          subdomain ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
          AND subdomain NOT IN ('deploy', 'healthz', 'readyz', 'v1', 'o', 'mcp', 'local')
        ),
        CONSTRAINT org_mcp_subdomain_claim_retirement_valid CHECK (
          (state = 'active' AND retired_at IS NULL AND retired_by_principal IS NULL)
          OR
          (state = 'retired' AND retired_at IS NOT NULL AND retired_by_principal IS NOT NULL)
        )
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS org_mcp_subdomain_claims_one_active_org_idx
      ON org_mcp_subdomain_claims (org_slug)
      WHERE state = 'active'
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS org_mcp_subdomain_mutations (
        org_slug              text NOT NULL REFERENCES orgs(slug) ON DELETE RESTRICT,
        idempotency_key_hash  text NOT NULL,
        request_fingerprint   text NOT NULL,
        outcome               text NOT NULL CHECK (outcome IN ('changed', 'noop')),
        previous_subdomain    text NOT NULL,
        current_subdomain     text NOT NULL,
        actor_principal_id    text NOT NULL,
        recorded_at           timestamptz NOT NULL,
        changed_at            timestamptz,
        PRIMARY KEY (org_slug, idempotency_key_hash),
        CONSTRAINT org_mcp_subdomain_mutation_change_valid CHECK (
          (outcome = 'changed' AND changed_at IS NOT NULL)
          OR (outcome = 'noop' AND changed_at IS NULL)
        )
      )
    `);
    await client.query(`
      CREATE OR REPLACE FUNCTION guard_org_mcp_subdomain_claim_mutation()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'MCP subdomain claims are append-only' USING ERRCODE = '23514';
        END IF;
        IF OLD.subdomain IS DISTINCT FROM NEW.subdomain
          OR OLD.org_slug IS DISTINCT FROM NEW.org_slug
          OR OLD.claimed_at IS DISTINCT FROM NEW.claimed_at
          OR OLD.state <> 'active'
          OR NEW.state <> 'retired'
          OR OLD.retired_at IS NOT NULL
          OR OLD.retired_by_principal IS NOT NULL
          OR NEW.retired_at IS NULL
          OR NEW.retired_by_principal IS NULL THEN
          RAISE EXCEPTION 'invalid MCP subdomain claim transition' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END
      $function$
    `);
    await client.query(`
      DROP TRIGGER IF EXISTS guard_org_mcp_subdomain_claim_mutation
      ON org_mcp_subdomain_claims
    `);
    await client.query(`
      CREATE TRIGGER guard_org_mcp_subdomain_claim_mutation
      BEFORE UPDATE OR DELETE ON org_mcp_subdomain_claims
      FOR EACH ROW EXECUTE FUNCTION guard_org_mcp_subdomain_claim_mutation()
    `);
    await client.query(`
      INSERT INTO org_mcp_subdomain_claims (subdomain, org_slug, state, claimed_at)
      SELECT slug, slug, 'active', created_at
      FROM orgs
      WHERE slug <> 'local'
      ON CONFLICT (subdomain) DO NOTHING
    `);
    const { rows } = await client.query<{ invalid_count: string }>(`
      SELECT count(*)::text AS invalid_count
      FROM (
        SELECT orgs.slug
        FROM orgs
        LEFT JOIN org_mcp_subdomain_claims AS claims
          ON claims.org_slug = orgs.slug AND claims.state = 'active'
        WHERE orgs.slug <> 'local'
        GROUP BY orgs.slug
        HAVING count(claims.subdomain) <> 1
      ) AS invalid_orgs
    `);
    if (rows[0]?.invalid_count !== '0') {
      throw new Error('MCP subdomain backfill did not establish one active claim per hosted org');
    }
    await client.query(`
      CREATE OR REPLACE FUNCTION claim_default_org_mcp_subdomain()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        IF NEW.slug <> 'local' THEN
          INSERT INTO org_mcp_subdomain_claims (subdomain, org_slug, state, claimed_at)
          VALUES (NEW.slug, NEW.slug, 'active', NEW.created_at);
        END IF;
        RETURN NEW;
      END
      $function$
    `);
    await client.query('DROP TRIGGER IF EXISTS claim_default_org_mcp_subdomain ON orgs');
    await client.query(`
      CREATE TRIGGER claim_default_org_mcp_subdomain
      AFTER INSERT ON orgs
      FOR EACH ROW EXECUTE FUNCTION claim_default_org_mcp_subdomain()
    `);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
