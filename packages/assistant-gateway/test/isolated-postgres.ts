import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll } from 'vitest';

/** Each suite owns its DDL as well as its rows when files execute concurrently. */
export function isolatedPostgres(connectionString: string | undefined): Pool {
  const schema = `assistant_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString });
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
  });
  afterAll(async () => {
    try {
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await admin.end();
    }
  });
  return pool;
}
