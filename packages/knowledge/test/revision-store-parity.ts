import { expect, it } from 'vitest';
import type { KnowledgeScope } from '../src/ir.js';
import { KnowledgeError, type KnowledgeRevision, type StagedDocument } from '../src/ports.js';
import type { DocumentTextCodec, KnowledgeRevisionStore } from '../src/revision-store.js';

/**
 * One behavioural contract, run against every revision-store implementation (ADR 0202 deploy
 * transaction). A store that passes this is interchangeable at the publication seam; anything
 * asserted only against the in-memory store is a property the durable path is free to violate
 * in production — which is the direction that matters.
 */
export function describeRevisionStore(
  makeStore: (codec?: DocumentTextCodec) => Promise<KnowledgeRevisionStore>,
  prefix = 'r',
): void {
  const scope: KnowledgeScope = { org: 'acme', app: 'app', env: 'prod' };

  const revision = (id: string, hashes: readonly string[]): KnowledgeRevision => ({
    revisionId: `${prefix}-${id}`,
    scope,
    componentName: 'product',
    documents: hashes.map((sha256, index) => ({
      path: `d${index}.md`,
      title: `Doc ${index}`,
      sha256,
      bytes: 10,
    })),
  });

  const stagedDocs = (target: KnowledgeRevision, texts: readonly string[]): StagedDocument[] =>
    target.documents.map((descriptor, index) => ({
      descriptor,
      text: texts[index] ?? `text for ${descriptor.path}`,
    }));

  it('reuses the revision for an identical content hash and keeps a distinct one for new content', async () => {
    const store = await makeStore();
    await store.stage({
      scope,
      componentName: 'product',
      contentHash: 'h1',
      revision: revision('1', ['a'.repeat(64)]),
    });
    const again = await store.stage({
      scope,
      componentName: 'product',
      contentHash: 'h1',
      revision: revision('1-dup', ['a'.repeat(64)]),
    });
    expect(again.revisionId).toBe(`${prefix}-1`);
    await store.stage({
      scope,
      componentName: 'product',
      contentHash: 'h2',
      revision: revision('2', ['b'.repeat(64)]),
    });
    expect((await store.record(`${prefix}-2`))?.state).toBe('staged');
  });

  it('activates atomically and retires the previous active revision', async () => {
    const store = await makeStore();
    await store.stage({
      scope,
      componentName: 'product',
      contentHash: 'h3',
      revision: revision('3', ['c'.repeat(64)]),
    });
    await store.stage({
      scope,
      componentName: 'product',
      contentHash: 'h4',
      revision: revision('4', ['d'.repeat(64)]),
    });
    await store.activate(scope, 'product', `${prefix}-3`, `${prefix}-deploy-a`);
    await store.activate(scope, 'product', `${prefix}-4`, `${prefix}-deploy-b`);
    expect((await store.record(`${prefix}-3`))?.state).toBe('retired');
    expect((await store.active(scope, 'product'))?.revisionId).toBe(`${prefix}-4`);
  });

  it('refuses activation of an unstaged revision', async () => {
    const store = await makeStore();
    await expect(
      store.activate(scope, 'product', `${prefix}-missing`, 'deploy-x'),
    ).rejects.toBeInstanceOf(KnowledgeError);
  });

  it('rolls back to the deployment-pinned revision', async () => {
    const store = await makeStore();
    await store.stage({
      scope,
      componentName: 'product',
      contentHash: 'h5',
      revision: revision('5', ['e'.repeat(64)]),
    });
    await store.activate(scope, 'product', `${prefix}-5`, `${prefix}-deploy-c`);
    await store.stage({
      scope,
      componentName: 'product',
      contentHash: 'h6',
      revision: revision('6', ['f'.repeat(64)]),
    });
    await store.activate(scope, 'product', `${prefix}-6`, `${prefix}-deploy-d`);
    const restored = await store.rollback(`${prefix}-deploy-c`);
    expect(restored[0]?.revisionId).toBe(`${prefix}-5`);
    expect((await store.active(scope, 'product'))?.revisionId).toBe(`${prefix}-5`);
    expect((await store.record(`${prefix}-6`))?.state).toBe('retired');
  });

  it('garbage-collects only unreferenced revisions and keeps pinned retired ones', async () => {
    const store = await makeStore();
    await store.stage({
      scope,
      componentName: 'product',
      contentHash: 'h7',
      revision: revision('7', ['1'.repeat(64)]),
    });
    await store.stage({
      scope,
      componentName: 'product',
      contentHash: 'h8',
      revision: revision('8', ['2'.repeat(64)]),
    });
    await store.stage({
      scope,
      componentName: 'product',
      contentHash: 'h9',
      revision: revision('9', ['3'.repeat(64)]),
    });
    await store.activate(scope, 'product', `${prefix}-9`, `${prefix}-deploy-e`);
    // 7 retired + unpinned and 8 staged + unpinned are collectable; the active 9 is retained.
    expect(await store.collectGarbage()).toBe(2);
    expect(await store.record(`${prefix}-7`)).toBeUndefined();
    expect(await store.record(`${prefix}-9`)).toBeDefined();
  });

  it('refuses to delete an active or pinned revision', async () => {
    const store = await makeStore();
    await store.stage({
      scope,
      componentName: 'product',
      contentHash: 'h10',
      revision: revision('10', ['4'.repeat(64)]),
    });
    await store.activate(scope, 'product', `${prefix}-10`, `${prefix}-deploy-f`);
    await expect(store.delete(`${prefix}-10`)).rejects.toBeInstanceOf(KnowledgeError);
    await store.stage({
      scope,
      componentName: 'product',
      contentHash: 'h11',
      revision: revision('11', ['5'.repeat(64)]),
    });
    await store.pin(`${prefix}-11`, `${prefix}-deploy-g`);
    await expect(store.delete(`${prefix}-11`)).rejects.toBeInstanceOf(KnowledgeError);
  });

  it('serializes publication per component/scope through a lease', async () => {
    const store = await makeStore();
    const first = await store.acquireLease(scope, 'product', 'holder-1');
    const secondPromise = store.acquireLease(scope, 'product', 'holder-2');
    await store.releaseLease(first);
    const second = await secondPromise;
    expect(second.scopeKey).toBe(first.scopeKey);
    await store.releaseLease(second);
  });

  it('finds a staged or active revision by scope and content hash', async () => {
    const store = await makeStore();
    const target = revision('19', ['9'.repeat(64)]);
    await store.stage({ scope, componentName: 'product', contentHash: 'h19', revision: target });
    expect((await store.findByContentHash(scope, 'product', 'h19'))?.revisionId).toBe(
      `${prefix}-19`,
    );
    expect(await store.findByContentHash(scope, 'product', 'h-absent')).toBeUndefined();
    expect(await store.findByContentHash(scope, 'other-component', 'h19')).toBeUndefined();
  });

  it('round-trips staged document text for a revision', async () => {
    const store = await makeStore();
    const target = revision('20', ['a'.repeat(64), 'b'.repeat(64)]);
    await store.stage({ scope, componentName: 'product', contentHash: 'h20', revision: target });
    await store.stageDocuments(target.revisionId, stagedDocs(target, ['first text', 'second']));
    const documents = await store.documents(target.revisionId);
    expect(documents.map((doc) => doc.text)).toEqual(['first text', 'second']);
    expect(documents.map((doc) => doc.descriptor.path)).toEqual(['d0.md', 'd1.md']);
  });

  it('replaces document text idempotently on re-staging', async () => {
    const store = await makeStore();
    const target = revision('21', ['c'.repeat(64)]);
    await store.stage({ scope, componentName: 'product', contentHash: 'h21', revision: target });
    await store.stageDocuments(target.revisionId, stagedDocs(target, ['v1']));
    await store.stageDocuments(target.revisionId, stagedDocs(target, ['v2']));
    const documents = await store.documents(target.revisionId);
    expect(documents).toHaveLength(1);
    expect(documents[0]?.text).toBe('v2');
  });

  it('applies the injected codec so text is recoverable through seal/open', async () => {
    const reversing: DocumentTextCodec = {
      seal: (buffer) => Buffer.from([...buffer].reverse()),
      open: (buffer) => Buffer.from([...buffer].reverse()),
    };
    const store = await makeStore(reversing);
    const target = revision('22', ['d'.repeat(64)]);
    await store.stage({ scope, componentName: 'product', contentHash: 'h22', revision: target });
    await store.stageDocuments(target.revisionId, stagedDocs(target, ['codec round trip']));
    const documents = await store.documents(target.revisionId);
    expect(documents[0]?.text).toBe('codec round trip');
  });

  it('refuses text reads for an unstaged revision and for missing text', async () => {
    const store = await makeStore();
    await expect(store.documents(`${prefix}-missing`)).rejects.toBeInstanceOf(KnowledgeError);
    const target = revision('23', ['e'.repeat(64)]);
    await store.stage({ scope, componentName: 'product', contentHash: 'h23', revision: target });
    // Descriptors exist but text was never staged — a rebuild must fail loudly, not return [].
    await expect(store.documents(target.revisionId)).rejects.toBeInstanceOf(KnowledgeError);
  });

  it('removes document text when its revision is deleted or garbage-collected', async () => {
    const store = await makeStore();
    const deleted = revision('24', ['f'.repeat(64)]);
    await store.stage({ scope, componentName: 'product', contentHash: 'h24', revision: deleted });
    await store.stageDocuments(deleted.revisionId, stagedDocs(deleted, ['gone']));
    await store.delete(deleted.revisionId);
    await expect(store.documents(deleted.revisionId)).rejects.toBeInstanceOf(KnowledgeError);

    const collected = revision('25', ['1'.repeat(64)]);
    const survivor = revision('26', ['2'.repeat(64)]);
    await store.stage({ scope, componentName: 'product', contentHash: 'h25', revision: collected });
    await store.stageDocuments(collected.revisionId, stagedDocs(collected, ['swept']));
    await store.stage({ scope, componentName: 'product', contentHash: 'h26', revision: survivor });
    await store.stageDocuments(survivor.revisionId, stagedDocs(survivor, ['kept']));
    await store.activate(scope, 'product', survivor.revisionId, `${prefix}-deploy-h`);
    await store.collectGarbage();
    await expect(store.documents(collected.revisionId)).rejects.toBeInstanceOf(KnowledgeError);
    expect((await store.documents(survivor.revisionId))[0]?.text).toBe('kept');
  });

  it('pins one revision per component for a deployment and rolls back all of them', async () => {
    const store = await makeStore();
    const productRevision = (id: string, hash: string): KnowledgeRevision => ({
      revisionId: `${prefix}-${id}`,
      scope,
      componentName: 'product',
      documents: [{ path: 'p.md', title: 'P', sha256: hash, bytes: 5 }],
    });
    const faqRevision = (id: string, hash: string): KnowledgeRevision => ({
      revisionId: `${prefix}-${id}`,
      scope,
      componentName: 'faq',
      documents: [{ path: 'f.md', title: 'F', sha256: hash, bytes: 5 }],
    });
    await store.stage({
      scope,
      componentName: 'product',
      contentHash: 'hp1',
      revision: productRevision('30', '6'.repeat(64)),
    });
    await store.stage({
      scope,
      componentName: 'faq',
      contentHash: 'hf1',
      revision: faqRevision('31', '7'.repeat(64)),
    });
    await store.activate(scope, 'product', `${prefix}-30`, `${prefix}-deploy-k`);
    await store.activate(scope, 'faq', `${prefix}-31`, `${prefix}-deploy-k`);

    await store.stage({
      scope,
      componentName: 'product',
      contentHash: 'hp2',
      revision: productRevision('32', '8'.repeat(64)),
    });
    await store.stage({
      scope,
      componentName: 'faq',
      contentHash: 'hf2',
      revision: faqRevision('33', '9'.repeat(64)),
    });
    await store.activate(scope, 'product', `${prefix}-32`, `${prefix}-deploy-l`);
    await store.activate(scope, 'faq', `${prefix}-33`, `${prefix}-deploy-l`);

    const restored = await store.rollback(`${prefix}-deploy-k`);
    expect(restored.map((revision) => revision.revisionId).sort()).toEqual([
      `${prefix}-30`,
      `${prefix}-31`,
    ]);
    expect((await store.active(scope, 'product'))?.revisionId).toBe(`${prefix}-30`);
    expect((await store.active(scope, 'faq'))?.revisionId).toBe(`${prefix}-31`);
  });

  it('keeps document text readable for a pinned revision across rollback', async () => {
    const store = await makeStore();
    const first = revision('27', ['3'.repeat(64)]);
    const second = revision('28', ['4'.repeat(64)]);
    await store.stage({ scope, componentName: 'product', contentHash: 'h27', revision: first });
    await store.stageDocuments(first.revisionId, stagedDocs(first, ['pinned text']));
    await store.activate(scope, 'product', first.revisionId, `${prefix}-deploy-i`);
    await store.stage({ scope, componentName: 'product', contentHash: 'h28', revision: second });
    await store.stageDocuments(second.revisionId, stagedDocs(second, ['newer text']));
    await store.activate(scope, 'product', second.revisionId, `${prefix}-deploy-j`);
    await store.rollback(`${prefix}-deploy-i`);
    // The BM25 rebuild after rollback reads exactly the pinned revision's text.
    expect((await store.documents(first.revisionId))[0]?.text).toBe('pinned text');
  });

  it('unpin releases a retired revision to GC while the active successor stays', async () => {
    const store = await makeStore();
    const first = revision('40', ['5'.repeat(64)]);
    const second = revision('41', ['6'.repeat(64)]);
    await store.stage({ scope, componentName: 'product', contentHash: 'h40', revision: first });
    await store.activate(scope, 'product', first.revisionId, `${prefix}-crawl`);
    await store.stage({ scope, componentName: 'product', contentHash: 'h41', revision: second });
    await store.activate(scope, 'product', second.revisionId, `${prefix}-crawl`);
    // Retired but still pinned: protected.
    expect(await store.collectGarbage()).toBe(0);
    await store.unpin(first.revisionId, `${prefix}-crawl`);
    expect(await store.collectGarbage()).toBe(1);
    expect((await store.active(scope, 'product'))?.revisionId).toBe(second.revisionId);
    // Unknown revision and absent pin are no-ops.
    await store.unpin(`${prefix}-missing`, `${prefix}-crawl`);
  });
}
