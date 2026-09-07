/**
 * BYO Algolia index adapter (ADR 0202 amendment 2026-08-18): the customer's own Algolia
 * application holds the component's corpus. REST-only against the documented v1 surface —
 * `PUT /1/indexes/{index}/settings` (attributesForFaceting with filterOnly), batched object
 * writes via `POST /1/indexes/{index}/batch`, search via `POST /1/indexes/{index}/query` with a
 * `filters` expression, and `POST /1/indexes/{index}/deleteByQuery` for retired revisions.
 * Atomic replacement is expressed through the `revision` filter, exactly like the bundled index;
 * excerpts are built client-side from our own stored text — provider highlighting never crosses
 * the port, and the API key never appears in an error.
 */
import { buildExcerpt, type SearchHit, type SearchRequest } from './hits.js';
import type { AudiencePredicate, KnowledgeScope } from './ir.js';
import { knowledgeScopeKey } from './ir.js';
import {
  KnowledgeError,
  type KnowledgeIndex,
  type KnowledgeRevision,
  type StagedDocument,
} from './ports.js';
import {
  assertProviderScope,
  type ProviderDocumentRecord,
  providerDocuments,
  providerIndexUid,
  providerRevisionId,
} from './provider-index-shared.js';

export interface AlgoliaIndexOptions {
  readonly appId: string;
  readonly apiKey: string;
  readonly scope: KnowledgeScope;
  readonly fetchImpl?: typeof fetch;
}

export class AlgoliaKnowledgeIndex implements KnowledgeIndex {
  readonly #options: AlgoliaIndexOptions;
  readonly #fetch: typeof fetch;
  readonly #active = new Map<string, string>();
  readonly #componentOfRevision = new Map<string, string>();
  readonly #probeOfRevision = new Map<string, string>();

  constructor(options: AlgoliaIndexOptions) {
    this.#options = options;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async stage(
    scope: KnowledgeScope,
    componentName: string,
    documents: readonly StagedDocument[],
  ): Promise<KnowledgeRevision> {
    assertProviderScope(scope, this.#options.scope);
    const revisionId = providerRevisionId('alg', scope, componentName, documents);
    const uid = providerIndexUid(scope, componentName);
    await this.#call('settings', 'PUT', `/1/indexes/${uid}/settings`, {
      attributesForFaceting: ['filterOnly(revision)', 'filterOnly(audience)', 'filterOnly(tenant)'],
    });
    const records = providerDocuments(scope, revisionId, documents);
    await this.#call('batch', 'POST', `/1/indexes/${uid}/batch`, {
      requests: records.map((record) => ({
        action: 'addObject',
        body: { ...record, objectID: record.id },
      })),
    });
    this.#componentOfRevision.set(revisionId, componentName);
    const probe = documents
      .flatMap((document) => document.text.split(/\s+/))
      .find((word) => word.length >= 4);
    if (probe !== undefined) this.#probeOfRevision.set(revisionId, probe);
    return {
      revisionId,
      scope,
      componentName,
      documents: documents.map((document) => document.descriptor),
    };
  }

  async verify(revisionId: string, predicate: AudiencePredicate): Promise<boolean> {
    if (predicate.audience !== 'public') {
      throw new KnowledgeError('predicate', 'the Algolia adapter serves a public audience only');
    }
    if (predicate.revision !== revisionId) return false;
    const componentName = this.#componentOfRevision.get(revisionId);
    const probe = this.#probeOfRevision.get(revisionId);
    if (componentName === undefined || probe === undefined) return false;
    const uid = providerIndexUid(this.#options.scope, componentName);
    const response = (await this.#call('query', 'POST', `/1/indexes/${uid}/query`, {
      query: probe,
      filters: `revision:${revisionId} AND audience:public`,
      hitsPerPage: 1,
    })) as { hits?: readonly unknown[] };
    return Array.isArray(response.hits) && response.hits.length > 0;
  }

  async activate(revisionId: string): Promise<void> {
    const componentName = this.#componentOfRevision.get(revisionId);
    if (componentName === undefined) {
      throw new KnowledgeError('not-found', `revision ${revisionId} is not staged`);
    }
    this.#active.set(knowledgeScopeKey(this.#options.scope, componentName), revisionId);
  }

  async search(
    scope: KnowledgeScope,
    componentName: string,
    request: SearchRequest,
  ): Promise<readonly SearchHit[]> {
    assertProviderScope(scope, this.#options.scope);
    const revision = this.#active.get(knowledgeScopeKey(scope, componentName));
    if (revision === undefined) {
      throw new KnowledgeError('not-found', 'no active revision for this component');
    }
    const uid = providerIndexUid(scope, componentName);
    const response = (await this.#call('query', 'POST', `/1/indexes/${uid}/query`, {
      query: request.query,
      filters: `revision:${revision} AND audience:public`,
      hitsPerPage: request.limit,
    })) as { hits?: readonly Partial<ProviderDocumentRecord>[] };
    return (response.hits ?? []).slice(0, request.limit).map((hit) => ({
      id: `doc:${hit.id ?? hit.path ?? 'unknown'}`,
      title: hit.title ?? hit.path ?? 'Result',
      excerpt: buildExcerpt(hit.text ?? '', request.query),
      sourceKind: 'document' as const,
      ...(hit.sourceUrl?.startsWith('https://') ? { uri: hit.sourceUrl } : {}),
    }));
  }

  async delete(revisionId: string): Promise<void> {
    const componentName = this.#componentOfRevision.get(revisionId);
    if (componentName === undefined) return;
    const active = this.#active.get(knowledgeScopeKey(this.#options.scope, componentName));
    if (active === revisionId) {
      throw new KnowledgeError('request', 'refusing to delete the active revision');
    }
    const uid = providerIndexUid(this.#options.scope, componentName);
    await this.#call('deleteByQuery', 'POST', `/1/indexes/${uid}/deleteByQuery`, {
      filters: `revision:${revisionId}`,
    });
    this.#componentOfRevision.delete(revisionId);
    this.#probeOfRevision.delete(revisionId);
  }

  async activeRevision(
    scope: KnowledgeScope,
    componentName: string,
  ): Promise<KnowledgeRevision | undefined> {
    assertProviderScope(scope, this.#options.scope);
    const revision = this.#active.get(knowledgeScopeKey(scope, componentName));
    if (revision === undefined) return undefined;
    return { revisionId: revision, scope, componentName, documents: [] };
  }

  async #call(operation: string, method: string, path: string, body: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(`https://${this.#options.appId}-dsn.algolia.net${path}`, {
        method,
        headers: {
          'x-algolia-application-id': this.#options.appId,
          'x-algolia-api-key': this.#options.apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new KnowledgeError('provider', `algolia ${operation} request failed`);
    }
    if (!response.ok) {
      throw new KnowledgeError('provider', `algolia ${operation} returned HTTP ${response.status}`);
    }
    return response.json().catch(() => ({}));
  }
}
