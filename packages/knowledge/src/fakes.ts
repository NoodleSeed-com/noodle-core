/**
 * In-memory reference implementations of the knowledge ports. They exist to make the shared
 * conformance suites executable without a provider; the bundled BM25 adapter and the managed
 * Google adapter must pass the exact same suites.
 */
import { createHash } from 'node:crypto';
import { siteHitAllowed } from './fusion.js';
import { buildExcerpt, type SearchHit, type SearchRequest, tokenize } from './hits.js';
import type { AudiencePredicate, KnowledgeScope, SitePolicy } from './ir.js';
import { knowledgeScopeKey } from './ir.js';
import {
  KnowledgeError,
  type KnowledgeIndex,
  type KnowledgeRevision,
  type SiteSearch,
  type StagedDocument,
} from './ports.js';

interface FakeEntry {
  readonly revision: KnowledgeRevision;
  readonly documents: readonly StagedDocument[];
  state: 'staged' | 'active' | 'retired';
  pins: Set<string>;
}

export class FakeKnowledgeIndex implements KnowledgeIndex {
  private readonly entries = new Map<string, FakeEntry>();

  async stage(
    scope: KnowledgeScope,
    componentName: string,
    documents: readonly StagedDocument[],
  ): Promise<KnowledgeRevision> {
    const hash = createHash('sha256')
      .update(documents.map((document) => document.descriptor.sha256).join('\n'))
      .digest('hex');
    const revisionId = `fake-rev-${hash.slice(0, 16)}`;
    this.entries.set(revisionId, {
      revision: {
        revisionId,
        scope,
        componentName,
        documents: documents.map((document) => document.descriptor),
      },
      documents,
      state: 'staged',
      pins: new Set<string>(),
    });
    return {
      revisionId,
      scope,
      componentName,
      documents: documents.map((document) => document.descriptor),
    };
  }

  async verify(revisionId: string, predicate: AudiencePredicate): Promise<boolean> {
    const entry = this.require(revisionId);
    if (predicate.audience !== 'public') {
      throw new KnowledgeError('predicate', 'fake index only accepts a public audience');
    }
    return entry.revision.revisionId === predicate.revision && entry.documents.length > 0;
  }

  async activate(revisionId: string): Promise<void> {
    const entry = this.require(revisionId);
    for (const other of this.entries.values()) {
      if (
        other !== entry &&
        other.state === 'active' &&
        knowledgeScopeKey(other.revision.scope, other.revision.componentName) ===
          knowledgeScopeKey(entry.revision.scope, entry.revision.componentName)
      ) {
        other.state = 'retired';
      }
    }
    entry.state = 'active';
  }

  async search(
    scope: KnowledgeScope,
    componentName: string,
    request: SearchRequest,
  ): Promise<readonly SearchHit[]> {
    const scopeKey = knowledgeScopeKey(scope, componentName);
    const entry = [...this.entries.values()].find(
      (candidate) =>
        candidate.state === 'active' &&
        knowledgeScopeKey(candidate.revision.scope, candidate.revision.componentName) === scopeKey,
    );
    if (entry === undefined)
      throw new KnowledgeError('not-found', 'no active revision for this component');

    const terms = new Set(tokenize(request.query));
    return entry.documents
      .map((document) => {
        const documentTerms = tokenize(document.text);
        const matches = documentTerms.filter((term) => terms.has(term)).length;
        return { document, matches };
      })
      .filter((candidate) => candidate.matches > 0)
      .sort((a, b) =>
        b.matches !== a.matches
          ? b.matches - a.matches
          : a.document.descriptor.path.localeCompare(b.document.descriptor.path),
      )
      .slice(0, request.limit)
      .map(({ document }) => fakeDocumentHit(document));
  }

  async delete(revisionId: string): Promise<void> {
    const entry = this.require(revisionId);
    if (entry.state === 'active')
      throw new KnowledgeError('store', 'cannot delete the active revision');
    if (entry.pins.size > 0) throw new KnowledgeError('store', 'cannot delete a pinned revision');
    this.entries.delete(revisionId);
  }

  async activeRevision(
    scope: KnowledgeScope,
    componentName: string,
  ): Promise<KnowledgeRevision | undefined> {
    const scopeKey = knowledgeScopeKey(scope, componentName);
    return [...this.entries.values()].find(
      (candidate) =>
        candidate.state === 'active' &&
        knowledgeScopeKey(candidate.revision.scope, candidate.revision.componentName) === scopeKey,
    )?.revision;
  }

  /** Test hook: pin a revision like a deployment record would. */
  pin(revisionId: string, deploymentId: string): void {
    this.require(revisionId).pins.add(deploymentId);
  }

  private require(revisionId: string): FakeEntry {
    const entry = this.entries.get(revisionId);
    if (entry === undefined)
      throw new KnowledgeError('not-found', `unknown revision ${revisionId}`);
    return entry;
  }
}

export function fakeDocumentHit(document: StagedDocument): SearchHit {
  return {
    id: `doc:${document.descriptor.sha256.slice(0, 16)}`,
    title: document.descriptor.title,
    excerpt: buildExcerpt(document.text, ''),
    sourceKind: 'document',
    ...(document.descriptor.sourceUrl !== undefined ? { uri: document.descriptor.sourceUrl } : {}),
  };
}

/** Seeded live-site result set; applies the exact origin/path policy as its postfilter. */
export class FakeSiteSearch implements SiteSearch {
  private readonly pages = new Map<string, { title: string; text: string }>();

  addPage(uri: string, title: string, text: string): this {
    this.pages.set(uri, { title, text });
    return this;
  }

  async search(
    policy: SitePolicy,
    predicate: AudiencePredicate,
    request: SearchRequest,
  ): Promise<readonly SearchHit[]> {
    if (predicate.audience !== 'public') {
      throw new KnowledgeError('predicate', 'site search rejects non-public audiences');
    }
    if (request.query.trim().length === 0) {
      throw new KnowledgeError('request', 'query must not be empty');
    }
    const terms = new Set(tokenize(request.query));
    return [...this.pages.entries()]
      .map(([uri, page]) => {
        const hit: SearchHit = {
          id: uri,
          title: page.title,
          excerpt: buildExcerpt(page.text, request.query),
          sourceKind: 'site',
          uri,
        };
        const matches = tokenize(`${page.title} ${page.text}`).filter((term) =>
          terms.has(term),
        ).length;
        return { hit, matches };
      })
      .filter(({ hit, matches }) => matches > 0 && siteHitAllowed(policy, hit))
      .sort((a, b) => b.matches - a.matches || a.hit.id.localeCompare(b.hit.id))
      .slice(0, request.limit)
      .map(({ hit }) => hit);
  }
}
