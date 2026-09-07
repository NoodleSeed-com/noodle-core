/**
 * BYO Meilisearch index adapter (ADR 0202 amendment 2026-08-18): the customer's own Meilisearch
 * (Cloud or self-hosted — one REST surface covers both) holds the component's corpus.
 * REST-only against the documented v1 surface — `PATCH /indexes/{uid}/settings`
 * (filterableAttributes), async document writes via `POST /indexes/{uid}/documents` polled
 * through `GET /tasks/{taskUid}` until `succeeded`, search via `POST /indexes/{uid}/search`
 * with a `filter` expression, and `POST /indexes/{uid}/documents/delete` for retired revisions.
 * Atomic replacement is expressed through the `revision` filter; excerpts come from our own
 * stored text, and the API key never appears in an error.
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

export interface MeilisearchIndexOptions {
  /** The customer's Meilisearch base URL (Cloud or self-hosted), no trailing slash. */
  readonly host: string;
  readonly apiKey: string;
  readonly scope: KnowledgeScope;
  readonly fetchImpl?: typeof fetch;
  readonly pollIntervalMs?: number;
  readonly maxPolls?: number;
}

export class MeilisearchKnowledgeIndex implements KnowledgeIndex {
  readonly #options: MeilisearchIndexOptions;
  readonly #fetch: typeof fetch;
  readonly #active = new Map<string, string>();
  readonly #componentOfRevision = new Map<string, string>();
  readonly #probeOfRevision = new Map<string, string>();

  constructor(options: MeilisearchIndexOptions) {
    this.#options = options;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async stage(
    scope: KnowledgeScope,
    componentName: string,
    documents: readonly StagedDocument[],
  ): Promise<KnowledgeRevision> {
    assertProviderScope(scope, this.#options.scope);
    const revisionId = providerRevisionId('ms', scope, componentName, documents);
    const uid = providerIndexUid(scope, componentName);
    await this.#task(
      await this.#call('settings', 'PATCH', `/indexes/${uid}/settings`, {
        filterableAttributes: ['revision', 'audience', 'tenant'],
      }),
    );
    await this.#task(
      await this.#call(
        'documents',
        'POST',
        `/indexes/${uid}/documents?primaryKey=id`,
        providerDocuments(scope, revisionId, documents),
      ),
    );
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
      throw new KnowledgeError(
        'predicate',
        'the Meilisearch adapter serves a public audience only',
      );
    }
    if (predicate.revision !== revisionId) return false;
    const componentName = this.#componentOfRevision.get(revisionId);
    const probe = this.#probeOfRevision.get(revisionId);
    if (componentName === undefined || probe === undefined) return false;
    const uid = providerIndexUid(this.#options.scope, componentName);
    const response = (await this.#call('search', 'POST', `/indexes/${uid}/search`, {
      q: probe,
      filter: `revision = "${revisionId}" AND audience = "public"`,
      limit: 1,
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
    const response = (await this.#call('search', 'POST', `/indexes/${uid}/search`, {
      q: request.query,
      filter: `revision = "${revision}" AND audience = "public"`,
      limit: request.limit,
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
    await this.#task(
      await this.#call('delete', 'POST', `/indexes/${uid}/documents/delete`, {
        filter: `revision = "${revisionId}"`,
      }),
    );
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
      response = await this.#fetch(`${this.#options.host}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.#options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new KnowledgeError('provider', `meilisearch ${operation} request failed`);
    }
    if (!response.ok) {
      throw new KnowledgeError(
        'provider',
        `meilisearch ${operation} returned HTTP ${response.status}`,
      );
    }
    return response.json().catch(() => ({}));
  }

  /** Writes are async tasks: poll `GET /tasks/{taskUid}` until succeeded (or fail attributably). */
  async #task(enqueued: unknown): Promise<void> {
    const taskUid = (enqueued as { taskUid?: number }).taskUid;
    if (taskUid === undefined) return;
    const maxPolls = this.#options.maxPolls ?? 120;
    for (let poll = 0; poll < maxPolls; poll++) {
      const task = (await this.#call('task', 'GET', `/tasks/${taskUid}`, undefined)) as {
        status?: string;
      };
      if (task.status === 'succeeded') return;
      if (task.status === 'failed' || task.status === 'canceled') {
        throw new KnowledgeError('provider', `meilisearch task ended ${task.status}`);
      }
      const interval = this.#options.pollIntervalMs ?? 250;
      if (interval > 0) await new Promise((resolve) => setTimeout(resolve, interval));
    }
    throw new KnowledgeError(
      'provider',
      'meilisearch task did not complete within the poll budget',
    );
  }
}
