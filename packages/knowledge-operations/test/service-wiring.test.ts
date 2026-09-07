import { createHash } from 'node:crypto';
import {
  AlgoliaKnowledgeIndex,
  Bm25KnowledgeIndex,
  MeilisearchKnowledgeIndex,
} from '@noodle-borg/knowledge';
import type { SiteCrawlRequest } from '@noodle-borg/knowledge-crawl';
import { describe, expect, it, vi } from 'vitest';
import { withKnowledgePublication } from '../src/publication.js';
import {
  defaultKnowledgeStores,
  knowledgeIndexFromDeclaration,
  wireKnowledge,
} from '../src/service-wiring.js';

const tenant = { org: 'acme', app: 'site', env: 'prod' } as const;
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

function component(sites: { origin: string; include: string[] }[], text: string) {
  return {
    name: 'product',
    title: 'Product',
    description: 'Product knowledge.',
    documents: [{ path: 'a.md', title: 'A', sha256: sha(text), bytes: Buffer.byteLength(text) }],
    sites,
    generatedTool: { name: 'search_product', description: 'g', inputSchema: {}, outputSchema: {} },
  };
}

function wiredHarness() {
  const fetchSite = vi.fn(async (_request: SiteCrawlRequest) => [
    { url: 'https://www.acme.test/docs/live', title: 'Live', text: 'live pricing content' },
  ]);
  const stores = { ...defaultKnowledgeStores(), fetcherFor: () => ({ fetchSite }) };
  let captured: Parameters<typeof withKnowledgePublication>[0] | undefined;
  const registry = {
    setKnowledgeDeployHooks(hooks: Parameters<typeof withKnowledgePublication>[0]) {
      captured = hooks;
    },
    getActiveByTenant: async () => undefined,
  };
  const wired = wireKnowledge(
    registry,
    stores,
    async () => ({ NOODLE_KNOWLEDGE_ENABLED: 'true' }),
    1024,
  );
  if (captured === undefined) throw new Error('wireKnowledge registered no hooks');
  return { stores, hooks: captured, wired, fetchSite };
}

/**
 * The managed first-party crawler needs no provisioning (ADR 0202 amendment 2026-08-18): a
 * site() deploy succeeds out of the box, and activation kicks the first crawl so freshness
 * never waits on traffic.
 */
describe('wireKnowledge with the managed crawler default', () => {
  it('deploys a site() component and kicks the first crawl on activation', async () => {
    const { stores, hooks, wired, fetchSite } = wiredHarness();
    const text = 'doc text about pricing';
    await stores.staging.put('acme/site/prod', sha(text), Buffer.from(text), text.length);
    await expect(
      withKnowledgePublication(
        hooks,
        tenant,
        'deploy-1',
        [component([{ origin: 'https://www.acme.test', include: ['/docs/**'] }], text)],
        async () => 'ok',
      ),
    ).resolves.toBe('ok');
    // The crawl is fire-and-forget off activation; wait for it to land in the crawl state.
    await vi.waitFor(async () => {
      const state = await wired.crawlState.get(tenant, 'product');
      expect(state?.status).toBe('completed');
    });
    expect(fetchSite).toHaveBeenCalledOnce();
    const state = await wired.crawlState.get(tenant, 'product');
    expect(state?.pagesIndexed).toBe(1);
  });

  it('still deploys a documents-only component without touching the crawler', async () => {
    const { stores, hooks, fetchSite } = wiredHarness();
    const text = 'doc text about pricing';
    await stores.staging.put('acme/site/prod', sha(text), Buffer.from(text), text.length);
    await expect(
      withKnowledgePublication(hooks, tenant, 'deploy-1', [component([], text)], async () => 'ok'),
    ).resolves.toBe('ok');
    expect(fetchSite).not.toHaveBeenCalled();
  });
});

describe('wireKnowledge with a BYO crawler declaration', () => {
  it('fails the crawl closed with the exact secrets fix command when the key is unset', async () => {
    const registry = {
      setKnowledgeDeployHooks() {},
      getActiveByTenant: async () => undefined,
    };
    const wired = wireKnowledge(
      registry,
      defaultKnowledgeStores(),
      async () => ({ NOODLE_KNOWLEDGE_ENABLED: 'true' }),
      1024,
      async () => ({}),
    );
    const state = await wired.refreshComponent(tenant, {
      ...component([{ origin: 'https://www.acme.test', include: ['/docs/**'] }], 'text'),
      crawler: {
        provider: 'firecrawl',
        config: { apiKey: { kind: 'secret', name: 'FIRECRAWL_API_KEY' } },
      },
    });
    expect(state.status).toBe('failed');
    expect(state.lastError).toContain(
      'noodle secrets set FIRECRAWL_API_KEY --runtime cloud --scope env --org acme --app site --env prod',
    );
  });
});

describe('wireKnowledge with a BYO index declaration', () => {
  const INDEX_DECLARATION = {
    provider: 'meilisearch',
    config: {
      host: { kind: 'variable', name: 'MEILI_HOST' },
      apiKey: { kind: 'secret', name: 'MEILI_API_KEY' },
    },
  } as const;

  it('fails the deploy closed naming the unset reference before anything stages remotely', async () => {
    const registry = {
      setKnowledgeDeployHooks(hooks: Parameters<typeof withKnowledgePublication>[0]) {
        captured = hooks;
      },
      getActiveByTenant: async () => undefined,
    };
    let captured: Parameters<typeof withKnowledgePublication>[0] | undefined;
    const stores = defaultKnowledgeStores();
    wireKnowledge(
      registry,
      stores,
      async () => ({ NOODLE_KNOWLEDGE_ENABLED: 'true' }),
      1024,
      async () => ({}),
    );
    if (captured === undefined) throw new Error('wireKnowledge registered no hooks');
    const text = 'doc text about pricing';
    await stores.staging.put('acme/site/prod', sha(text), Buffer.from(text), text.length);
    await expect(
      withKnowledgePublication(
        captured,
        tenant,
        'deploy-1',
        [{ ...component([], text), index: INDEX_DECLARATION }],
        async () => 'ok',
      ),
    ).rejects.toMatchObject({
      errors: [{ code: 'knowledge_index_config_missing' }],
    });
    await expect(
      withKnowledgePublication(
        captured,
        tenant,
        'deploy-1',
        [{ ...component([], text), index: INDEX_DECLARATION }],
        async () => 'ok',
      ),
    ).rejects.toThrow(/noodle variables set MEILI_HOST/);
  });

  it('maps declarations onto the provider adapters with resolved config', () => {
    const scope = tenant;
    expect(
      knowledgeIndexFromDeclaration(
        { provider: 'algolia', config: {} },
        { appId: 'APP1', apiKey: 'ak-1' },
        scope,
      ),
    ).toBeInstanceOf(AlgoliaKnowledgeIndex);
    expect(
      knowledgeIndexFromDeclaration(
        INDEX_DECLARATION,
        { host: 'https://meili.acme.example', apiKey: 'mk-1' },
        scope,
      ),
    ).toBeInstanceOf(MeilisearchKnowledgeIndex);
  });

  it('honors a stores-level indexFor override for both documents and the site corpus', async () => {
    const selected = new Bm25KnowledgeIndex();
    const calls: string[] = [];
    const overridden = {
      ...defaultKnowledgeStores(),
      indexFor: async (_scope: typeof tenant, componentName: string) => {
        calls.push(componentName);
        return selected;
      },
    };
    let captured: Parameters<typeof withKnowledgePublication>[0] | undefined;
    wireKnowledge(
      {
        setKnowledgeDeployHooks(nextHooks: Parameters<typeof withKnowledgePublication>[0]) {
          captured = nextHooks;
        },
        getActiveByTenant: async () => undefined,
      },
      overridden,
      async () => ({ NOODLE_KNOWLEDGE_ENABLED: 'true' }),
      1024,
    );
    if (captured === undefined) throw new Error('wireKnowledge registered no hooks');
    const text = 'doc text about pricing';
    await overridden.staging.put('acme/site/prod', sha(text), Buffer.from(text), text.length);
    await withKnowledgePublication(
      captured,
      tenant,
      'deploy-1',
      [component([], text)],
      async () => 'ok',
    );
    expect(calls).toContain('product');
  });
});
