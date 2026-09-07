import { createHash } from 'node:crypto';
import { InMemoryKnowledgeRevisionStore } from '@noodle-borg/knowledge';
import { describe, expect, it } from 'vitest';
import { siteCorpusName } from '../src/crawl-lifecycle.js';
import { createKnowledgeSearchExecutor } from '../src/executor.js';
import { createKnowledgeDeployHooks, withKnowledgePublication } from '../src/publication.js';
import { InMemoryKnowledgeStagingStore } from '../src/staging-store.js';

const tenant = { org: 'acme', app: 'site', env: 'prod' } as const;
const scope = { org: tenant.org, app: tenant.app, env: tenant.env };
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

async function publishedHarness(options?: {
  enabled?: boolean;
  sites?: { origin: string; include: string[] }[];
  sitePages?: [string, string, string][];
}) {
  const staging = new InMemoryKnowledgeStagingStore();
  const revisionStore = new InMemoryKnowledgeRevisionStore();
  const enabled = options?.enabled ?? true;
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
    sites: options?.sites ?? [],
    generatedTool: {
      name: 'search_product',
      description: 'generated',
      inputSchema: {},
      outputSchema: {},
    },
  };
  await staging.put('acme/site/prod', sha(text), Buffer.from(text), text.length);
  await withKnowledgePublication(hooks, tenant, 'deploy-1', [component], async () => 'ok');

  // The crawled corpus is published through the refresh lifecycle, not the deploy transaction.
  const pages = options?.sitePages ?? [];
  if (pages.length > 0) {
    await hooks.publishSiteCorpus(
      scope,
      siteCorpusName(component.name),
      pages.map(([url, title, pageText]) => ({
        descriptor: {
          path: url,
          title,
          sha256: sha(pageText),
          bytes: Buffer.byteLength(pageText),
          sourceUrl: url,
        },
        text: pageText,
      })),
    );
  }
  const executor = createKnowledgeSearchExecutor({ hooks, knowledgeEnabled: async () => enabled });
  return { executor, component };
}

describe('knowledge search executor', () => {
  it('serves document hits for a document-only component', async () => {
    const { executor, component } = await publishedHarness();
    const hits = await executor.search(tenant, component, { query: 'pricing plans' });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.sourceKind).toBe('document');
  });

  it('fuses document and crawled-site hits for a mixed component, policy-postfiltered', async () => {
    const { executor, component } = await publishedHarness({
      sites: [{ origin: 'https://www.acme.test', include: ['/docs/**'] }],
      sitePages: [
        ['https://www.acme.test/docs/pricing', 'Live pricing page', 'live pricing plans page'],
        ['https://evil.test/docs/pricing', 'Evil page', 'live pricing plans page'],
      ],
    });
    const hits = await executor.search(tenant, component, { query: 'pricing plans', limit: 10 });
    const kinds = hits.map((hit) => hit.sourceKind);
    expect(kinds).toContain('document');
    expect(kinds).toContain('site');
    // The exact-origin/path policy postfilter admits only the allowed origin, even when a
    // rogue page slipped into the corpus.
    expect(hits.some((hit) => hit.uri?.includes('evil.test'))).toBe(false);
  });

  it('serves documents with an honestly empty site corpus before the first crawl', async () => {
    const { executor, component } = await publishedHarness({
      sites: [{ origin: 'https://www.acme.test', include: ['/docs/**'] }],
    });
    const hits = await executor.search(tenant, component, { query: 'pricing plans', limit: 10 });
    expect(hits.some((hit) => hit.sourceKind === 'document')).toBe(true);
    expect(hits.some((hit) => hit.sourceKind === 'site')).toBe(false);
  });

  it('reports disabled through enabled() and refuses search when the gate is off', async () => {
    const { executor, component } = await publishedHarness({ enabled: false });
    expect(await executor.enabled(tenant)).toBe(false);
    await expect(executor.search(tenant, component, { query: 'pricing' })).rejects.toThrow(
      /not enabled/,
    );
  });

  it('bounds the requested limit and rejects an out-of-bounds query', async () => {
    const { executor, component } = await publishedHarness();
    await expect(executor.search(tenant, component, { query: 'x'.repeat(2001) })).rejects.toThrow(
      /query/,
    );
    const hits = await executor.search(tenant, component, { query: 'pricing', limit: 50 as never });
    expect(hits.length).toBeLessThanOrEqual(20);
  });
});
