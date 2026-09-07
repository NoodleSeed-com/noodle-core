import { createHash } from 'node:crypto';
import {
  Bm25KnowledgeIndex,
  type CompiledKnowledgeComponent,
  InMemoryKnowledgeRevisionStore,
  type KnowledgeIndex,
} from '@noodle-borg/knowledge';
import { describe, expect, it } from 'vitest';
import { createKnowledgeDeployHooks, withKnowledgePublication } from '../src/publication.js';
import { InMemoryKnowledgeStagingStore } from '../src/staging-store.js';

/**
 * BYO index publication binding (ADR 0202 amendment 2026-08-18): a component that declares
 * `index: algolia(...)`/`meilisearch(...)` publishes and serves through the selected
 * `KnowledgeIndex` for BOTH its versioned documents and its crawled `<name>#site` corpus; a
 * component without a declaration keeps the managed bundled index. The seam is
 * `options.indexFor` — publication passes the declaration when it holds the compiled component
 * and the component name alone otherwise.
 */

const tenant = { org: 'acme', app: 'site', env: 'prod' } as const;
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

const INDEX_DECLARATION: CompiledKnowledgeComponent['index'] = {
  provider: 'meilisearch',
  config: {
    host: { kind: 'variable', name: 'MEILI_HOST' },
    apiKey: { kind: 'secret', name: 'MEILI_API_KEY' },
  },
};

/** A recording KnowledgeIndex delegating to an in-memory BM25 — provider semantics, zero wire. */
function recordingIndex(): { index: KnowledgeIndex; calls: string[] } {
  const inner = new Bm25KnowledgeIndex();
  const calls: string[] = [];
  const index: KnowledgeIndex = {
    stage: (scope, componentName, documents) => {
      calls.push(`stage:${componentName}`);
      return inner.stage(scope, componentName, documents);
    },
    verify: (revisionId, predicate) => {
      calls.push('verify');
      return inner.verify(revisionId, predicate);
    },
    activate: (revisionId) => {
      calls.push('activate');
      return inner.activate(revisionId);
    },
    search: (scope, componentName, request) => {
      calls.push(`search:${componentName}`);
      return inner.search(scope, componentName, request);
    },
    delete: (revisionId) => inner.delete(revisionId),
    activeRevision: (scope, componentName) => inner.activeRevision(scope, componentName),
  };
  return { index, calls };
}

function byoComponent(text: string): CompiledKnowledgeComponent {
  return {
    name: 'product',
    title: 'Product',
    description: 'Product knowledge.',
    documents: [{ path: 'a.md', title: 'A', sha256: sha(text), bytes: Buffer.byteLength(text) }],
    sites: [{ origin: 'https://www.acme.test', include: ['/docs/**'] }],
    generatedTool: {
      name: 'search_product',
      description: 'generated',
    } as CompiledKnowledgeComponent['generatedTool'],
    index: INDEX_DECLARATION,
  };
}

function harness(selected: KnowledgeIndex) {
  const staging = new InMemoryKnowledgeStagingStore();
  const revisionStore = new InMemoryKnowledgeRevisionStore();
  const seen: {
    componentName: string;
    declaration: CompiledKnowledgeComponent['index'] | undefined;
  }[] = [];
  const hooks = createKnowledgeDeployHooks(
    { staging, revisionStore },
    {
      knowledgeEnabled: async () => true,
      indexFor: async (_scope, componentName, declaration) => {
        seen.push({ componentName, declaration });
        // The wireKnowledge implementation resolves a declaration (or looks the component up)
        // to a provider adapter; here every 'product'-owned name selects the recording index.
        return componentName.startsWith('product') ? selected : undefined;
      },
    },
  );
  return { staging, revisionStore, hooks, seen };
}

describe('BYO index publication binding', () => {
  it('publishes, verifies, activates, and searches through the selected index', async () => {
    const { index, calls } = recordingIndex();
    const { staging, hooks, seen } = harness(index);
    const text = 'alpha knowledge text';
    await staging.put('acme/site/prod', sha(text), Buffer.from(text), text.length);
    await withKnowledgePublication(
      hooks,
      tenant,
      'deploy-1',
      [byoComponent(text)],
      async () => 'ok',
    );
    expect(calls).toContain('stage:product');
    expect(calls).toContain('verify');
    expect(calls).toContain('activate');
    // The publish path hands the compiled declaration to the seam — no lookup needed there.
    expect(seen.find((entry) => entry.componentName === 'product')?.declaration).toEqual(
      INDEX_DECLARATION,
    );
    const hits = await hooks.searchDocuments(tenant, 'product', { query: 'alpha', limit: 5 });
    expect(hits[0]?.title).toBe('A');
    expect(calls).toContain('search:product');
  });

  it('routes the crawled site corpus through the owning component index', async () => {
    const { index, calls } = recordingIndex();
    const { hooks } = harness(index);
    await hooks.publishSiteCorpus(tenant, 'product#site', [
      {
        descriptor: {
          path: 'https://www.acme.test/docs/live',
          title: 'Live',
          sha256: sha('live text'),
          bytes: Buffer.byteLength('live text'),
          sourceUrl: 'https://www.acme.test/docs/live',
        },
        text: 'live text',
      },
    ]);
    expect(calls).toContain('stage:product#site');
    const hits = await hooks.searchDocuments(tenant, 'product#site', { query: 'live', limit: 5 });
    expect(hits).toHaveLength(1);
    expect(calls).toContain('search:product#site');
  });

  it('keeps the managed bundled index when the seam declines a component', async () => {
    const { index, calls } = recordingIndex();
    const { staging, hooks } = harness(index);
    const text = 'unrelated component text';
    await staging.put('acme/site/prod', sha(text), Buffer.from(text), text.length);
    const other: CompiledKnowledgeComponent = {
      ...byoComponent(text),
      name: 'faq',
      generatedTool: {
        name: 'search_faq',
        description: 'generated',
      } as CompiledKnowledgeComponent['generatedTool'],
    };
    const { index: _unused, ...rest } = other;
    await withKnowledgePublication(
      hooks,
      tenant,
      'deploy-1',
      [rest as CompiledKnowledgeComponent],
      async () => 'ok',
    );
    const hits = await hooks.searchDocuments(tenant, 'faq', { query: 'unrelated', limit: 5 });
    expect(hits).toHaveLength(1);
    expect(calls).toEqual([]);
  });
});
