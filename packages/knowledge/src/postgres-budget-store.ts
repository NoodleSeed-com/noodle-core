/**
 * Durable search-budget store: Postgres parity for the org-pooled monthly ceiling with
 * per-app sub-caps (ADR 0202 as amended). Consume is one transaction over two counter rows
 * (the app row and the org-total row `app = ''`), locked in a fixed order, so concurrent
 * requests can never over-grant and a refusal spends nothing at either granularity.
 */
import type { Pool, PoolClient } from 'pg';
import {
  budgetWindow,
  type SearchBudgetCeilings,
  type SearchBudgetDecision,
  type SearchBudgetScope,
  type SearchBudgetState,
  type SearchBudgetStore,
} from './budget.js';

/** The org-total row's app key; real app ids are never empty. */
const ORG_TOTAL_APP = '';

export class PostgresSearchBudgetStore implements SearchBudgetStore {
  readonly #pool: Pool;
  readonly #now: () => Date;

  constructor(pool: Pool, now: () => Date = () => new Date()) {
    this.#pool = pool;
    this.#now = now;
  }

  async ensureSchema(): Promise<void> {
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS knowledge_search_budgets (
        org text NOT NULL,
        app text NOT NULL,
        year integer NOT NULL,
        month integer NOT NULL,
        consumed bigint NOT NULL DEFAULT 0,
        PRIMARY KEY (org, app, year, month)
      )
    `);
  }

  async consume(
    scope: SearchBudgetScope,
    count: number,
    ceilings: SearchBudgetCeilings,
  ): Promise<SearchBudgetDecision> {
    const window = budgetWindow(this.#now);
    if (ceilings.app <= 0 || ceilings.org <= 0) {
      // Kill switch: block before touching the database.
      const state = await this.peek(scope, ceilings);
      return { granted: false, state };
    }
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const appConsumed = await this.lockCounter(client, scope.org, scope.app, window);
      const orgConsumed = await this.lockCounter(client, scope.org, ORG_TOTAL_APP, window);
      const granted = appConsumed + count <= ceilings.app && orgConsumed + count <= ceilings.org;
      if (granted) {
        await this.addToCounter(client, scope.org, scope.app, window, count);
        await this.addToCounter(client, scope.org, ORG_TOTAL_APP, window, count);
        await client.query('COMMIT');
        return {
          granted,
          state: this.state(scope, window, ceilings, orgConsumed + count, appConsumed + count),
        };
      }
      await client.query('ROLLBACK');
      return { granted, state: this.state(scope, window, ceilings, orgConsumed, appConsumed) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async peek(scope: SearchBudgetScope, ceilings: SearchBudgetCeilings): Promise<SearchBudgetState> {
    const window = budgetWindow(this.#now);
    const result = await this.#pool.query<{ app: string; consumed: string }>(
      `SELECT app, consumed FROM knowledge_search_budgets
       WHERE org = $1 AND app IN ($2, $3) AND year = $4 AND month = $5`,
      [this.orgKey(scope), this.appKey(scope), ORG_TOTAL_APP, window.year, window.month],
    );
    let orgConsumed = 0;
    let appConsumed = 0;
    for (const row of result.rows) {
      if (row.app === ORG_TOTAL_APP) orgConsumed = Number(row.consumed);
      else appConsumed = Number(row.consumed);
    }
    return this.state(scope, window, ceilings, orgConsumed, appConsumed);
  }

  /** Ensure the counter row exists, lock it, and return its consumed value. */
  private async lockCounter(
    client: PoolClient,
    org: string,
    app: string,
    window: { year: number; month: number },
  ): Promise<number> {
    await client.query(
      `INSERT INTO knowledge_search_budgets (org, app, year, month, consumed)
       VALUES ($1, $2, $3, $4, 0)
       ON CONFLICT (org, app, year, month) DO NOTHING`,
      [org.toLowerCase(), app.toLowerCase(), window.year, window.month],
    );
    const locked = await client.query<{ consumed: string }>(
      `SELECT consumed FROM knowledge_search_budgets
       WHERE org = $1 AND app = $2 AND year = $3 AND month = $4
       FOR UPDATE`,
      [org.toLowerCase(), app.toLowerCase(), window.year, window.month],
    );
    return Number(locked.rows[0]?.consumed ?? 0);
  }

  private async addToCounter(
    client: PoolClient,
    org: string,
    app: string,
    window: { year: number; month: number },
    count: number,
  ): Promise<void> {
    await client.query(
      `UPDATE knowledge_search_budgets SET consumed = consumed + $5
       WHERE org = $1 AND app = $2 AND year = $3 AND month = $4`,
      [org.toLowerCase(), app.toLowerCase(), window.year, window.month, count],
    );
  }

  private state(
    scope: SearchBudgetScope,
    window: { year: number; month: number },
    ceilings: SearchBudgetCeilings,
    orgConsumed: number,
    appConsumed: number,
  ): SearchBudgetState {
    return {
      org: scope.org,
      app: scope.app,
      ...window,
      orgConsumed,
      appConsumed,
      orgCeiling: ceilings.org,
      appCeiling: ceilings.app,
    };
  }

  private orgKey(scope: SearchBudgetScope): string {
    return scope.org.toLowerCase();
  }

  private appKey(scope: SearchBudgetScope): string {
    return scope.app.toLowerCase();
  }
}
