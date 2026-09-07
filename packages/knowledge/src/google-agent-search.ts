/**
 * Google Agent Search adapter (ADR 0202 as amended): both knowledge ports over the Discovery Engine
 * v1 REST surface, in the **Noodle-owned** managed project.
 *
 * Design constraints, enforced by tests:
 * - **REST-only.** No `@google-cloud/*` dependency — Apache-licensed packages may not depend on the
 *   commercial vendor SDKs (ADR 0203 license gate); plain `fetch` against the documented v1 surface.
 * - **No credentials in the adapter.** A `GoogleAccessTokenProvider` supplies short-lived bearer
 *   tokens; the credential broker owns the service accounts (three least-privilege identities:
 *   provisioning, publication, search) — never this file.
 * - **Tenant + revision + audience metadata everywhere.** Every imported document carries `tenant`,
 *   `revision`, and `audience=public` struct metadata; every search filters on tenant + revision +
 *   audience, so a silently-empty index cannot answer confidently from a subset.
 * - **Provider concepts stop here.** Resource names, snippets, and scores never cross the port
 *   boundary; hits leave as bounded, citable `SearchHit`s.
 *
 * API facts verified against official docs 2026-08-15 and live against the Noodle-owned project
 * 2026-08-17 (canary): inline imports nest under `inlineSource` and are INCREMENTAL-only
 * (full replacement is expressed by the revision filter, not the import mode); `structData`
 * and `jsonData` are a oneof, so searchable text ships inside structData. Data stores under
 * `projects/{p}/locations/{l}/collections/default_collection/dataStores`, document import via
 * `.../branches/default_branch/documents:import`, search via
 * `.../servingConfigs/default_serving_config:search`; OAuth scope `cloud-platform` or
 * `discoveryengine.*`. Re-verify before changing protocol-sensitive shapes and record drift.
 *
 * Website (site search) facts re-verified against official docs 2026-08-17: **basic website
 * search accepts only predefined filter fields** (`cr`, `highRange`, `lowRange`, `fileType`,
 * `lr`, `rights`, `siteSearch`) — custom metadata filters (tenant/audience) require advanced
 * website indexing plus page-level metadata the crawler never has, so site search sends **no
 * filter**: tenant isolation is the per-tenant WEBSITE datastore itself and origin/path policy
 * is the client-side postfilter. Website results arrive under
 * `results[].document.derivedStructData` (`link`, `title`, `snippets[].snippet` with
 * `snippet_status`), not as top-level `documentUri`/`snippet`.
 */
import { createHash } from 'node:crypto';
import { buildExcerpt, type SearchHit, type SearchRequest } from './hits.js';
import type { AudiencePredicate, KnowledgeScope } from './ir.js';
import { knowledgeScopeKey } from './ir.js';
import {
  KnowledgeError,
  type KnowledgeIndex,
  type KnowledgeRevision,
  type StagedDocument,
} from './ports.js';
import { revisionContentHash } from './revision-store.js';

/** Supplies short-lived bearer tokens. The broker implements this; tests inject a fixed token. */
export type GoogleAccessTokenProvider = () => Promise<string>;

/** Minimal fetch-shaped transport so unit tests run against scripted responses, never network. */
export type GoogleTransport = (
  url: string,
  init: {
    readonly method: 'POST' | 'GET' | 'DELETE';
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
  },
) => Promise<{ status: number; json(): Promise<unknown> }>;

const API_ROOT = 'https://discoveryengine.googleapis.com/v1';
const MAX_IMPORT_DOCUMENTS_PER_REQUEST = 100;

export interface GoogleAgentSearchOptions {
  /** Noodle-owned GCP project id (managed v0; BYO project arrives with the deferred tier). */
  readonly project: string;
  readonly location: string;
  readonly tokenProvider: GoogleAccessTokenProvider;
  readonly transport?: GoogleTransport;
  /** Escape hatch for tests/ops to point at a stub endpoint. */
  readonly apiRoot?: string;
  /**
   * Tenant scope this instance serves. One adapter instance per tenant: the service binds it at
   * request time from the deployment's identity, and site search needs it to target the tenant's
   * website data store.
   */
  readonly scope: KnowledgeScope;
}

interface GoogleDocument {
  readonly id: string;
  readonly structData?: Readonly<Record<string, string>>;
}

function dataStoreName(options: GoogleAgentSearchOptions, componentName: string): string {
  return `projects/${options.project}/locations/${options.location}/collections/default_collection/dataStores/${googleDataStoreId(options.scope, componentName)}`;
}

/** Deterministic managed datastore id for a tenant scope + component (site half uses `site`). */
export function googleDataStoreId(scope: KnowledgeScope, componentName: string): string {
  return `ns-${tenantTag(scope)}-${componentName}`.toLowerCase();
}

/** The reserved component name of a tenant's live-site WEBSITE data store. */
export const GOOGLE_SITE_COMPONENT = 'site';

function tenantTag(scope: KnowledgeScope): string {
  return createHash('sha256').update(knowledgeScopeKey(scope, '')).digest('hex').slice(0, 24);
}

function assertScope(actual: KnowledgeScope, bound: KnowledgeScope): void {
  if (actual.org !== bound.org || actual.app !== bound.app || actual.env !== bound.env) {
    throw new KnowledgeError('predicate', 'adapter instance is bound to a different tenant scope');
  }
}

async function callGoogle(
  options: GoogleAgentSearchOptions,
  path: string,
  body: unknown,
): Promise<unknown> {
  const root = options.apiRoot ?? API_ROOT;
  const token = await options.tokenProvider();
  const transport: GoogleTransport =
    options.transport ??
    (async (url, init) => {
      const response = await fetch(url, init as RequestInit);
      return { status: response.status, json: () => response.json() };
    });
  let response: Awaited<ReturnType<GoogleTransport>>;
  try {
    response = await transport(`${root}/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (cause) {
    throw new KnowledgeError('provider', 'google agent search request failed', { cause });
  }
  if (response.status < 200 || response.status >= 300) {
    // Attributable without content: the operation and status only; provider bodies never propagate.
    const operation = path.split('?')[0]?.split('/').pop() ?? path;
    throw new KnowledgeError(
      'provider',
      `google agent search ${operation} returned HTTP ${response.status}`,
    );
  }
  return response.json();
}

export class GoogleAgentSearchAdapter implements KnowledgeIndex {
  readonly #options: GoogleAgentSearchOptions;
  /** scopeKey → serving revisionId, and revisionId → scopeKey for the activate() pointer flip. */
  readonly #active = new Map<string, string>();
  readonly #scopeOfRevision = new Map<string, string>();
  readonly #componentOfRevision = new Map<string, string>();
  readonly #probeOfRevision = new Map<string, string>();

  constructor(options: GoogleAgentSearchOptions) {
    this.#options = options;
  }

  private dataStoreName(componentName: string): string {
    return dataStoreName(this.#options, componentName);
  }

  private async call(path: string, body: unknown): Promise<unknown> {
    return callGoogle(this.#options, path, body);
  }

  async stage(
    scope: KnowledgeScope,
    componentName: string,
    documents: readonly StagedDocument[],
  ): Promise<KnowledgeRevision> {
    assertScope(scope, this.#options.scope);
    // Scope + component prefix for the same reason as the bundled index: two tenants (or
    // components) carrying identical documents must not share a revision id, or their store
    // records collide. Metadata is part of the identity — see revisionContentHash.
    const contentHash = createHash('sha256')
      .update(knowledgeScopeKey(scope, componentName))
      .update('\n')
      .update(revisionContentHash(documents.map((document) => document.descriptor)))
      .digest('hex');
    const revisionId = `g-${contentHash.slice(0, 24)}`;
    const tenant = tenantTag(scope);
    // `structData` and `jsonData` are a oneof (live-verified 2026-08-17); the text ships inside
    // structData so filter metadata and searchable content travel in the one allowed field.
    const googleDocuments: GoogleDocument[] = documents.map((document) => ({
      id: document.descriptor.sha256.slice(0, 32),
      structData: {
        tenant,
        revision: revisionId,
        audience: 'public',
        title: document.descriptor.title,
        text: document.text,
        ...(document.descriptor.sourceUrl !== undefined
          ? { uri: document.descriptor.sourceUrl }
          : {}),
      },
    }));
    for (let index = 0; index < googleDocuments.length; index += MAX_IMPORT_DOCUMENTS_PER_REQUEST) {
      const batch = googleDocuments.slice(index, index + MAX_IMPORT_DOCUMENTS_PER_REQUEST);
      await this.call(
        `${this.dataStoreName(componentName)}/branches/default_branch/documents:import`,
        {
          // Verified live 2026-08-17 (canary): inline documents nest under `inlineSource`, and
          // inline imports reject reconciliationMode FULL (GCS/BigQuery sources only). Correct
          // full-replacement semantics come from the revision filter instead: every search pins
          // `revision: ANY(<active>)`, so documents absent from the next revision are invisible
          // the moment it activates; stale-revision rows are storage, not truth, and GC can purge
          // them later.
          inlineSource: { documents: batch },
          reconciliationMode: 'INCREMENTAL',
        },
      );
    }
    this.#scopeOfRevision.set(revisionId, knowledgeScopeKey(scope, componentName));
    this.#componentOfRevision.set(revisionId, componentName);
    // A verification probe drawn from the staged text itself: the first word long enough to be a
    // real search term. Verify must issue a query that should match, not a wildcard the search
    // API does not document.
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
      throw new KnowledgeError('predicate', 'the managed adapter serves a public audience only');
    }
    if (predicate.revision !== revisionId) return false;
    const componentName = this.#componentOfRevision.get(revisionId);
    const probe = this.#probeOfRevision.get(revisionId);
    if (componentName === undefined || probe === undefined) return false;
    // The positive filtered query is the launch gate: one real search with the revision + public
    // audience filter, before activation. An empty result means the import must not activate —
    // returning true from an argument check alone would let an unsearchable revision go live.
    const response = await this.call(
      `${this.dataStoreName(componentName)}/servingConfigs/default_serving_config:search`,
      {
        query: probe,
        pageSize: 1,
        filter: `revision: ANY("${revisionId}") AND audience: ANY("public")`,
      },
    );
    const results = (response as { results?: unknown }).results;
    return Array.isArray(results) && results.length > 0;
  }

  async activate(revisionId: string): Promise<void> {
    const scopeKey = this.#scopeOfRevision.get(revisionId);
    if (scopeKey === undefined) {
      throw new KnowledgeError('not-found', `revision ${revisionId} is not staged`);
    }
    this.#active.set(scopeKey, revisionId);
  }

  async search(
    scope: KnowledgeScope,
    componentName: string,
    request: SearchRequest,
  ): Promise<readonly SearchHit[]> {
    assertScope(scope, this.#options.scope);
    const scopeKey = knowledgeScopeKey(scope, componentName);
    const revision = this.#active.get(scopeKey);
    if (revision === undefined) {
      throw new KnowledgeError('not-found', 'no active revision for this component');
    }
    const response = await this.call(
      `${this.dataStoreName(componentName)}/servingConfigs/default_serving_config:search`,
      {
        query: request.query,
        pageSize: request.limit,
        filter: `tenant: ANY("${tenantTag(scope)}") AND revision: ANY("${revision}") AND audience: ANY("public")`,
        // Live-verified 2026-08-17: extractiveContentSpec is an enterprise-edition feature and
        // 400s on standard datastores — and provider-generated answers must never cross the
        // port anyway. Excerpts are built client-side from the document's own text.
        contentSearchSpec: { snippetSpec: { returnSnippet: true, maxSnippetCount: 1 } },
      },
    );
    const results = (response as { results?: unknown }).results;
    if (!Array.isArray(results)) return [];
    return results.slice(0, request.limit).map((raw) => this.toDocumentHit(raw, request.query));
  }

  private toDocumentHit(raw: unknown, query: string): SearchHit {
    const result = raw as {
      document?: {
        id?: string;
        structData?: { title?: string; uri?: string; text?: string };
      };
      snippet?: string;
    };
    const struct = result.document?.structData ?? {};
    const title = struct.title ?? result.document?.id ?? 'Result';
    // Structured stores return no usable snippet; the document's own text is the excerpt source.
    const text = struct.text ?? result.snippet ?? '';
    const uri = struct.uri;
    return {
      id: `doc:${result.document?.id ?? createHash('sha256').update(title).digest('hex').slice(0, 16)}`,
      title,
      excerpt: buildExcerpt(text, query),
      sourceKind: 'document',
      ...(uri?.startsWith('https://') ? { uri } : {}),
    };
  }

  async delete(revisionId: string): Promise<void> {
    // Managed v0: replacement semantics come from the revision filter (imports are
    // INCREMENTAL-only), so a deleted revision simply stops being queryable; stale rows are
    // storage the provider-side GC can purge later. Deletion is recorded in the revision store.
    this.#scopeOfRevision.delete(revisionId);
    this.#componentOfRevision.delete(revisionId);
    this.#probeOfRevision.delete(revisionId);
    for (const [scopeKey, revision] of this.#active) {
      if (revision === revisionId) this.#active.delete(scopeKey);
    }
  }

  async activeRevision(
    scope: KnowledgeScope,
    componentName: string,
  ): Promise<KnowledgeRevision | undefined> {
    assertScope(scope, this.#options.scope);
    const revision = this.#active.get(knowledgeScopeKey(scope, componentName));
    if (revision === undefined) return undefined;
    return { revisionId: revision, scope, componentName, documents: [] };
  }
}
