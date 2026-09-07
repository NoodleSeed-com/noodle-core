/**
 * Shared mechanics for BYO index adapters (ADR 0202 amendment 2026-08-18): deterministic
 * per-tenant index naming, revision identity, and the in-instance activation map that expresses
 * atomic replacement through the revision filter — one adapter instance per tenant scope.
 */
import { createHash } from 'node:crypto';
import type { KnowledgeScope } from './ir.js';
import { knowledgeScopeKey } from './ir.js';
import { KnowledgeError, type StagedDocument } from './ports.js';
import { revisionContentHash } from './revision-store.js';

export function assertProviderScope(scope: KnowledgeScope, bound: KnowledgeScope): void {
  if (knowledgeScopeKey(scope, '') !== knowledgeScopeKey(bound, '')) {
    throw new KnowledgeError('request', 'this index instance is bound to a different tenant scope');
  }
}

/** Provider-safe index uid: tenant tag + component, `[a-z0-9-]` only (Meilisearch's alphabet). */
export function providerIndexUid(scope: KnowledgeScope, componentName: string): string {
  const tag = createHash('sha256').update(knowledgeScopeKey(scope, '')).digest('hex').slice(0, 24);
  const component = componentName.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  return `ns-${tag}-${component}`;
}

export function providerRevisionId(
  prefix: string,
  scope: KnowledgeScope,
  componentName: string,
  documents: readonly StagedDocument[],
): string {
  const hash = createHash('sha256')
    .update(knowledgeScopeKey(scope, componentName))
    .update('\n')
    .update(revisionContentHash(documents.map((document) => document.descriptor)))
    .digest('hex');
  return `${prefix}-${hash.slice(0, 24)}`;
}

/** The stored document shape both adapters index: our fields plus the filterable metadata. */
export interface ProviderDocumentRecord {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly text: string;
  readonly sourceUrl?: string;
  readonly revision: string;
  readonly audience: 'public';
  readonly tenant: string;
}

export function providerDocuments(
  scope: KnowledgeScope,
  revisionId: string,
  documents: readonly StagedDocument[],
): ProviderDocumentRecord[] {
  const tenant = createHash('sha256')
    .update(knowledgeScopeKey(scope, ''))
    .digest('hex')
    .slice(0, 24);
  return documents.map((document) => ({
    id: `${revisionId}-${document.descriptor.sha256.slice(0, 16)}`,
    path: document.descriptor.path,
    title: document.descriptor.title,
    text: document.text,
    ...(document.descriptor.sourceUrl === undefined
      ? {}
      : { sourceUrl: document.descriptor.sourceUrl }),
    revision: revisionId,
    audience: 'public',
    tenant,
  }));
}
