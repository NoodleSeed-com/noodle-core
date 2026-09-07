import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { InMemoryKnowledgeRevisionStore } from '@noodle-borg/knowledge';
import { describe, expect, it } from 'vitest';
import { createKnowledgeDeployHooks, withKnowledgePublication } from '../src/publication.js';
import { InMemoryKnowledgeStagingStore } from '../src/staging-store.js';
import {
  handleKnowledgeList,
  handleKnowledgeRefresh,
  handleKnowledgeStatus,
  type KnowledgeStatusDeps,
} from '../src/status-routes.js';

const tenant = { org: 'acme', app: 'site', env: 'prod' } as const;
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

function fakeReq(): import('node:http').IncomingMessage {
  return Object.assign(Readable.from([]), { headers: {} }) as never;
}

interface Captured {
  status?: number;
  body?: unknown;
}

function fakeRes(captured: Captured): import('node:http').ServerResponse {
  return {
    headersSent: false,
    writeHead(status: number) {
      captured.status = status;
      return this;
    },
    end(payload?: string) {
      captured.body = payload === undefined ? undefined : JSON.parse(payload);
    },
  } as never;
}

async function publishedDeps(): Promise<KnowledgeStatusDeps> {
  const staging = new InMemoryKnowledgeStagingStore();
  const revisionStore = new InMemoryKnowledgeRevisionStore();
  const hooks = createKnowledgeDeployHooks(
    { staging, revisionStore },
    { knowledgeEnabled: async () => true },
  );
  const text = 'published product text';
  const components = [
    {
      name: 'product',
      title: 'Product knowledge',
      description: 'Docs.',
      documents: [{ path: 'a.md', title: 'A', sha256: sha(text), bytes: Buffer.byteLength(text) }],
      sites: [{ origin: 'https://www.acme.test', include: ['/docs/**'] }],
      generatedTool: {
        name: 'search_product',
        description: 'generated',
        inputSchema: {},
        outputSchema: {},
      },
    },
    {
      name: 'faq',
      title: 'FAQ',
      description: 'Live site only.',
      documents: [],
      sites: [{ origin: 'https://www.acme.test', include: ['/faq/**'] }],
      generatedTool: {
        name: 'search_faq',
        description: 'generated',
        inputSchema: {},
        outputSchema: {},
      },
    },
  ];
  await staging.put('acme/site/prod', sha(text), Buffer.from(text), text.length);
  await withKnowledgePublication(hooks, tenant, 'deploy-1', components, async () => 'ok');
  return {
    revisionStore,
    knowledgeEnabled: async () => true,
    activeKnowledge: async () => ({ components, deploymentId: 'deploy-1' }),
  };
}

describe('knowledge list route', () => {
  it('reports lifecycle truth per component: versioned documents vs live site', async () => {
    const deps = await publishedDeps();
    const captured: Captured = {};
    await handleKnowledgeList(fakeReq(), fakeRes(captured), tenant, deps);
    expect(captured.status).toBe(200);
    const body = captured.body as {
      ok: true;
      scope: unknown;
      components: { name: string; sources: unknown; state: string; activeRevisionId?: string }[];
    };
    expect(body.scope).toEqual(tenant);
    expect(body.components).toHaveLength(2);
    const product = body.components.find((component) => component.name === 'product');
    expect(product?.sources).toEqual({ documents: 1, sites: 1 });
    expect(product?.state).toBe('active');
    expect(product?.activeRevisionId).toContain('bm25-rev');
    const faq = body.components.find((component) => component.name === 'faq');
    expect(faq?.sources).toEqual({ documents: 0, sites: 1 });
    expect(faq?.state).toBe('active');
    expect(faq?.activeRevisionId).toBeUndefined();
  });

  it('returns an empty component list when nothing is deployed', async () => {
    const deps = await publishedDeps();
    const captured: Captured = {};
    await handleKnowledgeList(fakeReq(), fakeRes(captured), tenant, {
      ...deps,
      activeKnowledge: async () => undefined,
    });
    expect(captured.status).toBe(200);
    expect((captured.body as { components: unknown[] }).components).toEqual([]);
  });

  it('fails closed when the gate is off', async () => {
    const deps = await publishedDeps();
    const captured: Captured = {};
    await handleKnowledgeList(fakeReq(), fakeRes(captured), tenant, {
      ...deps,
      knowledgeEnabled: async () => false,
    });
    expect(captured.status).toBe(403);
    expect((captured.body as { code: string }).code).toBe('knowledge_not_enabled');
  });
});

describe('knowledge status route', () => {
  it('reports the component with provisioning state and no contents or credentials', async () => {
    const deps = await publishedDeps();
    const captured: Captured = {};
    await handleKnowledgeStatus(fakeReq(), fakeRes(captured), tenant, 'product', deps);
    expect(captured.status).toBe(200);
    const body = captured.body as {
      ok: true;
      component: { name: string; state: string };
      siteProvisioning: string;
      errors: unknown[];
    };
    expect(body.component.name).toBe('product');
    expect(body.component.state).toBe('active');
    // The managed site adapter is not bound yet; the state is honest, not hidden.
    expect(body.siteProvisioning).toBe('missing');
    expect(JSON.stringify(body)).not.toContain('published product text');
  });

  it('marks document-free components as not requiring provisioning when sites are absent', async () => {
    const deps = await publishedDeps();
    const captured: Captured = {};
    const docOnly = {
      ...deps,
      activeKnowledge: async () => ({
        components: [
          {
            name: 'product',
            title: 'P',
            description: 'D.',
            documents: [],
            sites: [],
            generatedTool: {
              name: 'search_product',
              description: 'g',
              inputSchema: {},
              outputSchema: {},
            },
          },
        ],
        deploymentId: 'deploy-1',
      }),
    };
    await handleKnowledgeStatus(fakeReq(), fakeRes(captured), tenant, 'product', docOnly);
    expect((captured.body as { siteProvisioning: string }).siteProvisioning).toBe('not-required');
  });

  it('404s an unknown component', async () => {
    const deps = await publishedDeps();
    const captured: Captured = {};
    await handleKnowledgeStatus(fakeReq(), fakeRes(captured), tenant, 'missing', deps);
    expect(captured.status).toBe(404);
  });

  it('renders the crawl state for a site-bearing component when bound', async () => {
    const deps = await publishedDeps();
    const captured: Captured = {};
    await handleKnowledgeStatus(fakeReq(), fakeRes(captured), tenant, 'product', {
      ...deps,
      crawlState: async () => ({ status: 'completed', lastCompletedAt: 1, pagesIndexed: 3 }),
    });
    expect(captured.status).toBe(200);
    expect((captured.body as { crawl?: { status: string } }).crawl?.status).toBe('completed');
  });
});

describe('knowledge refresh route', () => {
  it('runs the on-demand crawl and returns its resulting state', async () => {
    const deps = await publishedDeps();
    const captured: Captured = {};
    const refreshed: string[] = [];
    await handleKnowledgeRefresh(fakeReq(), fakeRes(captured), tenant, 'product', {
      ...deps,
      refresh: async (_tenant, component) => {
        refreshed.push(component.name);
        return { status: 'completed', lastCompletedAt: 2, pagesIndexed: 7 };
      },
    });
    expect(captured.status).toBe(200);
    expect(refreshed).toEqual(['product']);
    const body = captured.body as { ok: boolean; crawl: { status: string; pagesIndexed: number } };
    expect(body.ok).toBe(true);
    expect(body.crawl).toEqual({ status: 'completed', lastCompletedAt: 2, pagesIndexed: 7 });
  });

  it('reports a failed crawl as data, not an HTTP error', async () => {
    const deps = await publishedDeps();
    const captured: Captured = {};
    await handleKnowledgeRefresh(fakeReq(), fakeRes(captured), tenant, 'product', {
      ...deps,
      refresh: async () => ({
        status: 'failed',
        lastError: 'crawl page budget exhausted for this month',
        pagesIndexed: 0,
      }),
    });
    expect(captured.status).toBe(200);
    expect((captured.body as { crawl: { status: string } }).crawl.status).toBe('failed');
  });

  it('404s an unknown component and 400s a component without sites', async () => {
    const deps = await publishedDeps();
    const refresh: NonNullable<KnowledgeStatusDeps['refresh']> = async () => ({
      status: 'completed',
      pagesIndexed: 0,
    });
    const missing: Captured = {};
    await handleKnowledgeRefresh(fakeReq(), fakeRes(missing), tenant, 'missing', {
      ...deps,
      refresh,
    });
    expect(missing.status).toBe(404);
    const noSites: Captured = {};
    const docOnly = {
      ...deps,
      refresh,
      activeKnowledge: async () => ({
        components: [
          {
            name: 'product',
            title: 'P',
            description: 'D.',
            documents: [],
            sites: [],
            generatedTool: {
              name: 'search_product',
              description: 'g',
              inputSchema: {},
              outputSchema: {},
            },
          },
        ],
        deploymentId: 'deploy-1',
      }),
    };
    await handleKnowledgeRefresh(fakeReq(), fakeRes(noSites), tenant, 'product', docOnly);
    expect(noSites.status).toBe(400);
    expect((noSites.body as { code: string }).code).toBe('knowledge_no_sites');
  });

  it('fails closed when the gate is off', async () => {
    const deps = await publishedDeps();
    const captured: Captured = {};
    await handleKnowledgeRefresh(fakeReq(), fakeRes(captured), tenant, 'product', {
      ...deps,
      knowledgeEnabled: async () => false,
      refresh: async () => ({ status: 'completed', pagesIndexed: 0 }),
    });
    expect(captured.status).toBe(403);
  });
});
