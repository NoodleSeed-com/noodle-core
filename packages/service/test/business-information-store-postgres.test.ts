import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresBusinessInformationStore } from '../src/business-information/postgres-store.js';
import { describeBusinessInformationStore } from './business-information-store-suite.js';
import { TestPayloadCipher } from './business-information-test-cipher.js';

const databaseUrl = process.env.DATABASE_URL_TEST;
const describePostgres = describe.skipIf(databaseUrl === undefined);

describePostgres('Postgres business information store', () => {
  const schema = `business_information_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 6,
    options: `-c search_path=${schema}`,
  });
  let now = new Date('2030-01-01T00:00:00.000Z');
  const store = new PostgresBusinessInformationStore(pool, new TestPayloadCipher(), {
    now: () => new Date(now),
  });

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await store.ensureSchema();
    await store.ensureSchema();
  });

  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  describeBusinessInformationStore(async () => {
    now = new Date('2030-01-01T00:00:00.000Z');
    return {
      store,
      advance: (milliseconds) => {
        now = new Date(now.getTime() + milliseconds);
      },
    };
  });
});

describe('Postgres payload custody', () => {
  it('fails closed without a payload cipher', () => {
    expect(() => new PostgresBusinessInformationStore({} as pg.Pool, undefined as never)).toThrow(
      /cipher/,
    );
  });
});
