import type { Pool } from 'pg';
import { ensureDeviceAuthorizationSchema } from './device-store-postgres-schema.js';

/** Creates and additively upgrades the shared OAuth authorization-server tables. */
export async function ensureOAuthStoreSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id  text PRIMARY KEY,
      client     jsonb NOT NULL,
      first_party_owner text,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query('ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS first_party_owner text');
  await pool.query(`
    ALTER TABLE oauth_clients DROP CONSTRAINT IF EXISTS oauth_clients_first_party_owner_check;
    ALTER TABLE oauth_clients ADD CONSTRAINT oauth_clients_first_party_owner_check
      CHECK (first_party_owner IS NULL OR first_party_owner IN ('console', 'portal'))
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oauth_pending_authorizations (
      state          text PRIMARY KEY,
      client_id      text NOT NULL,
      redirect_uri   text NOT NULL,
      code_challenge text NOT NULL,
      client_state   text,
      resource       text NOT NULL,
      scope          text,
      upstream_provider text NOT NULL DEFAULT 'google',
      expires_at     timestamptz NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
      code           text PRIMARY KEY,
      client_id      text NOT NULL,
      code_challenge text NOT NULL,
      redirect_uri   text NOT NULL,
      resource       text NOT NULL,
      owner_subject  text NOT NULL,
      owner_email    text,
      owner_locale   text,
      owner_time_zone text,
      scope          text,
      roles          jsonb,
      identity_kind  text,
      identity_provider text,
      customer_issuer text,
      developer_grant_id text,
      auth_time      timestamptz,
      upstream_expires_at timestamptz,
      expires_at     timestamptz NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
      token         text PRIMARY KEY,
      client_id     text NOT NULL,
      owner_subject text NOT NULL,
      owner_email   text,
      owner_locale  text,
      owner_time_zone text,
      resource      text NOT NULL,
      scope         text,
      roles         jsonb,
      identity_kind text,
      identity_provider text,
      customer_issuer text,
      developer_grant_id text,
      auth_time     timestamptz,
      upstream_expires_at timestamptz,
      expires_at    timestamptz NOT NULL,
      family_id     text,
      rotated_at    timestamptz,
      superseded_by text
    )
  `);
  await pool.query(
    "ALTER TABLE oauth_pending_authorizations ADD COLUMN IF NOT EXISTS upstream_provider text NOT NULL DEFAULT 'google'",
  );
  await pool.query(
    'ALTER TABLE oauth_authorization_codes ADD COLUMN IF NOT EXISTS identity_kind text',
  );
  await pool.query(
    'ALTER TABLE oauth_authorization_codes ADD COLUMN IF NOT EXISTS owner_locale text',
  );
  await pool.query(
    'ALTER TABLE oauth_authorization_codes ADD COLUMN IF NOT EXISTS owner_time_zone text',
  );
  await pool.query(
    'ALTER TABLE oauth_authorization_codes ADD COLUMN IF NOT EXISTS identity_provider text',
  );
  await pool.query(
    'ALTER TABLE oauth_authorization_codes ADD COLUMN IF NOT EXISTS customer_issuer text',
  );
  await pool.query(
    'ALTER TABLE oauth_authorization_codes ADD COLUMN IF NOT EXISTS developer_grant_id text',
  );
  await pool.query(
    'ALTER TABLE oauth_authorization_codes ADD COLUMN IF NOT EXISTS auth_time timestamptz',
  );
  await pool.query('ALTER TABLE oauth_authorization_codes ADD COLUMN IF NOT EXISTS roles jsonb');
  await pool.query(
    'ALTER TABLE oauth_authorization_codes ADD COLUMN IF NOT EXISTS upstream_expires_at timestamptz',
  );
  await pool.query('ALTER TABLE oauth_refresh_tokens ADD COLUMN IF NOT EXISTS identity_kind text');
  await pool.query('ALTER TABLE oauth_refresh_tokens ADD COLUMN IF NOT EXISTS owner_locale text');
  await pool.query(
    'ALTER TABLE oauth_refresh_tokens ADD COLUMN IF NOT EXISTS owner_time_zone text',
  );
  await pool.query(
    'ALTER TABLE oauth_refresh_tokens ADD COLUMN IF NOT EXISTS identity_provider text',
  );
  await pool.query(
    'ALTER TABLE oauth_refresh_tokens ADD COLUMN IF NOT EXISTS customer_issuer text',
  );
  await pool.query(
    'ALTER TABLE oauth_refresh_tokens ADD COLUMN IF NOT EXISTS developer_grant_id text',
  );
  await pool.query(
    'ALTER TABLE oauth_refresh_tokens ADD COLUMN IF NOT EXISTS auth_time timestamptz',
  );
  await pool.query('ALTER TABLE oauth_refresh_tokens ADD COLUMN IF NOT EXISTS roles jsonb');
  await pool.query(
    'ALTER TABLE oauth_refresh_tokens ADD COLUMN IF NOT EXISTS upstream_expires_at timestamptz',
  );
  await pool.query('ALTER TABLE oauth_refresh_tokens ADD COLUMN IF NOT EXISTS family_id text');
  await pool.query(
    'ALTER TABLE oauth_refresh_tokens ADD COLUMN IF NOT EXISTS rotated_at timestamptz',
  );
  await pool.query('ALTER TABLE oauth_refresh_tokens ADD COLUMN IF NOT EXISTS superseded_by text');
  await pool.query(
    'CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_family_id_idx ON oauth_refresh_tokens (family_id)',
  );
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oauth_consent_grants (
      client_id     text NOT NULL,
      owner_subject text NOT NULL,
      resource      text NOT NULL,
      identity_kind text NOT NULL DEFAULT 'platform'
        CHECK (identity_kind IN ('platform', 'customer')),
      granted_at    timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (client_id, owner_subject, resource)
    )
  `);
  await pool.query(`
    ALTER TABLE oauth_consent_grants
      ADD COLUMN IF NOT EXISTS identity_kind text NOT NULL DEFAULT 'platform'
        CHECK (identity_kind IN ('platform', 'customer'))
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oauth_consent_grant_provenance (
      client_id     text NOT NULL,
      owner_subject text NOT NULL,
      resource      text NOT NULL,
      identity_kind text NOT NULL CHECK (identity_kind IN ('platform', 'customer')),
      granted_at    timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (client_id, owner_subject, resource, identity_kind)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oauth_delegated_credentials (
      resource   text NOT NULL,
      provider   text NOT NULL,
      subject    text NOT NULL,
      credential jsonb NOT NULL,
      updated_at timestamptz NOT NULL,
      PRIMARY KEY (resource, provider, subject)
    )
  `);
  await ensureDeviceAuthorizationSchema(pool);
}
