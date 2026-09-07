import type { TokenExchangeJtiStore } from '@noodle-borg/auth';
import type { Pool } from 'pg';

export { InMemoryTokenExchangeJtiStore } from '@noodle-borg/auth';

/**
 * Durable single-use claims for inbound token-exchange assertion `jti`s. Its own tiny store rather
 * than a method on the wide OAuth store: assertions live 120 seconds, the table self-prunes on
 * insert, and both implementations run the same behavioural suite so the durable path cannot
 * quietly diverge from the in-memory one.
 */
export class PostgresTokenExchangeJtiStore implements TokenExchangeJtiStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async ensureSchema(): Promise<void> {
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS oauth_token_exchange_jti (
        jti text PRIMARY KEY,
        expires_at timestamptz NOT NULL
      )
    `);
  }

  async consume(jti: string, expiresAtMs: number, nowMs: number): Promise<boolean> {
    await this.#pool.query('DELETE FROM oauth_token_exchange_jti WHERE expires_at <= $1', [
      new Date(nowMs).toISOString(),
    ]);
    const inserted = await this.#pool.query(
      `INSERT INTO oauth_token_exchange_jti (jti, expires_at)
       VALUES ($1, $2) ON CONFLICT (jti) DO NOTHING`,
      [jti, new Date(expiresAtMs).toISOString()],
    );
    return (inserted.rowCount ?? 0) > 0;
  }
}
