/** Durable crawl-state parity implementation (`knowledge_site_crawls`). */
import type { Pool } from 'pg';
import type { CrawlStateStore, CrawlStatus, SiteCrawlState } from './crawl-lifecycle.js';
import type { KnowledgeTenantRef } from './routes.js';

export class PostgresCrawlStateStore implements CrawlStateStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async ensureSchema(): Promise<void> {
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS knowledge_site_crawls (
        org TEXT NOT NULL,
        app TEXT NOT NULL,
        env TEXT NOT NULL,
        component TEXT NOT NULL,
        status TEXT NOT NULL,
        last_completed_at BIGINT,
        last_error TEXT,
        pages_indexed INTEGER NOT NULL DEFAULT 0,
        next_refresh_at BIGINT,
        PRIMARY KEY (org, app, env, component)
      )
    `);
  }

  async get(
    tenant: KnowledgeTenantRef,
    componentName: string,
  ): Promise<SiteCrawlState | undefined> {
    const result = await this.#pool.query<{
      status: string;
      last_completed_at: string | null;
      last_error: string | null;
      pages_indexed: number;
      next_refresh_at: string | null;
    }>(
      `SELECT status, last_completed_at, last_error, pages_indexed, next_refresh_at
       FROM knowledge_site_crawls WHERE org = $1 AND app = $2 AND env = $3 AND component = $4`,
      [tenant.org, tenant.app, tenant.env, componentName],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      status: row.status as CrawlStatus,
      pagesIndexed: row.pages_indexed,
      ...(row.last_completed_at === null ? {} : { lastCompletedAt: Number(row.last_completed_at) }),
      ...(row.last_error === null ? {} : { lastError: row.last_error }),
      ...(row.next_refresh_at === null ? {} : { nextRefreshAt: Number(row.next_refresh_at) }),
    };
  }

  async put(
    tenant: KnowledgeTenantRef,
    componentName: string,
    state: SiteCrawlState,
  ): Promise<void> {
    await this.#pool.query(
      `INSERT INTO knowledge_site_crawls
         (org, app, env, component, status, last_completed_at, last_error, pages_indexed, next_refresh_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (org, app, env, component) DO UPDATE SET
         status = EXCLUDED.status,
         last_completed_at = EXCLUDED.last_completed_at,
         last_error = EXCLUDED.last_error,
         pages_indexed = EXCLUDED.pages_indexed,
         next_refresh_at = EXCLUDED.next_refresh_at`,
      [
        tenant.org,
        tenant.app,
        tenant.env,
        componentName,
        state.status,
        state.lastCompletedAt ?? null,
        state.lastError ?? null,
        state.pagesIndexed,
        state.nextRefreshAt ?? null,
      ],
    );
  }
}
