import type { Pool } from 'pg';

/** Additively installs the durable service-principal and assertion-replay tables. */
export async function ensureServicePrincipalSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oauth_service_principals (
      principal_id       text PRIMARY KEY
        CHECK (principal_id ~ '^spn_[0-9a-f-]{36}$'),
      org_slug           text NOT NULL,
      name               text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
      status             text NOT NULL CHECK (status IN ('active', 'revoked')),
      created_by_subject text NOT NULL,
      created_at         timestamptz NOT NULL,
      updated_at         timestamptz NOT NULL,
      revoked_at         timestamptz,
      revoked_by_subject text,
      UNIQUE (principal_id, org_slug)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oauth_service_principal_grants (
      grant_id           text PRIMARY KEY
        CHECK (grant_id ~ '^spg_[0-9a-f-]{36}$'),
      principal_id       text NOT NULL,
      org_slug           text NOT NULL,
      app_slug           text NOT NULL,
      environment        text NOT NULL,
      scopes             text[] NOT NULL CHECK (cardinality(scopes) <= 64),
      status             text NOT NULL CHECK (status IN ('active', 'revoked')),
      created_by_subject text NOT NULL,
      created_at         timestamptz NOT NULL,
      updated_at         timestamptz NOT NULL,
      revoked_at         timestamptz,
      revoked_by_subject text,
      FOREIGN KEY (principal_id, org_slug)
        REFERENCES oauth_service_principals (principal_id, org_slug)
        ON DELETE RESTRICT
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS oauth_service_principal_active_grant_target_uq
      ON oauth_service_principal_grants (principal_id, app_slug, environment)
      WHERE status = 'active'
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS oauth_service_principal_grants_lookup_idx
      ON oauth_service_principal_grants (principal_id, status)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oauth_service_principal_credentials (
      credential_id      text PRIMARY KEY
        CHECK (credential_id ~ '^spc_[0-9a-f-]{36}$'),
      principal_id       text NOT NULL,
      org_slug           text NOT NULL,
      kind               text NOT NULL CHECK (kind IN ('public_jwk', 'client_secret')),
      label              text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
      algorithm          text CHECK (algorithm IN ('RS256', 'ES256')),
      kid                text CHECK (kid IS NULL OR char_length(kid) BETWEEN 1 AND 200),
      public_jwk         jsonb,
      secret_digest      text,
      status             text NOT NULL CHECK (status IN ('active', 'revoked')),
      created_by_subject text NOT NULL,
      created_at         timestamptz NOT NULL,
      updated_at         timestamptz NOT NULL,
      expires_at         timestamptz,
      revoked_at         timestamptz,
      revoked_by_subject text,
      FOREIGN KEY (principal_id, org_slug)
        REFERENCES oauth_service_principals (principal_id, org_slug)
        ON DELETE RESTRICT,
      CHECK (
        (kind = 'public_jwk' AND algorithm IS NOT NULL AND public_jwk IS NOT NULL
          AND secret_digest IS NULL)
        OR
        (kind = 'client_secret' AND algorithm IS NULL AND kid IS NULL
          AND public_jwk IS NULL AND secret_digest IS NOT NULL)
      )
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS oauth_service_principal_active_credentials_idx
      ON oauth_service_principal_credentials (principal_id, kind, expires_at)
      WHERE status = 'active'
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oauth_client_assertion_nonces (
      credential_id text NOT NULL
        REFERENCES oauth_service_principal_credentials (credential_id) ON DELETE CASCADE,
      jti           text NOT NULL CHECK (char_length(jti) BETWEEN 1 AND 200),
      expires_at    timestamptz NOT NULL,
      created_at    timestamptz NOT NULL,
      PRIMARY KEY (credential_id, jti)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS oauth_client_assertion_nonces_expiry_idx
      ON oauth_client_assertion_nonces (expires_at)
  `);
}
