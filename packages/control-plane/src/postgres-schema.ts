import type { Pool } from 'pg';
import { ensureMcpSubdomainClaimSchema } from './postgres-mcp-subdomain-schema.js';
import { ensureOrganizationAgreementSchema } from './postgres-organization-agreements.js';

/** Idempotent organization, membership, signup, and onboarding persistence schema. */
export async function ensureOrganizationSchema(pool: Pool): Promise<void> {
  await pool.query(`
      CREATE TABLE IF NOT EXISTS orgs (
        slug        text PRIMARY KEY,
        display_name text,
        created_at  timestamptz NOT NULL DEFAULT now()
      )
    `);
  await pool.query(`
      CREATE TABLE IF NOT EXISTS org_members (
        org_slug    text NOT NULL REFERENCES orgs(slug) ON DELETE CASCADE,
        subject     text NOT NULL,
        email       text NOT NULL,
        role        text NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (org_slug, subject)
      )
    `);
  await pool.query(`
      CREATE TABLE IF NOT EXISTS welcome_email_outbox (
        subject             text PRIMARY KEY,
        org_slug            text NOT NULL REFERENCES orgs(slug) ON DELETE CASCADE,
        email               text NOT NULL,
        first_name          text,
        created_at          timestamptz NOT NULL DEFAULT now(),
        attempt_count       integer NOT NULL DEFAULT 0,
        next_attempt_at     timestamptz NOT NULL DEFAULT now(),
        lease_expires_at    timestamptz,
        sent_at             timestamptz,
        provider_message_id text,
        last_error_code     text
      )
    `);
  await pool.query(`ALTER TABLE welcome_email_outbox ADD COLUMN IF NOT EXISTS first_name text`);
  await pool.query(`
      CREATE INDEX IF NOT EXISTS welcome_email_outbox_pending_idx
      ON welcome_email_outbox (next_attempt_at, created_at)
      WHERE sent_at IS NULL
    `);
  await pool.query(`
      CREATE TABLE IF NOT EXISTS org_domains (
        org_slug        text NOT NULL REFERENCES orgs(slug) ON DELETE CASCADE,
        domain          text NOT NULL,
        challenge       text NOT NULL,
        created_at      timestamptz NOT NULL DEFAULT now(),
        verified_at     timestamptz,
        last_checked_at timestamptz,
        PRIMARY KEY (org_slug, domain)
      )
    `);
  await pool.query(`
      CREATE TABLE IF NOT EXISTS org_openai_apps_challenges (
        org_slug            text PRIMARY KEY REFERENCES orgs(slug) ON DELETE CASCADE,
        challenge           text NOT NULL,
        updated_at          timestamptz NOT NULL DEFAULT now(),
        updated_by_subject  text,
        updated_by_email    text
      )
    `);
  await pool.query(`
      CREATE TABLE IF NOT EXISTS signup_allowlist (
        kind               text NOT NULL CHECK (kind IN ('subject', 'domain')),
        value              text NOT NULL,
        created_at         timestamptz NOT NULL DEFAULT now(),
        created_by_subject text,
        PRIMARY KEY (kind, value)
      )
    `);
  await pool.query(`
      CREATE TABLE IF NOT EXISTS org_invitations (
        token_hash        text PRIMARY KEY,
        org_slug          text NOT NULL REFERENCES orgs(slug) ON DELETE CASCADE,
        email             text NOT NULL,
        role              text NOT NULL,
        created_at        timestamptz NOT NULL DEFAULT now(),
        expires_at        timestamptz NOT NULL,
        created_by_subject text NOT NULL,
        created_by_email  text,
        accepted_at       timestamptz
      )
    `);
  await pool.query(`
      CREATE INDEX IF NOT EXISTS org_invitations_org_email_idx
      ON org_invitations (org_slug, email, expires_at)
    `);
  await ensureMcpSubdomainClaimSchema(pool);
  await ensureOrganizationAgreementSchema(pool);
}
