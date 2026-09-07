import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { PostgresSearchBudgetStore } from '../src/postgres-budget-store.js';
import { describeSearchBudgetStore } from './budget-parity.js';

const databaseUrl = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;

const conditional = describe.skipIf(databaseUrl === undefined);

const pool = databaseUrl === undefined ? undefined : new Pool({ connectionString: databaseUrl });

afterAll(async () => {
  await pool?.end();
});

async function makeStore(now?: () => Date): Promise<PostgresSearchBudgetStore> {
  if (pool === undefined) throw new Error('DATABASE_URL suite ran without a pool');
  const store = new PostgresSearchBudgetStore(pool, now);
  await store.ensureSchema();
  // Same starting universe as a fresh in-memory store, or parity compares different populations.
  await pool.query('TRUNCATE knowledge_search_budgets');
  return store;
}

conditional('postgres tenant search budget', () => {
  describeSearchBudgetStore(makeStore);

  it('never over-grants under concurrent consumption', async () => {
    const store = await makeStore();
    const scope = { org: 'acme', app: 'site' } as const;
    const ceilings = { org: 10, app: 10 } as const;
    const decisions = await Promise.all(
      Array.from({ length: 25 }, () => store.consume(scope, 1, ceilings)),
    );
    const granted = decisions.filter((decision) => decision.granted).length;
    expect(granted).toBe(10);
    const state = await store.peek(scope, ceilings);
    expect(state.appConsumed).toBe(10);
    expect(state.orgConsumed).toBe(10);
  });
});
