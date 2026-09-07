import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient } from 'pg';
import type { SqlClientProvider } from '../modules/context.js';

interface TransactionScope {
  readonly pool: SqlClientProvider;
  readonly client: PoolClient;
  active: boolean;
  failure?: { readonly error: unknown };
}
const transactions = new AsyncLocalStorage<TransactionScope>();

/** Join only this pool's active transaction, never a released or unrelated client. */
export function postgresQueryExecutor(pool: Pool): Pool | PoolClient {
  const scope = transactions.getStore();
  return scope?.active && scope.pool === pool ? scope.client : pool;
}

/** Nested participants share one atomic transaction; a caught failure still prevents its commit. */
export async function withPostgresTransaction<T>(
  pool: SqlClientProvider,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const existing = transactions.getStore();
  if (existing?.active && existing.pool === pool) {
    try {
      return await work(existing.client);
    } catch (error) {
      existing.failure ??= { error };
      throw error;
    }
  }
  const client = (await pool.connect()) as PoolClient;
  const scope: TransactionScope = { pool, client, active: true };
  try {
    await client.query('BEGIN');
    const result = await transactions.run(scope, () => work(client));
    scope.active = false;
    if (scope.failure) throw scope.failure.error;
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    scope.active = false;
    client.release();
  }
}
