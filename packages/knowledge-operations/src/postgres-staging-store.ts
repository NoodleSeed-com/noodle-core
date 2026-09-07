import type { Pool } from 'pg';
import { type KnowledgeStagingStore, STAGING_TTL_MS } from './staging-store.js';

export class PostgresKnowledgeStagingStore implements KnowledgeStagingStore {
  readonly #pool: Pool;
  readonly #now: () => Date;

  constructor(pool: Pool, now: () => Date = () => new Date()) {
    this.#pool = pool;
    this.#now = now;
  }

  async ensureSchema(): Promise<void> {
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS knowledge_staging_documents (
        tenant_key text NOT NULL,
        sha256 text NOT NULL,
        ciphertext bytea NOT NULL,
        bytes integer NOT NULL,
        staged_at timestamptz NOT NULL,
        PRIMARY KEY (tenant_key, sha256)
      )
    `);
  }

  async put(tenantKey: string, sha256: string, sealed: Buffer, bytes: number): Promise<void> {
    await this.#pool.query(
      `INSERT INTO knowledge_staging_documents (tenant_key, sha256, ciphertext, bytes, staged_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_key, sha256) DO UPDATE SET staged_at = $5`,
      [tenantKey, sha256, sealed, bytes, this.#now()],
    );
  }

  async has(tenantKey: string, sha256: string): Promise<boolean> {
    return (await this.get(tenantKey, sha256)) !== undefined;
  }

  async get(tenantKey: string, sha256: string): Promise<Buffer | undefined> {
    const cutoff = new Date(this.#now().getTime() - STAGING_TTL_MS);
    const result = await this.#pool.query<{ ciphertext: Buffer }>(
      `SELECT ciphertext FROM knowledge_staging_documents
       WHERE tenant_key = $1 AND sha256 = $2 AND staged_at >= $3`,
      [tenantKey, sha256, cutoff],
    );
    return result.rows[0]?.ciphertext;
  }

  async sweepExpired(): Promise<number> {
    const cutoff = new Date(this.#now().getTime() - STAGING_TTL_MS);
    const result = await this.#pool.query(
      'DELETE FROM knowledge_staging_documents WHERE staged_at < $1',
      [cutoff],
    );
    return result.rowCount ?? 0;
  }
}
