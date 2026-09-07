import { Pool } from 'pg';

export interface PostgresPoolConfig {
  /** Plain Postgres connection string (local dev / non-GCP / on-prem). */
  readonly databaseUrl: string;
}

type PostgresSchemaStartupPhase = 'core' | 'modules' | 'oauth';
type PostgresSchemaStartupSerializer = <T>(
  phase: PostgresSchemaStartupPhase,
  work: () => Promise<T>,
) => Promise<T>;

/** A pool plus its teardown. Hosted adapters may attach additional connector cleanup. */
export interface PostgresPool {
  readonly pool: Pool;
  readonly serializeSchemaStartup?: PostgresSchemaStartupSerializer;
  close(): Promise<void>;
}

// Small per-instance pool shared by control-plane work plus shadow and authoritative usage admission. Ten
// Cloud Run instances therefore stay within the current 50-connection database budget; change this only
// from measured fleet and admission-latency evidence.
const POOL_MAX = 5;
const POOL_CONNECTION_TIMEOUT_MS = 5_000;

/**
 * Build a portable `pg.Pool` from a connection string. Managed-cloud connector construction belongs to
 * the private cloud composition root and is injected through {@link PostgresPool}.
 */
export async function createPostgresPool(config: PostgresPoolConfig): Promise<PostgresPool> {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: POOL_CONNECTION_TIMEOUT_MS,
    max: POOL_MAX,
  });
  return { pool, close: () => pool.end() };
}
