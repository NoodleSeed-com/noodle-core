/**
 * Site crawl lifecycle (ADR 0202 amendment 2026-08-18): a crawl fetches the component's declared
 * sites through the selected `SiteFetcher`, meters the page count against the org/app crawl
 * budget, and publishes the pages as a **site revision** — the reserved `<name>#site` component
 * namespace in the same revision store and bundled index that serve documents. Site revisions
 * refresh latest-wins and are never deployment-pinned ("live site never rolls back" survives as
 * "rollback keeps serving the latest crawl"); a failed crawl — including one that discovers no
 * pages — keeps the last good corpus serving and records an attributable, content-free failure
 * in the crawl state.
 */
import { createHash } from 'node:crypto';
import {
  DEFAULT_SITE_REFRESH_MINUTES,
  MAX_CRAWL_PAGE_BYTES,
  MAX_CRAWL_PAGES_PER_SITE,
} from '@noodle-borg/knowledge/limits';
import {
  KnowledgeError,
  type SearchBudgetCeilings,
  type SearchBudgetStore,
  type SearchHit,
  type SearchRequest,
  type StagedDocument,
} from '@noodle-borg/knowledge/portable';
import type { SiteFetcher } from '@noodle-borg/knowledge-crawl';
import type { KnowledgeDeployHooks } from './publication.js';
import type { KnowledgeTenantRef } from './routes.js';

/** The reserved revision namespace for a component's crawled site corpus. */
export function siteCorpusName(componentName: string): string {
  return `${componentName}#site`;
}

export type CrawlStatus = 'not_started' | 'in_progress' | 'completed' | 'failed';

export interface SiteCrawlState {
  readonly status: CrawlStatus;
  readonly lastCompletedAt?: number;
  readonly lastError?: string;
  readonly pagesIndexed: number;
  readonly nextRefreshAt?: number;
}

export interface CrawlStateStore {
  get(tenant: KnowledgeTenantRef, componentName: string): Promise<SiteCrawlState | undefined>;
  put(tenant: KnowledgeTenantRef, componentName: string, state: SiteCrawlState): Promise<void>;
}

export class InMemoryCrawlStateStore implements CrawlStateStore {
  private readonly states = new Map<string, SiteCrawlState>();

  async get(
    tenant: KnowledgeTenantRef,
    componentName: string,
  ): Promise<SiteCrawlState | undefined> {
    return this.states.get(stateKey(tenant, componentName));
  }

  async put(
    tenant: KnowledgeTenantRef,
    componentName: string,
    state: SiteCrawlState,
  ): Promise<void> {
    this.states.set(stateKey(tenant, componentName), state);
  }
}

function stateKey(tenant: KnowledgeTenantRef, componentName: string): string {
  return `${tenant.org}/${tenant.app}/${tenant.env}#${componentName}`;
}

/** A provider config reference by name (variable()/secret() doctrine) — never a value. */
interface ProviderConfigRef {
  readonly kind: 'variable' | 'secret';
  readonly name: string;
}

/** The component facts a crawl needs; a structural subset of the compiled component. */
export interface CrawlableComponent {
  readonly name: string;
  readonly sites: readonly {
    readonly origin: string;
    readonly include: readonly string[];
    readonly refreshMinutes?: number | undefined;
  }[];
  readonly crawler?:
    | {
        readonly provider: 'firecrawl' | 'tavily';
        readonly config: { readonly apiKey: ProviderConfigRef };
      }
    | undefined;
  readonly index?:
    | {
        readonly provider: 'algolia' | 'meilisearch';
        readonly config: Readonly<Record<string, ProviderConfigRef>>;
      }
    | undefined;
}

export interface CrawlDeps {
  readonly hooks: KnowledgeDeployHooks;
  readonly crawlState: CrawlStateStore;
  readonly fetcherFor: (tenant: KnowledgeTenantRef, component: CrawlableComponent) => SiteFetcher;
  readonly budget?: {
    readonly store: SearchBudgetStore;
    readonly ceilings: (tenant: KnowledgeTenantRef) => Promise<SearchBudgetCeilings>;
  };
  readonly now?: () => number;
}

/**
 * Crawl one component's sites and publish the site revision. Never throws: the outcome —
 * including budget refusal and provider failure — lands in the crawl state, and the previous
 * corpus keeps serving on any failure.
 */
export async function runComponentCrawl(
  deps: CrawlDeps,
  tenant: KnowledgeTenantRef,
  component: CrawlableComponent,
): Promise<SiteCrawlState> {
  const now = deps.now ?? Date.now;
  if (component.sites.length === 0) {
    const state: SiteCrawlState = { status: 'not_started', pagesIndexed: 0 };
    await deps.crawlState.put(tenant, component.name, state);
    return state;
  }
  const previous = await deps.crawlState.get(tenant, component.name);
  const refreshMinutes = Math.min(
    ...component.sites.map((site) => site.refreshMinutes ?? DEFAULT_SITE_REFRESH_MINUTES),
  );
  await deps.crawlState.put(tenant, component.name, {
    status: 'in_progress',
    pagesIndexed: previous?.pagesIndexed ?? 0,
    ...(previous?.lastCompletedAt === undefined
      ? {}
      : { lastCompletedAt: previous.lastCompletedAt }),
  });
  const fail = async (lastError: string): Promise<SiteCrawlState> => {
    const state: SiteCrawlState = {
      status: 'failed',
      lastError,
      pagesIndexed: previous?.pagesIndexed ?? 0,
      ...(previous?.lastCompletedAt === undefined
        ? {}
        : { lastCompletedAt: previous.lastCompletedAt }),
      nextRefreshAt: now() + refreshMinutes * 60 * 1000,
    };
    await deps.crawlState.put(tenant, component.name, state);
    return state;
  };

  const documents: StagedDocument[] = [];
  try {
    const fetcher = deps.fetcherFor(tenant, component);
    for (const site of component.sites) {
      const pages = await fetcher.fetchSite({
        origin: site.origin,
        include: site.include,
        maxPages: MAX_CRAWL_PAGES_PER_SITE,
        maxPageBytes: MAX_CRAWL_PAGE_BYTES,
      });
      for (const page of pages) {
        documents.push({
          descriptor: {
            path: page.url,
            title: page.title,
            sha256: createHash('sha256').update(page.text).digest('hex'),
            bytes: Buffer.byteLength(page.text, 'utf8'),
            sourceUrl: page.url,
          },
          text: page.text,
        });
      }
    }
  } catch (error) {
    // Request-layer messages are our own (content-free by construction — e.g. the exact
    // `noodle secrets set` fix for an unset BYO key) and stay visible; provider messages may
    // carry URLs, bodies, or credentials and reduce to the attributable layer alone.
    if (error instanceof KnowledgeError && error.layer === 'request') {
      return fail(error.message);
    }
    const layer = error instanceof KnowledgeError ? error.layer : 'provider';
    return fail(`crawl failed at the ${layer} layer`);
  }

  // The runbook's documented outcome: an empty discovery is a failed crawl, never an empty
  // publication — publishing zero pages would retire the previous good corpus.
  if (documents.length === 0) return fail('crawl discovered no pages');

  if (deps.budget !== undefined && documents.length > 0) {
    const ceilings = await deps.budget.ceilings(tenant);
    const decision = await deps.budget.store.consume(
      { org: tenant.org, app: tenant.app },
      documents.length,
      ceilings,
    );
    if (!decision.granted) return fail('crawl page budget exhausted for this month');
  }

  try {
    await deps.hooks.publishSiteCorpus(
      { org: tenant.org, app: tenant.app, env: tenant.env },
      siteCorpusName(component.name),
      documents,
    );
  } catch {
    return fail('site corpus publication failed at the store layer');
  }
  const state: SiteCrawlState = {
    status: 'completed',
    lastCompletedAt: now(),
    pagesIndexed: documents.length,
    nextRefreshAt: now() + refreshMinutes * 60 * 1000,
  };
  await deps.crawlState.put(tenant, component.name, state);
  return state;
}

/** Crawl every served component whose refresh is due (or that has never crawled). */
export async function runDueCrawls(
  deps: CrawlDeps,
  servedComponents: () => Promise<
    readonly { tenant: KnowledgeTenantRef; component: CrawlableComponent }[]
  >,
  at: number,
): Promise<void> {
  for (const { tenant, component } of await servedComponents()) {
    if (component.sites.length === 0) continue;
    const state = await deps.crawlState.get(tenant, component.name);
    if (state?.status === 'in_progress') continue;
    if (state?.nextRefreshAt !== undefined && state.nextRefreshAt > at) continue;
    if (state?.status === 'completed' && state.nextRefreshAt === undefined) continue;
    await runComponentCrawl({ ...deps, now: () => at }, tenant, component);
  }
}

/** Serve the crawled corpus: the bundled index over the site revision, hits remapped to `site`. */
export async function searchSiteCorpus(
  hooks: KnowledgeDeployHooks,
  tenant: KnowledgeTenantRef,
  componentName: string,
  request: SearchRequest,
): Promise<readonly SearchHit[]> {
  const hits = await hooks.searchDocuments(
    { org: tenant.org, app: tenant.app, env: tenant.env },
    siteCorpusName(componentName),
    request,
  );
  return hits.map((hit) => ({ ...hit, sourceKind: 'site' as const }));
}
