/**
 * Provider-neutral knowledge ports (ADR 0202). A fake and a production implementation pass
 * the same conformance suites; provider names, scores, and answers never cross these seams.
 */

import type { SearchHit, SearchRequest } from './hits.js';
import type { AudiencePredicate, DocumentDescriptor, KnowledgeScope, SitePolicy } from './ir.js';

/** Which provider layer failed, so operators see the accountable surface, never content. */
export type KnowledgeErrorLayer = 'request' | 'predicate' | 'provider' | 'store' | 'not-found';

export class KnowledgeError extends Error {
  readonly layer: KnowledgeErrorLayer;

  constructor(layer: KnowledgeErrorLayer, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'KnowledgeError';
    this.layer = layer;
  }
}

/** One staged document: its compiled descriptor plus the UTF-8 content the provider will index. */
export interface StagedDocument {
  readonly descriptor: DocumentDescriptor;
  readonly text: string;
}

export interface KnowledgeRevision {
  /** Opaque provider/adapter-local revision identifier pinned by the deploy record. */
  readonly revisionId: string;
  readonly scope: KnowledgeScope;
  readonly componentName: string;
  readonly documents: readonly DocumentDescriptor[];
}

/**
 * Publishes and queries deployment-versioned text documents. Implementations must:
 * stage complete revisions, verify a positive typed-predicate query before activation,
 * activate atomically, and delete only unreferenced revisions.
 */
export interface KnowledgeIndex {
  /** Stage a complete replacement revision and return its identifier. Idempotent on content hash. */
  stage(
    scope: KnowledgeScope,
    componentName: string,
    documents: readonly StagedDocument[],
  ): Promise<KnowledgeRevision>;
  /**
   * Prove the staged revision answers a positive filtered query for the given predicate —
   * the launch gate that catches a knowledge base that silently returns nothing.
   */
  verify(revisionId: string, predicate: AudiencePredicate): Promise<boolean>;
  /** Make the staged revision the one searches read. Fails if not staged. */
  activate(revisionId: string): Promise<void>;
  /** Query the active revision for the scope/component. */
  search(
    scope: KnowledgeScope,
    componentName: string,
    request: SearchRequest,
  ): Promise<readonly SearchHit[]>;
  /** Delete only a revision no activation or deployment pin references. */
  delete(revisionId: string): Promise<void>;
  /** The revision searches currently read, if one is active. */
  activeRevision(
    scope: KnowledgeScope,
    componentName: string,
  ): Promise<KnowledgeRevision | undefined>;
}

/**
 * Queries provider-managed live public websites. The mandatory predicate must carry
 * `audience: public`; results are exact-origin/path-approved only.
 */
export interface SiteSearch {
  search(
    policy: SitePolicy,
    predicate: AudiencePredicate,
    request: SearchRequest,
  ): Promise<readonly SearchHit[]>;
}
