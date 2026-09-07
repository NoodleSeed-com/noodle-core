import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryDailyCounterStore } from '../src/in-memory-counter-store.js';
import { PostgresDailyCounterStore } from '../src/postgres-counter-store.js';
import { describeAtomicCounterStore, describeCounterStore } from './counter-parity.js';

describe('in-memory daily counter store', () => {
  describeCounterStore(async () => new InMemoryDailyCounterStore());
  describeAtomicCounterStore(async () => new InMemoryDailyCounterStore());

  it('declares itself non-durable so the public mint route can refuse it', () => {
    expect(new InMemoryDailyCounterStore().durable).toBe(false);
  });
});

const databaseUrl = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
const describePostgres = describe.skipIf(databaseUrl === undefined);

describePostgres('Postgres daily counter store', () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const store = new PostgresDailyCounterStore(pool);

  beforeAll(async () => {
    await store.ensureSchema();
    // Idempotent by contract: every service instance runs it on boot.
    await store.ensureSchema();
  });
  afterAll(async () => pool.end());

  describeCounterStore(async () => store);
  describeAtomicCounterStore(async () => store);

  it('declares itself durable', () => {
    expect(store.durable).toBe(true);
  });

  /**
   * The property the whole tier exists for: a ceiling that only holds inside one process is not a
   * ceiling. Two independent store objects stand in for two service instances sharing one database.
   */
  it('shares a budget across service instances', async () => {
    const other = new PostgresDailyCounterStore(pool);
    const key = `cross-${randomUUID()}`;
    const now = new Date('2030-05-06T12:00:00Z');

    expect(await store.consume({ key, limit: 2 }, now)).toMatchObject({ allowed: true, used: 1 });
    expect(await other.consume({ key, limit: 2 }, now)).toMatchObject({ allowed: true, used: 2 });
    expect(await other.consume({ key, limit: 2 }, now)).toMatchObject({ allowed: false });
  });
});
