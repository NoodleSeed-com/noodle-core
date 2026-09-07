import type { Pool } from 'pg';

export async function ensureDeviceAuthorizationSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oauth_device_authorizations (
      device_code text PRIMARY KEY,
      user_code text UNIQUE NOT NULL,
      client_id text NOT NULL,
      resource text NOT NULL,
      scope text,
      status text NOT NULL,
      owner_subject text,
      owner_email text,
      owner_locale text,
      owner_time_zone text,
      identity_kind text,
      identity_provider text,
      customer_issuer text,
      developer_grant_id text,
      expires_at timestamptz NOT NULL,
      next_poll_at timestamptz NOT NULL,
      interval_seconds integer NOT NULL
    )
  `);
  await pool.query(
    'ALTER TABLE oauth_device_authorizations ADD COLUMN IF NOT EXISTS customer_issuer text',
  );
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oauth_device_browser_sessions (
      state text PRIMARY KEY,
      device_code text NOT NULL,
      client_id text NOT NULL,
      resource text NOT NULL,
      code_challenge text NOT NULL,
      expires_at timestamptz NOT NULL
    )
  `);
}
