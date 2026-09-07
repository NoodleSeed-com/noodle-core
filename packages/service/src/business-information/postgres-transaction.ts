import type { Pool, PoolClient } from 'pg';
import { withPostgresTransaction } from '../store/postgres-transaction.js';
import { InstallationCapacityError } from './installation-capacity.js';
import { NativeStorageLimitError } from './native-storage-budget.js';

export async function inTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  try {
    return await withPostgresTransaction(pool, operation);
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === '23514' &&
      'constraint' in error
    ) {
      if (error.constraint === 'managed_record_storage_limit') throw new NativeStorageLimitError();
      if (error.constraint === 'business_installation_capacity')
        throw new InstallationCapacityError();
    }
    throw error;
  }
}
