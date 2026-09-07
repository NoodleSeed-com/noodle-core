import { createHash } from 'node:crypto';
import type { ConfirmationNonceLedger } from '@noodle-borg/protocol';

export interface McpConfirmationNoncePool {
  query(sql: string, values?: unknown[]): Promise<{ readonly rowCount: number | null }>;
}

/** Additive schema for short-lived, single-use modern MCP confirmation approvals. */
export async function ensureMcpConfirmationNonceSchema(
  pool: McpConfirmationNoncePool,
): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mcp_confirmation_nonces (
      nonce_hash  text PRIMARY KEY,
      expires_at  timestamptz NOT NULL,
      consumed_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS mcp_confirmation_nonces_expires_at_idx
      ON mcp_confirmation_nonces (expires_at)
  `);
}

export class PostgresMcpConfirmationNonceLedger implements ConfirmationNonceLedger {
  readonly #pool: McpConfirmationNoncePool;

  constructor(pool: McpConfirmationNoncePool) {
    this.#pool = pool;
  }

  async consume(nonce: string, expiresAt: number): Promise<boolean> {
    const nonceHash = createHash('sha256').update(nonce).digest('hex');
    const result = await this.#pool.query(
      `
        WITH expired AS (
          DELETE FROM mcp_confirmation_nonces WHERE expires_at <= now()
        )
        INSERT INTO mcp_confirmation_nonces (nonce_hash, expires_at)
        SELECT $1, $2 WHERE $2 > now()
        ON CONFLICT (nonce_hash) DO NOTHING
        RETURNING nonce_hash
      `,
      [nonceHash, new Date(expiresAt)],
    );
    return result.rowCount === 1;
  }
}
