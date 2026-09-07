/**
 * Runtime `search_<name>` execution (ADR 0202 amendment 2026-08-18): feature gate → bundled
 * BM25 for documents → bundled BM25 over the crawled site corpus → deterministic RRF fusion with
 * the exact origin/path policy postfilter. Every query is in-process and free; the crawl-page
 * budget is enforced at crawl time (`crawl-lifecycle.ts`), not here. Before a component's first
 * completed crawl the site corpus is honestly empty, with the crawl state as the operator
 * signal.
 */
import {
  DEFAULT_RESULT_LIMIT,
  fuseHits,
  KnowledgeError,
  MAX_QUERY_CHARS,
  MAX_RESULT_LIMIT,
  MIN_QUERY_CHARS,
  MIN_RESULT_LIMIT,
  type SearchHit,
} from '@noodle-borg/knowledge/portable';
import { searchSiteCorpus } from './crawl-lifecycle.js';
import type { KnowledgeDeployHooks } from './publication.js';
import { type KnowledgeTenantRef, knowledgeEnableCommand } from './routes.js';

/** The component facts the executor needs; a structural subset of the compiled component. */
export interface KnowledgeSearchComponent {
  readonly name: string;
  readonly sites: readonly { readonly origin: string; readonly include: readonly string[] }[];
}

export interface KnowledgeSearchRequest {
  readonly query: string;
  readonly limit?: number;
}

export interface KnowledgeSearchExecutor {
  enabled(tenant: KnowledgeTenantRef): Promise<boolean>;
  /** Throws `KnowledgeError` or `SearchBudgetExhaustedError`; never returns partial truth. */
  search(
    tenant: KnowledgeTenantRef,
    component: KnowledgeSearchComponent,
    request: KnowledgeSearchRequest,
  ): Promise<readonly SearchHit[]>;
}

export interface KnowledgeSearchExecutorDeps {
  readonly hooks: KnowledgeDeployHooks;
  readonly knowledgeEnabled: (tenant: KnowledgeTenantRef) => Promise<boolean>;
}

export function createKnowledgeSearchExecutor(
  deps: KnowledgeSearchExecutorDeps,
): KnowledgeSearchExecutor {
  return {
    enabled: (tenant) => deps.knowledgeEnabled(tenant),

    async search(tenant, component, request) {
      if (!(await deps.knowledgeEnabled(tenant))) {
        throw new KnowledgeError(
          'request',
          `knowledge is not enabled for this org/app/env; run: ${knowledgeEnableCommand(tenant)}`,
        );
      }
      if (request.query.length < MIN_QUERY_CHARS || request.query.length > MAX_QUERY_CHARS) {
        throw new KnowledgeError(
          'request',
          `query must be between ${MIN_QUERY_CHARS} and ${MAX_QUERY_CHARS} characters`,
        );
      }
      const limit = Math.min(
        MAX_RESULT_LIMIT,
        Math.max(MIN_RESULT_LIMIT, Math.floor(request.limit ?? DEFAULT_RESULT_LIMIT)),
      );
      const scope = { org: tenant.org, app: tenant.app, env: tenant.env };
      const documents = await deps.hooks.searchDocuments(scope, component.name, {
        query: request.query,
        limit,
      });

      let sites: readonly SearchHit[] = [];
      if (component.sites.length > 0) {
        // The crawled corpus serves in-process from the site revision (ADR 0202 amendment
        // 2026-08-18): no provider call, no per-query spend — crawl time owns the metering.
        // Before the first completed crawl the corpus is legitimately empty; the crawl state in
        // `knowledge status` is the honest signal, not a refusal.
        sites = await searchSiteCorpus(deps.hooks, tenant, component.name, {
          query: request.query,
          limit,
        });
      }

      return fuseHits(documents, sites, {
        limit,
        sitePolicies: component.sites.map((policy) => ({
          origin: policy.origin,
          include: [...policy.include],
        })),
      });
    },
  };
}
