import { describe, expect, it } from 'vitest';
import { createPostgresPool } from '../src/store/cloudsql-pool.js';

describe('service Postgres pool', () => {
  it('bounds native connection acquisition so abandoned waiters are removed', async () => {
    const postgres = await createPostgresPool({
      databaseUrl: 'postgres://postgres@127.0.0.1:1/noodle_test',
    });
    try {
      expect(postgres.pool.options.connectionTimeoutMillis).toBe(5_000);
    } finally {
      await postgres.close();
    }
  });
});
