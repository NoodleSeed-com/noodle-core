import { createHash } from 'node:crypto';
import {
  Bm25KnowledgeIndex,
  type CompiledKnowledgeComponent,
  InMemoryKnowledgeRevisionStore,
} from '@noodle-borg/knowledge';
import { describe, expect, it } from 'vitest';
import {
  createKnowledgeDeployHooks,
  KnowledgePublicationError,
  withKnowledgePublication,
} from '../src/publication.js';
import { InMemoryKnowledgeStagingStore } from '../src/staging-store.js';

const tenant = { org: 'acme', app: 'site', env: 'prod' } as const;
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

function component(
  name: string,
  documents: Record<string, string>,
): { component: CompiledKnowledgeComponent; texts: Record<string, string> } {
  return {
    component: {
      name,
      title: `${name} title`,
      description: `${name} description`,
      documents: Object.entries(documents).map(([path, text]) => ({
        path,
        title: path,
        sha256: sha(text),
        bytes: Buffer.byteLength(text),
      })),
      sites: [],
      generatedTool: {
        name: `search_${name}`,
        description: 'generated',
      } as CompiledKnowledgeComponent['generatedTool'],
    },
    texts: documents,
  };
}

function harness(options?: { enabled?: boolean }) {
  const staging = new InMemoryKnowledgeStagingStore();
  const revisionStore = new InMemoryKnowledgeRevisionStore();
  const index = new Bm25KnowledgeIndex();
  const hooks = createKnowledgeDeployHooks(
    { staging, revisionStore },
    { knowledgeEnabled: async () => options?.enabled ?? true },
  );
  const stage = async (texts: Record<string, string>) => {
    for (const text of Object.values(texts)) {
      await staging.put('acme/site/prod', sha(text), Buffer.from(text), text.length);
    }
  };
  return { staging, revisionStore, index, hooks, stage };
}

describe('knowledge deploy publication', () => {
  it('publishes staged documents through stage → verify → activate, durably and searchably', async () => {
    const { hooks, revisionStore, stage } = harness();
    const { component: product, texts } = component('product', {
      'a.md': 'alpha knowledge text',
    });
    await stage(texts);
    const persisted = await withKnowledgePublication(
      hooks,
      tenant,
      'deploy-1',
      [product],
      async () => 'persisted',
    );
    expect(persisted).toBe('persisted');
    const active = await revisionStore.active(tenant, 'product');
    expect(active).toBeDefined();
    const documents = await revisionStore.documents(active?.revisionId ?? '');
    expect(documents[0]?.text).toBe('alpha knowledge text');
    const hits = await hooks.searchDocuments(tenant, 'product', { query: 'alpha', limit: 5 });
    expect(hits[0]?.title).toBe('a.md');
  });

  it('fails closed when the gate is off and a component is declared', async () => {
    const { hooks, stage } = harness({ enabled: false });
    const { component: product, texts } = component('product', { 'a.md': 'text' });
    await stage(texts);
    await expect(
      withKnowledgePublication(hooks, tenant, 'deploy-1', [product], async () => 'persisted'),
    ).rejects.toBeInstanceOf(KnowledgePublicationError);
    await expect(
      withKnowledgePublication(hooks, tenant, 'deploy-1', [product], async () => 'x'),
    ).rejects.toThrow(/NOODLE_KNOWLEDGE_ENABLED/);
  });

  it('is a no-op for a manifest without knowledge', async () => {
    const { hooks } = harness({ enabled: false });
    const persisted = await withKnowledgePublication(
      hooks,
      tenant,
      'deploy-1',
      undefined,
      async () => 'persisted',
    );
    expect(persisted).toBe('persisted');
  });

  it('reports missing staged bytes with an idempotent-retry error and retains nothing active', async () => {
    const { hooks, revisionStore } = harness();
    const { component: product } = component('product', { 'a.md': 'never uploaded' });
    await expect(
      withKnowledgePublication(hooks, tenant, 'deploy-1', [product], async () => 'x'),
    ).rejects.toMatchObject({
      errors: [{ code: 'knowledge_documents_missing' }],
    });
    expect(await revisionStore.active(tenant, 'product')).toBeUndefined();
  });

  it('retains the previous artifact and revision when persistence fails after activation', async () => {
    const { hooks, revisionStore, stage } = harness();
    const first = component('product', { 'a.md': 'first version text' });
    await stage(first.texts);
    await withKnowledgePublication(hooks, tenant, 'deploy-1', [first.component], async () => 'ok');
    const firstActive = await revisionStore.active(tenant, 'product');

    const second = component('product', { 'a.md': 'second version text' });
    await stage(second.texts);
    await expect(
      withKnowledgePublication(hooks, tenant, 'deploy-2', [second.component], async () => {
        throw new Error('persist blew up');
      }),
    ).rejects.toThrow('persist blew up');
    expect((await revisionStore.active(tenant, 'product'))?.revisionId).toBe(
      firstActive?.revisionId,
    );
    const hits = await hooks.searchDocuments(tenant, 'product', { query: 'first', limit: 5 });
    expect(hits).toHaveLength(1);
  });

  it('reuses the revision for unchanged content without re-uploaded bytes', async () => {
    const { hooks, revisionStore, staging, stage } = harness();
    const { component: product, texts } = component('product', { 'a.md': 'stable text' });
    await stage(texts);
    await withKnowledgePublication(hooks, tenant, 'deploy-1', [product], async () => 'ok');
    // Second deploy of identical content: transient staging has been cleared/expired.
    await staging.sweepExpired();
    await withKnowledgePublication(hooks, tenant, 'deploy-2', [product], async () => 'ok');
    const record = await revisionStore.record(
      (await revisionStore.active(tenant, 'product'))?.revisionId ?? '',
    );
    expect(record?.pins.has('deploy-1')).toBe(true);
    expect(record?.pins.has('deploy-2')).toBe(true);
  });

  it('rolls back every component revision pinned by a deployment', async () => {
    const { hooks, revisionStore, stage } = harness();
    const productV1 = component('product', { 'a.md': 'product v1 text' });
    const faqV1 = component('faq', { 'f.md': 'faq v1 text' });
    await stage(productV1.texts);
    await stage(faqV1.texts);
    await withKnowledgePublication(
      hooks,
      tenant,
      'deploy-1',
      [productV1.component, faqV1.component],
      async () => 'ok',
    );
    const productV2 = component('product', { 'a.md': 'product v2 text' });
    const faqV2 = component('faq', { 'f.md': 'faq v2 text' });
    await stage(productV2.texts);
    await stage(faqV2.texts);
    await withKnowledgePublication(
      hooks,
      tenant,
      'deploy-2',
      [productV2.component, faqV2.component],
      async () => 'ok',
    );

    await hooks.rollback('deploy-1');
    const productHits = await hooks.searchDocuments(tenant, 'product', { query: 'v1', limit: 5 });
    const faqHits = await hooks.searchDocuments(tenant, 'faq', { query: 'v1', limit: 5 });
    expect(productHits).toHaveLength(1);
    expect(faqHits).toHaveLength(1);
    expect((await revisionStore.active(tenant, 'product'))?.revisionId).toContain('bm25-rev');
  });

  it('serves a freshly activated revision from a second instance sharing the store (staleness)', async () => {
    const staging = new InMemoryKnowledgeStagingStore();
    const revisionStore = new InMemoryKnowledgeRevisionStore();
    const gate = { knowledgeEnabled: async () => true };
    let current = new Date('2026-08-16T10:00:00Z');
    const instanceA = createKnowledgeDeployHooks(
      { staging, revisionStore },
      { ...gate, now: () => current },
    );
    const instanceB = createKnowledgeDeployHooks(
      { staging, revisionStore },
      { ...gate, now: () => current },
    );
    const v1 = component('product', { 'a.md': 'instance one text' });
    await staging.put(
      'acme/site/prod',
      sha('instance one text'),
      Buffer.from('instance one text'),
      17,
    );
    await withKnowledgePublication(instanceA, tenant, 'deploy-1', [v1.component], async () => 'ok');
    // B has never seen this component; it must rebuild from the shared durable store.
    const cold = await instanceB.searchDocuments(tenant, 'product', {
      query: 'instance',
      limit: 5,
    });
    expect(cold).toHaveLength(1);

    const v2 = component('product', { 'a.md': 'instance two text updated' });
    await staging.put(
      'acme/site/prod',
      sha('instance two text updated'),
      Buffer.from('instance two text updated'),
      25,
    );
    await withKnowledgePublication(instanceB, tenant, 'deploy-2', [v2.component], async () => 'ok');
    // A's cached revision check is within TTL; advancing past it must surface B's activation.
    current = new Date('2026-08-16T10:00:10Z');
    const fresh = await instanceA.searchDocuments(tenant, 'product', {
      query: 'updated',
      limit: 5,
    });
    expect(fresh).toHaveLength(1);
  });
  it('keeps two components with identical content isolated (distinct revision identities)', async () => {
    const { hooks, revisionStore, stage } = harness();
    const sameText = { 'a.md': 'identical shared content' };
    const productComponent = component('product', sameText);
    const internal = component('internal_notes', sameText);
    await stage(sameText);
    await withKnowledgePublication(
      hooks,
      tenant,
      'deploy-1',
      [productComponent.component, internal.component],
      async () => 'ok',
    );
    const productActive = await revisionStore.active(tenant, 'product');
    const internalActive = await revisionStore.active(tenant, 'internal_notes');
    expect(productActive?.revisionId).toBeDefined();
    expect(internalActive?.revisionId).toBeDefined();
    expect(productActive?.revisionId).not.toBe(internalActive?.revisionId);
    const hits = await hooks.searchDocuments(tenant, 'product', { query: 'identical', limit: 5 });
    expect(hits).toHaveLength(1);
  });
});

describe('revision reuse identity (metadata included)', () => {
  /**
   * Reuse must key on everything a citation shows. Same bytes + a retitled document is a real
   * change: reusing the old revision would pin the deployment to stale metadata and rollback
   * would restore the wrong titles. Identical redeploys must still reuse — the second half is
   * what proves reuse was fixed, not disabled.
   */
  it('creates a new revision on a metadata-only change and reuses on an identical redeploy', async () => {
    const { revisionStore, hooks, stage } = harness();
    const first = component('product', { 'docs/a.md': 'alpha text' });
    await stage(first.texts);
    await withKnowledgePublication(hooks, tenant, 'deploy-1', [first.component], async () => 'ok');
    const initial = await revisionStore.active(
      { org: tenant.org, app: tenant.app, env: tenant.env },
      'product',
    );

    // Identical redeploy → reused revision.
    await stage(first.texts);
    await withKnowledgePublication(hooks, tenant, 'deploy-2', [first.component], async () => 'ok');
    const unchanged = await revisionStore.active(
      { org: tenant.org, app: tenant.app, env: tenant.env },
      'product',
    );
    expect(unchanged?.revisionId).toBe(initial?.revisionId);

    // Same bytes, retitled document → a NEW revision whose descriptors carry the new title.
    const retitled = {
      ...first.component,
      documents: first.component.documents.map((document) => ({
        ...document,
        title: 'Renamed guide',
      })),
    };
    await stage(first.texts);
    await withKnowledgePublication(hooks, tenant, 'deploy-3', [retitled], async () => 'ok');
    const renamed = await revisionStore.active(
      { org: tenant.org, app: tenant.app, env: tenant.env },
      'product',
    );
    expect(renamed?.revisionId).not.toBe(initial?.revisionId);
    expect(renamed?.documents.map((document) => document.title)).toEqual(['Renamed guide']);
  });
});
