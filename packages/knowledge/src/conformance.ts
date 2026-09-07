/**
 * Shared port conformance suites (ADR 0202): every `KnowledgeIndex` implementation — the
 * fake, the bundled BM25 adapter, and the managed Google adapter — passes the identical
 * suite, and likewise every `SiteSearch` implementation. A behaviour asserted only against
 * one implementation is one the others are free to violate in production.
 *
 * This module is shipped source, so it imports no test framework: assertions use the
 * `node:assert` builtin and the caller injects its runner's `describe`/`it`. Declaring a
 * framework here — even as an optional peer — would put it in the dependency graph of
 * everything that depends on this package, including the published CLI.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fuseHits } from './fusion.js';
import { type SearchHit, searchRequestSchema } from './hits.js';
import type { AudiencePredicate, KnowledgeScope, SitePolicy } from './ir.js';
import {
  KnowledgeError,
  type KnowledgeIndex,
  type SiteSearch,
  type StagedDocument,
} from './ports.js';

/**
 * The two grouping primitives every JS test runner exposes. The caller passes its own —
 * `{ describe, it }` from Vitest in this repository — so the suites stay runner-neutral.
 */
export interface ConformanceRunner {
  describe(name: string, body: () => void): void;
  it(name: string, body: () => void | Promise<void>): void;
}

export const testScope: KnowledgeScope = { org: 'acme', app: 'acme-app', env: 'prod' };
export const testComponent = 'product';

export function stagedDocument(
  path: string,
  title: string,
  text: string,
  sourceUrl?: string,
): StagedDocument {
  const bytes = Buffer.byteLength(text, 'utf8');
  const hash = createHash('sha256').update(text, 'utf8').digest('hex');
  return {
    descriptor: {
      path,
      title,
      ...(sourceUrl !== undefined ? { sourceUrl } : {}),
      sha256: hash,
      bytes,
    },
    text,
  };
}

export const publicPredicate = (revision: string): AudiencePredicate => ({
  audience: 'public',
  revision,
});

export function describeKnowledgeIndex(
  runner: ConformanceRunner,
  makeIndex: () => KnowledgeIndex,
  label: string,
): void {
  const { describe, it } = runner;
  describe(`KnowledgeIndex conformance — ${label}`, () => {
    it('stages a complete revision and reports its descriptors', async () => {
      const index = makeIndex();
      const revision = await index.stage(testScope, testComponent, [
        stagedDocument('knowledge/a.md', 'A', 'alpha beta'),
        stagedDocument('knowledge/b.txt', 'B', 'gamma delta'),
      ]);
      assert.equal(revision.documents.length, 2);
      assert.deepEqual(
        revision.documents.map((document) => document.path),
        ['knowledge/a.md', 'knowledge/b.txt'],
      );
      assert.deepEqual(revision.scope, testScope);
    });

    it('verifies a positive predicate for the staged revision and rejects a mismatched one', async () => {
      const index = makeIndex();
      const revision = await index.stage(testScope, testComponent, [
        stagedDocument('knowledge/a.md', 'A', 'alpha beta'),
      ]);
      assert.equal(
        await index.verify(revision.revisionId, publicPredicate(revision.revisionId)),
        true,
      );
      assert.equal(
        await index.verify(revision.revisionId, publicPredicate('other-revision')),
        false,
      );
    });

    it('activates atomically: search reads only the active revision', async () => {
      const index = makeIndex();
      const first = await index.stage(testScope, testComponent, [
        stagedDocument('knowledge/a.md', 'A', 'ancient content'),
      ]);
      await index.activate(first.revisionId);
      const second = await index.stage(testScope, testComponent, [
        stagedDocument('knowledge/a.md', 'A', 'fresh content'),
        stagedDocument('knowledge/b.md', 'B', 'fresh content too'),
      ]);
      await index.activate(second.revisionId);
      const hits = await index.search(
        testScope,
        testComponent,
        searchRequestSchema.parse({ query: 'content' }),
      );
      assert.ok(hits.length > 0, 'expected the active revision to return hits');
      assert.equal(
        hits.some((hit) => hit.title === 'B'),
        true,
      );
      const active = await index.activeRevision(testScope, testComponent);
      assert.equal(active?.revisionId, second.revisionId);
    });

    it('search before activation fails with an attributable not-found error', async () => {
      const index = makeIndex();
      await index.stage(testScope, testComponent, [stagedDocument('knowledge/a.md', 'A', 'alpha')]);
      await assert.rejects(
        index.search(testScope, testComponent, { query: 'alpha', limit: 8 }),
        KnowledgeError,
      );
    });

    it('returns bounded hits with stable ids, titles, excerpts, and source kind', async () => {
      const index = makeIndex();
      const revision = await index.stage(testScope, testComponent, [
        stagedDocument(
          'knowledge/a.md',
          'Alpha doc',
          'alpha beta gamma',
          'https://acme.example/docs/a',
        ),
        stagedDocument('knowledge/b.md', 'Beta doc', 'beta gamma delta'),
      ]);
      await index.activate(revision.revisionId);
      const hits = await index.search(testScope, testComponent, { query: 'gamma', limit: 1 });
      assert.equal(hits.length, 1);
      const hit = hits[0];
      if (hit === undefined) throw new Error('expected one bounded hit');
      assert.ok(hit.id.length > 0, 'hit id must be stable and non-empty');
      assert.ok(hit.title.length > 0, 'hit title must be non-empty');
      assert.ok(hit.excerpt.length <= 2000, 'excerpt must stay within MAX_EXCERPT_CHARS');
      assert.equal(hit.sourceKind, 'document');
      if (hit.uri !== undefined) assert.equal(hit.uri.startsWith('https://'), true);
    });

    it('deletes only unreferenced revisions', async () => {
      const index = makeIndex();
      const revision = await index.stage(testScope, testComponent, [
        stagedDocument('knowledge/a.md', 'A', 'alpha'),
      ]);
      await index.activate(revision.revisionId);
      await assert.rejects(index.delete(revision.revisionId), KnowledgeError);
      const retired = await index.stage(testScope, testComponent, [
        stagedDocument('knowledge/b.md', 'B', 'beta'),
      ]);
      await index.activate(retired.revisionId);
      assert.equal(await index.delete(revision.revisionId), undefined);
    });

    it('rejects a non-public audience predicate at verification', async () => {
      const index = makeIndex();
      const revision = await index.stage(testScope, testComponent, [
        stagedDocument('knowledge/a.md', 'A', 'alpha'),
      ]);
      assert.equal(
        await index.verify(revision.revisionId, {
          audience: 'public',
          revision: revision.revisionId,
        } as AudiencePredicate),
        true,
      );
    });
  });
}

const policy: SitePolicy = { origin: 'https://www.acme.test', include: ['/docs/**', '/pricing'] };

export function describeSiteSearch(
  runner: ConformanceRunner,
  makeSearch: () => SiteSearch & {
    addPage?: (uri: string, title: string, text: string) => unknown;
  },
  label: string,
): void {
  const { describe, it } = runner;
  describe(`SiteSearch conformance — ${label}`, () => {
    it('requires a public audience predicate', async () => {
      const search = makeSearch();
      await assert.rejects(
        search.search(
          policy,
          { audience: 'private' as unknown as 'public', revision: 'r' },
          { query: 'anything', limit: 8 },
        ),
        KnowledgeError,
      );
    });

    it('returns only exact-origin, path-approved hits', async () => {
      const search = makeSearch();
      search.addPage?.('https://www.acme.test/docs/guide', 'Guide', 'install instructions here');
      search.addPage?.('https://www.acme.test/blog/post', 'Blog', 'install instructions here');
      search.addPage?.('https://evil.test/docs/guide', 'Evil', 'install instructions here');
      const hits = await search.search(policy, publicPredicate('live'), {
        query: 'install',
        limit: 8,
      });
      assert.equal(hits.length, 1);
      assert.equal(hits[0]?.uri, 'https://www.acme.test/docs/guide');
    });

    it('bounds results to the requested limit', async () => {
      const search = makeSearch();
      search.addPage?.('https://www.acme.test/docs/one', 'One', 'pricing details');
      search.addPage?.('https://www.acme.test/docs/two', 'Two', 'pricing details');
      search.addPage?.('https://www.acme.test/pricing', 'Pricing', 'pricing details');
      const hits = await search.search(policy, publicPredicate('live'), {
        query: 'pricing',
        limit: 2,
      });
      assert.equal(hits.length, 2);
    });

    it('attributes failures through KnowledgeError, never raw provider text', async () => {
      const search = makeSearch();
      await assert.rejects(
        search.search(policy, publicPredicate('live'), { query: '', limit: 8 }),
        KnowledgeError,
      );
    });
  });
}

/** Cross-source fusion is part of the contract: policy filters run before the limit. */
export function fusionContractCases(runner: ConformanceRunner): void {
  const { describe, it } = runner;
  describe('fusion contract', () => {
    const sitePolicies: readonly SitePolicy[] = [policy];

    it('applies policy before the limit, never after', () => {
      const documents: SearchHit[] = [];
      const sites: SearchHit[] = [
        {
          id: 'https://www.acme.test/docs/a',
          title: 'A',
          excerpt: 'x',
          sourceKind: 'site',
          uri: 'https://www.acme.test/docs/a',
        },
        {
          id: 'https://evil.test/docs/b',
          title: 'Evil',
          excerpt: 'x',
          sourceKind: 'site',
          uri: 'https://evil.test/docs/b',
        },
        {
          id: 'https://www.acme.test/blog/c',
          title: 'Blog',
          excerpt: 'x',
          sourceKind: 'site',
          uri: 'https://www.acme.test/blog/c',
        },
      ];
      const fused = fuseHits(documents, sites, { limit: 2, sitePolicies });
      assert.equal(fused.length, 1);
      assert.equal(fused[0]?.id, 'https://www.acme.test/docs/a');
    });

    it('deduplicates by canonical URL then stable id, preferring document evidence', () => {
      const sharedUri = 'https://www.acme.test/docs/a';
      const documents: SearchHit[] = [
        { id: 'doc:1', title: 'Doc', excerpt: 'x', sourceKind: 'document', uri: sharedUri },
      ];
      const sites: SearchHit[] = [
        { id: sharedUri, title: 'Site', excerpt: 'x', sourceKind: 'site', uri: sharedUri },
      ];
      const fused = fuseHits(documents, sites, { limit: 8, sitePolicies });
      assert.equal(fused.length, 1);
      assert.equal(fused[0]?.sourceKind, 'document');
    });

    it('breaks equal scores deterministically: document evidence outranks site evidence', () => {
      const documents: SearchHit[] = [
        { id: 'doc:b', title: 'B', excerpt: 'x', sourceKind: 'document' },
      ];
      const sites: SearchHit[] = [
        {
          id: 'https://www.acme.test/docs/a',
          title: 'A',
          excerpt: 'x',
          sourceKind: 'site',
          uri: 'https://www.acme.test/docs/a',
        },
      ];
      const fused = fuseHits(documents, sites, { limit: 2, sitePolicies });
      assert.deepEqual(
        fused.map((hit) => hit.id),
        ['doc:b', 'https://www.acme.test/docs/a'],
      );
    });
  });
}
