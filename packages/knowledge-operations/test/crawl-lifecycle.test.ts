import { createHash } from 'node:crypto';
import { InMemoryKnowledgeRevisionStore, InMemorySearchBudgetStore } from '@noodle-borg/knowledge';
import type { CrawlPage, SiteCrawlRequest } from '@noodle-borg/knowledge-crawl';
import { describe, expect, it } from 'vitest';
import {
  InMemoryCrawlStateStore,
  runComponentCrawl,
  runDueCrawls,
} from '../src/crawl-lifecycle.js';
import { createKnowledgeSearchExecutor } from '../src/executor.js';
import { createKnowledgeDeployHooks, withKnowledgePublication } from '../src/publication.js';
import { InMemoryKnowledgeStagingStore } from '../src/staging-store.js';

const tenant = { org: 'acme', app: 'site', env: 'prod' } as const;
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

class FakeFetcher {
  pages: CrawlPage[] = [];
  requests: SiteCrawlRequest[] = [];
  failWith?: Error;

  async fetchSite(request: SiteCrawlRequest): Promise<readonly CrawlPage[]> {
    this.requests.push(request);
    if (this.failWith) throw this.failWith;
    return this.pages;
  }
}

async function harness(options?: { budget?: { org: number; app: number } }) {
  const staging = new InMemoryKnowledgeStagingStore();
  const revisionStore = new InMemoryKnowledgeRevisionStore();
  const crawlState = new InMemoryCrawlStateStore();
  const budgetStore = new InMemorySearchBudgetStore();
  const hooks = createKnowledgeDeployHooks(
    { staging, revisionStore },
    { knowledgeEnabled: async () => true },
  );
  const text = 'alpha document about pricing plans';
  const component = {
    name: 'product',
    title: 'Product',
    description: 'Product knowledge.',
    documents: [
      { path: 'a.md', title: 'Pricing guide', sha256: sha(text), bytes: Buffer.byteLength(text) },
    ],
    sites: [{ origin: 'https://www.acme.test', include: ['/docs/**'], refreshMinutes: 60 }],
    generatedTool: {
      name: 'search_product',
      description: 'generated',
      inputSchema: {},
      outputSchema: {},
    },
  };
  await staging.put('acme/site/prod', sha(text), Buffer.from(text), text.length);
  await withKnowledgePublication(hooks, tenant, 'deploy-1', [component], async () => 'ok');

  const fetcher = new FakeFetcher();
  const budget = {
    store: budgetStore,
    ceilings: async () => options?.budget ?? { org: 20_000, app: 10_000 },
  };
  const deps = {
    hooks,
    crawlState,
    budget,
    fetcherFor: () => fetcher,
    knowledgeEnabled: async () => true,
  };
  const executor = createKnowledgeSearchExecutor({ hooks, knowledgeEnabled: async () => true });
  return {
    staging,
    revisionStore,
    crawlState,
    budgetStore,
    hooks,
    component,
    fetcher,
    deps,
    executor,
  };
}

describe('site crawl lifecycle', () => {
  it('publishes the crawled corpus and serves fused document + site hits', async () => {
    const { component, fetcher, deps, executor, crawlState } = await harness();
    fetcher.pages = [
      {
        url: 'https://www.acme.test/docs/live',
        title: 'Live pricing page',
        text: 'live pricing plans page',
      },
    ];
    await runComponentCrawl(deps, tenant, component);

    const state = await crawlState.get(tenant, component.name);
    expect(state?.status).toBe('completed');
    expect(state?.pagesIndexed).toBe(1);
    expect(state?.lastCompletedAt).toBeTypeOf('number');
    expect(state?.nextRefreshAt).toBeTypeOf('number');

    const hits = await executor.search(tenant, component, { query: 'pricing plans', limit: 10 });
    const kinds = hits.map((hit) => hit.sourceKind);
    expect(kinds).toContain('document');
    expect(kinds).toContain('site');
    const siteHit = hits.find((hit) => hit.sourceKind === 'site');
    expect(siteHit?.uri).toBe('https://www.acme.test/docs/live');
  });

  it('a failed crawl keeps serving the last good corpus and records the failure', async () => {
    const { component, fetcher, deps, executor, crawlState } = await harness();
    fetcher.pages = [
      { url: 'https://www.acme.test/docs/live', title: 'Live', text: 'live pricing content' },
    ];
    await runComponentCrawl(deps, tenant, component);
    fetcher.failWith = new Error('connect timeout to https://www.acme.test (key tvly-secret)');
    await runComponentCrawl(deps, tenant, component);

    const state = await crawlState.get(tenant, component.name);
    expect(state?.status).toBe('failed');
    // Attributable but content-free: no provider message, no secrets.
    expect(state?.lastError).not.toContain('tvly-secret');
    const hits = await executor.search(tenant, component, { query: 'pricing', limit: 10 });
    expect(hits.some((hit) => hit.sourceKind === 'site')).toBe(true);
  });

  it('a crawl that finds no pages fails with "no pages" and keeps the previous corpus serving', async () => {
    // The runbook has always documented this outcome ("crawl failed — no pages; previous corpus
    // is retained"); before this test an empty crawl published an EMPTY corpus over the good one
    // and reported completed with pagesIndexed 0.
    const { component, fetcher, deps, executor, crawlState, budgetStore } = await harness();
    fetcher.pages = [
      { url: 'https://www.acme.test/docs/live', title: 'Live', text: 'live pricing content' },
    ];
    await runComponentCrawl(deps, tenant, component);
    const good = await crawlState.get(tenant, component.name);

    fetcher.pages = [];
    await runComponentCrawl(deps, tenant, component);

    const state = await crawlState.get(tenant, component.name);
    expect(state?.status).toBe('failed');
    expect(state?.lastError).toContain('no pages');
    expect(state?.pagesIndexed).toBe(1);
    expect(state?.lastCompletedAt).toBe(good?.lastCompletedAt);
    expect(state?.nextRefreshAt).toBeTypeOf('number');
    const hits = await executor.search(tenant, component, { query: 'pricing', limit: 10 });
    expect(hits.some((hit) => hit.sourceKind === 'site')).toBe(true);
    const spent = await budgetStore.peek(
      { org: tenant.org, app: tenant.app },
      { org: 20_000, app: 10_000 },
    );
    expect(spent.orgConsumed).toBe(1);
  });

  it('a first crawl that finds no pages fails without publishing an empty corpus', async () => {
    const { component, fetcher, deps, executor, crawlState } = await harness();
    fetcher.pages = [];
    await runComponentCrawl(deps, tenant, component);

    const state = await crawlState.get(tenant, component.name);
    expect(state?.status).toBe('failed');
    expect(state?.lastError).toContain('no pages');
    expect(state?.pagesIndexed).toBe(0);
    const hits = await executor.search(tenant, component, { query: 'pricing', limit: 10 });
    expect(hits.some((hit) => hit.sourceKind === 'site')).toBe(false);
  });

  it('meters crawl pages against the org/app budget and blocks on exhaustion without touching the corpus', async () => {
    const { component, fetcher, deps, executor, crawlState, budgetStore } = await harness({
      budget: { org: 20_000, app: 0 },
    });
    fetcher.pages = [
      { url: 'https://www.acme.test/docs/live', title: 'Live', text: 'live pricing content' },
    ];
    await runComponentCrawl(deps, tenant, component);
    const state = await crawlState.get(tenant, component.name);
    expect(state?.status).toBe('failed');
    expect(state?.lastError).toContain('budget');
    const hits = await executor.search(tenant, component, { query: 'pricing', limit: 10 });
    expect(hits.some((hit) => hit.sourceKind === 'site')).toBe(false);
    const spent = await budgetStore.peek(
      { org: tenant.org, app: tenant.app },
      { org: 20_000, app: 0 },
    );
    expect(spent.orgConsumed).toBe(0);
  });

  it('consumes exactly the indexed page count on success', async () => {
    const { component, fetcher, deps, budgetStore } = await harness();
    fetcher.pages = [
      { url: 'https://www.acme.test/docs/a', title: 'A', text: 'alpha' },
      { url: 'https://www.acme.test/docs/b', title: 'B', text: 'beta' },
    ];
    await runComponentCrawl(deps, tenant, component);
    const spent = await budgetStore.peek(
      { org: tenant.org, app: tenant.app },
      { org: 20_000, app: 10_000 },
    );
    expect(spent.orgConsumed).toBe(2);
  });

  it('runDueCrawls crawls due components once and reschedules', async () => {
    const { component, fetcher, deps, crawlState } = await harness();
    fetcher.pages = [{ url: 'https://www.acme.test/docs/a', title: 'A', text: 'alpha' }];
    const served = async () => [{ tenant, component }];
    await runDueCrawls(deps, served, Date.now());
    expect(fetcher.requests).toHaveLength(1);
    const state = await crawlState.get(tenant, component.name);
    expect(state?.status).toBe('completed');
    // Not due again until nextRefreshAt passes.
    await runDueCrawls(deps, served, Date.now());
    expect(fetcher.requests).toHaveLength(1);
    await runDueCrawls(deps, served, Date.now() + 61 * 60 * 1000);
    expect(fetcher.requests).toHaveLength(2);
  });

  it('a mixed component before its first crawl serves documents with an honestly empty site corpus', async () => {
    const { component, executor } = await harness();
    const hits = await executor.search(tenant, component, { query: 'pricing plans', limit: 10 });
    expect(hits.some((hit) => hit.sourceKind === 'document')).toBe(true);
    expect(hits.some((hit) => hit.sourceKind === 'site')).toBe(false);
  });
});
