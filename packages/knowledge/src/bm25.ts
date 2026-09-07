/**
 * The bundled production `KnowledgeIndex` adapter: an in-process BM25 index built from the
 * active revision's documents at activation time (ADR 0202 as amended — managed-bundled v0).
 *
 * Deliberate scope: curated public corpora within the structural limits (≤100 docs, ≤25 MiB)
 * where lexical retrieval is honest evidence. Semantic ranking is the managed-Google tier's
 * job; this adapter must never grow an embedding pipeline.
 */
import { createHash } from 'node:crypto';
import { buildExcerpt, type SearchHit, type SearchRequest, tokenize } from './hits.js';
import type { AudiencePredicate, KnowledgeScope } from './ir.js';
import { knowledgeScopeKey } from './ir.js';
import {
  KnowledgeError,
  type KnowledgeIndex,
  type KnowledgeRevision,
  type StagedDocument,
} from './ports.js';
import { revisionContentHash } from './revision-store.js';

interface IndexedDocument {
  readonly descriptor: StagedDocument['descriptor'];
  readonly terms: readonly string[];
  readonly termFrequencies: ReadonlyMap<string, number>;
  readonly length: number;
}

interface Bm25Entry {
  readonly revision: KnowledgeRevision;
  readonly documents: readonly IndexedDocument[];
  readonly documentFrequencies: ReadonlyMap<string, number>;
  readonly averageLength: number;
  state: 'staged' | 'active' | 'retired';
  pins: Set<string>;
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;

export class Bm25KnowledgeIndex implements KnowledgeIndex {
  private readonly entries = new Map<string, Bm25Entry>();

  async stage(
    scope: KnowledgeScope,
    componentName: string,
    documents: readonly StagedDocument[],
  ): Promise<KnowledgeRevision> {
    // Scope + component are part of the identity: two components (or tenants) carrying the
    // same document set must not share a revision id, or their store records collide. Metadata
    // is part of the identity too — see revisionContentHash.
    const hash = createHash('sha256')
      .update(knowledgeScopeKey(scope, componentName))
      .update('\n')
      .update(revisionContentHash(documents.map((document) => document.descriptor)))
      .digest('hex');
    const revisionId = `bm25-rev-${hash.slice(0, 16)}`;
    const indexed = documents.map((document) => {
      const terms = tokenize(document.text);
      const termFrequencies = new Map<string, number>();
      for (const term of terms) termFrequencies.set(term, (termFrequencies.get(term) ?? 0) + 1);
      return { descriptor: document.descriptor, terms, termFrequencies, length: terms.length };
    });
    const documentFrequencies = new Map<string, number>();
    for (const document of indexed) {
      for (const term of new Set(document.terms)) {
        documentFrequencies.set(term, (documentFrequencies.get(term) ?? 0) + 1);
      }
    }
    const averageLength =
      indexed.length === 0
        ? 0
        : indexed.reduce((total, document) => total + document.length, 0) / indexed.length;

    this.entries.set(revisionId, {
      revision: {
        revisionId,
        scope,
        componentName,
        documents: documents.map((document) => document.descriptor),
      },
      documents: indexed,
      documentFrequencies,
      averageLength,
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
      throw new KnowledgeError('predicate', 'the bundled index serves a public audience only');
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

    const queryTerms = [...new Set(tokenize(request.query))];
    const totalDocuments = entry.documents.length;
    const hits = entry.documents
      .map((document) => ({
        document,
        score: queryTerms.reduce((total, term) => {
          const frequency = document.termFrequencies.get(term) ?? 0;
          if (frequency === 0) return total;
          const documentFrequency = entry.documentFrequencies.get(term) ?? 0;
          const idf = Math.log(
            1 + (totalDocuments - documentFrequency + 0.5) / (documentFrequency + 0.5),
          );
          const denominator = document.length === 0 ? 1 : document.length;
          const normalization =
            1 - BM25_B + BM25_B * (document.length / (entry.averageLength || denominator));
          return (
            total + (idf * (frequency * (BM25_K1 + 1))) / (frequency + BM25_K1 * normalization)
          );
        }, 0),
      }))
      .filter((candidate) => candidate.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score || a.document.descriptor.path.localeCompare(b.document.descriptor.path),
      )
      .slice(0, request.limit)
      .map(({ document }) => ({
        id: `doc:${document.descriptor.sha256.slice(0, 16)}`,
        title: document.descriptor.title,
        excerpt: buildExcerpt(document.terms.join(' '), request.query),
        sourceKind: 'document' as const,
        ...(document.descriptor.sourceUrl !== undefined
          ? { uri: document.descriptor.sourceUrl }
          : {}),
      }));
    return hits satisfies SearchHit[];
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

  private require(revisionId: string): Bm25Entry {
    const entry = this.entries.get(revisionId);
    if (entry === undefined)
      throw new KnowledgeError('not-found', `unknown revision ${revisionId}`);
    return entry;
  }
}
