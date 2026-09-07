import { describe, expect, it } from 'vitest';
import { compileKnowledgeComponents, type KnowledgeCompileIssue } from '../src/compile.js';
import { fuseHits, pathMatches, siteHitAllowed } from '../src/fusion.js';
import { buildExcerpt, normalizeExcerpt, searchRequestSchema, tokenize } from '../src/hits.js';
import {
  audiencePredicateSchema,
  documentDescriptorSchema,
  knowledgeComponentSchema,
  sitePolicySchema,
} from '../src/ir.js';
import {
  MAX_DOCUMENTS_PER_COMPONENT,
  MAX_KNOWLEDGE_COMPONENTS,
  MAX_QUERY_CHARS,
  MAX_RESULT_LIMIT,
  RRF_K,
} from '../src/limits.js';

describe('structural limits and schemas', () => {
  it('rejects queries beyond the 2000-character bound', () => {
    expect(
      searchRequestSchema.safeParse({ query: 'a'.repeat(MAX_QUERY_CHARS), limit: 8 }).success,
    ).toBe(true);
    expect(
      searchRequestSchema.safeParse({ query: 'a'.repeat(MAX_QUERY_CHARS + 1), limit: 8 }).success,
    ).toBe(false);
  });

  it('defaults the limit to 8 and caps it at 20', () => {
    expect(searchRequestSchema.parse({ query: 'x' }).limit).toBe(8);
    expect(searchRequestSchema.safeParse({ query: 'x', limit: MAX_RESULT_LIMIT + 1 }).success).toBe(
      false,
    );
    expect(searchRequestSchema.safeParse({ query: 'x', limit: 0 }).success).toBe(false);
  });

  it('accepts only a public audience in the retrieval predicate', () => {
    expect(audiencePredicateSchema.safeParse({ audience: 'public', revision: 'r1' }).success).toBe(
      true,
    );
    expect(audiencePredicateSchema.safeParse({ audience: 'private', revision: 'r1' }).success).toBe(
      false,
    );
  });

  it('rejects disallowed document extensions, root escapes, and empty titles', () => {
    const base = { title: 'T', sha256: 'a'.repeat(64), bytes: 10 };
    expect(documentDescriptorSchema.safeParse({ ...base, path: 'docs/a.md' }).success).toBe(true);
    expect(documentDescriptorSchema.safeParse({ ...base, path: 'docs/a.pdf' }).success).toBe(false);
    expect(documentDescriptorSchema.safeParse({ ...base, path: '../escape.md' }).success).toBe(
      false,
    );
    expect(documentDescriptorSchema.safeParse({ ...base, path: '/abs.md' }).success).toBe(false);
    expect(
      documentDescriptorSchema.safeParse({ ...base, path: 'docs/a.md', title: '' }).success,
    ).toBe(false);
    expect(
      documentDescriptorSchema.safeParse({
        ...base,
        path: 'docs/a.md',
        sourceUrl: 'http://insecure.example',
      }).success,
    ).toBe(false);
  });

  it('caps documents per component', () => {
    const documents = Array.from({ length: MAX_DOCUMENTS_PER_COMPONENT + 1 }, (_, index) => ({
      path: `d${index}.md`,
      title: 'T',
      sha256: 'a'.repeat(64),
      bytes: 1,
    }));
    const component = {
      name: 'product',
      title: 'T',
      description: 'D',
      documents: documents.slice(0, MAX_DOCUMENTS_PER_COMPONENT),
      sites: [],
    };
    expect(knowledgeComponentSchema.safeParse(component).success).toBe(true);
    expect(knowledgeComponentSchema.safeParse({ ...component, documents }).success).toBe(false);
  });

  it('requires exact HTTPS origins without paths and at least one include glob', () => {
    expect(
      sitePolicySchema.safeParse({ origin: 'https://www.acme.test', include: ['/docs/**'] })
        .success,
    ).toBe(true);
    expect(
      sitePolicySchema.safeParse({ origin: 'https://www.acme.test/docs', include: ['/docs/**'] })
        .success,
    ).toBe(false);
    expect(
      sitePolicySchema.safeParse({ origin: 'http://www.acme.test', include: ['/docs/**'] }).success,
    ).toBe(false);
    expect(
      sitePolicySchema.safeParse({ origin: 'https://www.acme.test', include: [] }).success,
    ).toBe(false);
  });
});

describe('excerpt normalization', () => {
  it('collapses whitespace and truncates with an ellipsis at the bound', () => {
    expect(normalizeExcerpt('a\n\n b   c ')).toBe('a b c');
    const long = 'x'.repeat(3000);
    const result = normalizeExcerpt(long, 100);
    expect(result.length).toBe(100);
    expect(result.endsWith('…')).toBe(true);
  });

  it('centres the excerpt window on query-term density deterministically', () => {
    const text = `${'padding '.repeat(100)}needle in the haystack${' padding'.repeat(100)}`;
    const first = buildExcerpt(text, 'needle', 80);
    const second = buildExcerpt(text, 'needle', 80);
    expect(first).toBe(second);
    expect(first.includes('needle')).toBe(true);
  });

  it('tokenizes on non-alphanumeric boundaries, lowercase', () => {
    expect(tokenize('Hello, World-2026!')).toEqual(['hello', 'world', '2026']);
  });
});

describe('path glob matching', () => {
  it('matches literals, single segments, and multi-segment globs', () => {
    expect(pathMatches('/pricing', '/pricing')).toBe(true);
    expect(pathMatches('/docs/a/b', '/docs/**')).toBe(true);
    expect(pathMatches('/docs', '/docs/**')).toBe(false);
    expect(pathMatches('/docs/guide', '/docs/*')).toBe(true);
    expect(pathMatches('/docs/a/b', '/docs/*')).toBe(false);
    expect(pathMatches('/other', '/docs/**')).toBe(false);
  });

  it('matches the root pathname with the root glob and nothing else', () => {
    // A single-page site's only content IS the root; before this rule the root was
    // unmatchable by any glob and '/' matched nothing (a whole site incl. root is ['/', '/**']).
    expect(pathMatches('/', '/')).toBe(true);
    expect(pathMatches('/docs', '/')).toBe(false);
    expect(pathMatches('/', '/**')).toBe(false);
    expect(pathMatches('/', '/*')).toBe(false);
    expect(pathMatches('/', '/docs/**')).toBe(false);
  });
});

describe('site hit admission', () => {
  const policy = { origin: 'https://www.acme.test', include: ['/docs/**'] };
  const hit = (uri: string) => ({
    id: uri,
    title: 'T',
    excerpt: 'x',
    sourceKind: 'site' as const,
    uri,
  });

  it('admits exact-origin approved-path hits and rejects everything else', () => {
    expect(siteHitAllowed(policy, hit('https://www.acme.test/docs/a'))).toBe(true);
    expect(siteHitAllowed(policy, hit('https://acme.test/docs/a'))).toBe(false);
    expect(siteHitAllowed(policy, hit('https://www.acme.test/blog/a'))).toBe(false);
    expect(siteHitAllowed(policy, hit('https://evil.test/docs/a'))).toBe(false);
  });

  it('never admits a document hit through the site policy', () => {
    expect(
      siteHitAllowed(policy, { id: 'doc:1', title: 'T', excerpt: 'x', sourceKind: 'document' }),
    ).toBe(false);
  });

  it('admits the origin root under an include of "/"', () => {
    const rootPolicy = { origin: 'https://www.acme.test', include: ['/'] };
    expect(siteHitAllowed(rootPolicy, hit('https://www.acme.test/'))).toBe(true);
    expect(siteHitAllowed(rootPolicy, hit('https://www.acme.test'))).toBe(true);
    expect(siteHitAllowed(rootPolicy, hit('https://www.acme.test/docs/a'))).toBe(false);
  });
});

describe('RRF fusion', () => {
  const sitePolicies = [{ origin: 'https://www.acme.test', include: ['/docs/**'] }];

  it('fuses equal-weight ranks with k=60 and respects the requested limit', () => {
    const documents = [
      { id: 'doc:1', title: 'A', excerpt: 'x', sourceKind: 'document' as const },
      { id: 'doc:2', title: 'B', excerpt: 'x', sourceKind: 'document' as const },
    ];
    const sites = [
      {
        id: 'https://www.acme.test/docs/s1',
        title: 'S',
        excerpt: 'x',
        sourceKind: 'site' as const,
        uri: 'https://www.acme.test/docs/s1',
      },
    ];
    const fused = fuseHits(documents, sites, { limit: 2, sitePolicies });
    expect(fused).toHaveLength(2);
    // Rank-0 in both lists: 2/(60+1) each ≈ 0.0328 for doc:1 vs 1/(60+1) for doc:2.
    expect(fused[0]?.id).toBe('doc:1');
  });

  it('returns an empty result for empty inputs instead of an error', () => {
    expect(fuseHits([], [], { limit: 8, sitePolicies })).toEqual([]);
  });

  it('uses exactly the k=60 constant', () => {
    expect(RRF_K).toBe(60);
  });
});

describe('component count cap', () => {
  /**
   * The cap must bind at compile time — the deploy wire contract enforces the same number, and
   * a validly compiled app must never learn about a limit only from a failed deploy.
   */
  it('rejects more than MAX_KNOWLEDGE_COMPONENTS at the compile pass', () => {
    const components = Array.from({ length: MAX_KNOWLEDGE_COMPONENTS + 1 }, (_, index) => ({
      name: `component_${index}`,
      title: `Component ${index}`,
      description: 'D.',
      documents: [{ path: 'a.md', title: 'A', sha256: 'a'.repeat(64), bytes: 3 }],
      sites: [],
    }));
    const issues: KnowledgeCompileIssue[] = [];
    compileKnowledgeComponents(components, undefined, issues);
    expect(issues.some((issue) => issue.message.includes(String(MAX_KNOWLEDGE_COMPONENTS)))).toBe(
      true,
    );

    const atCap: KnowledgeCompileIssue[] = [];
    compileKnowledgeComponents(components.slice(0, MAX_KNOWLEDGE_COMPONENTS), undefined, atCap);
    expect(atCap).toEqual([]);
  });
});
