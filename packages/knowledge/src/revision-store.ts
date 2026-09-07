/**
 * Deploy-coupled knowledge revision store (ADR 0202 publication transaction): staged/active
 * state, content-hash reuse, publication leases, positive-predicate verification, atomic
 * artifact+revision activation, deployment pins, rollback pairing, retention, and GC.
 *
 * The store owns *coordination*; the `KnowledgeIndex` port owns provider bytes. A deployment
 * stages through the port, records the revision here, verifies, then activates both as one
 * transaction; failure retains the previous pair.
 */
import { createHash } from 'node:crypto';
import type { KnowledgeScope } from './ir.js';
import { knowledgeScopeKey } from './ir.js';
import type { KnowledgeRevision, StagedDocument } from './ports.js';
import { KnowledgeError } from './ports.js';

/**
 * Seals document text at rest and opens it for BM25 rebuilds (ADR 0202 D5 as amended: the
 * managed-bundled tier persists revision text sealed in the revision store so a stateless
 * instance can rebuild the active index). The service injects its secret-box codec; tests
 * and non-durable stores may use the identity codec.
 */
export interface DocumentTextCodec {
  seal(plaintext: Buffer): Buffer | Promise<Buffer>;
  open(sealed: Buffer): Buffer | Promise<Buffer>;
}

export const identityDocumentTextCodec: DocumentTextCodec = {
  seal: (plaintext) => plaintext,
  open: (sealed) => sealed,
};

export interface StageRevisionInput {
  readonly scope: KnowledgeScope;
  readonly componentName: string;
  /** Content hash of the complete document set — equal sets reuse the same revision. */
  readonly contentHash: string;
  readonly revision: KnowledgeRevision;
}

export interface LeaseTicket {
  readonly scopeKey: string;
  readonly leaseId: string;
}

export interface RevisionRecord {
  readonly revision: KnowledgeRevision;
  readonly contentHash: string;
  readonly state: 'staged' | 'active' | 'retired';
  /** Deployment ids that pin this revision against GC. */
  readonly pins: ReadonlySet<string>;
  readonly stagedAt: number;
}

/** Internal mutable shape; the public record is a defensive copy. */
interface MutableRecord {
  revision: KnowledgeRevision;
  contentHash: string;
  state: 'staged' | 'active' | 'retired';
  pins: Set<string>;
  stagedAt: number;
}

export interface KnowledgeRevisionStore {
  /** Record a staged revision. Re-staging the same contentHash for the scope is idempotent. */
  stage(input: StageRevisionInput): Promise<KnowledgeRevision>;
  /** Serialize publication per component/scope; resolves when the lease is held. */
  acquireLease(scope: KnowledgeScope, componentName: string, holder: string): Promise<LeaseTicket>;
  releaseLease(ticket: LeaseTicket): Promise<void>;
  /** Atomically pair artifact activation with the revision: verify, then flip both. */
  activate(
    scope: KnowledgeScope,
    componentName: string,
    revisionId: string,
    deploymentId: string,
  ): Promise<void>;
  /** Mark a deployment as pinning the revision it activated. */
  pin(revisionId: string, deploymentId: string): Promise<void>;
  /**
   * Release one deployment's pin on a revision, letting a retired revision reach GC. The
   * refresh-lifecycle (site corpus) uses this to unpin the displaced revision after activating
   * its successor; unknown revisions and absent pins are no-ops.
   */
  unpin(revisionId: string, deploymentId: string): Promise<void>;
  /** Rollback reselects every revision the target deployment pinned (one per component). */
  rollback(deploymentId: string): Promise<readonly KnowledgeRevision[]>;
  /** Remove revisions that are neither active nor pinned. Returns the removed count. */
  collectGarbage(): Promise<number>;
  /** Active revision for a scope/component, if any. */
  active(scope: KnowledgeScope, componentName: string): Promise<KnowledgeRevision | undefined>;
  /** A specific revision by id (diagnostics/status only). */
  record(revisionId: string): Promise<RevisionRecord | undefined>;
  /** The staged/active revision holding exactly this content set, for idempotent reuse. */
  findByContentHash(
    scope: KnowledgeScope,
    componentName: string,
    contentHash: string,
  ): Promise<KnowledgeRevision | undefined>;
  /** Delete a revision record; refuses an active or pinned one. */
  delete(revisionId: string): Promise<void>;
  /**
   * Persist the revision's sealed document text so any instance can rebuild the bundled
   * index (ADR 0202 D5 as amended). Idempotent full replacement per revision.
   */
  stageDocuments(revisionId: string, documents: readonly StagedDocument[]): Promise<void>;
  /**
   * The staged text for a revision. Throws `KnowledgeError` when the revision is unknown or
   * its text was never staged — a rebuild must fail loudly, never index an empty corpus.
   */
  documents(revisionId: string): Promise<readonly StagedDocument[]>;
}

/**
 * Revision identity: the byte hashes plus every metadata field a citation shows (path, title,
 * source URL). Bytes alone are not identity — a metadata-only deploy must stage a new revision,
 * or content-hash reuse pins the deployment to stale titles and rollback restores the wrong
 * ones. JSON-encoded per document so authored strings cannot collide with the delimiter.
 */
export function revisionContentHash(
  documents: readonly {
    readonly sha256: string;
    readonly path: string;
    readonly title: string;
    readonly sourceUrl?: string | undefined;
  }[],
): string {
  return createHash('sha256')
    .update(
      documents
        .map((document) =>
          JSON.stringify([
            document.sha256,
            document.path,
            document.title,
            document.sourceUrl ?? null,
          ]),
        )
        .join('\n'),
    )
    .digest('hex');
}

const LEASE_TIMEOUT_MS = 60_000;

export class InMemoryKnowledgeRevisionStore implements KnowledgeRevisionStore {
  private readonly records = new Map<string, MutableRecord>();
  private readonly leases = new Map<string, { holder: string; acquiredAt: number }>();
  private readonly deploymentPins = new Map<string, Set<string>>();
  /** revisionId → path → sealed text; sealed even in memory so the codec path is exercised. */
  private readonly sealedText = new Map<string, Map<string, Buffer>>();
  private readonly codec: DocumentTextCodec;

  constructor(codec: DocumentTextCodec = identityDocumentTextCodec) {
    this.codec = codec;
  }

  async stage(input: StageRevisionInput): Promise<KnowledgeRevision> {
    const scopeKey = knowledgeScopeKey(input.scope, input.componentName);
    const existing = [...this.records.values()].find(
      (record) =>
        knowledgeScopeKey(record.revision.scope, record.revision.componentName) === scopeKey &&
        record.contentHash === input.contentHash,
    );
    if (existing !== undefined) return existing.revision;

    const record: MutableRecord = {
      revision: input.revision,
      contentHash: input.contentHash,
      state: 'staged',
      pins: new Set<string>(),
      stagedAt: Date.now(),
    };
    this.records.set(input.revision.revisionId, record);
    return input.revision;
  }

  async acquireLease(
    scope: KnowledgeScope,
    componentName: string,
    holder: string,
  ): Promise<LeaseTicket> {
    const scopeKey = knowledgeScopeKey(scope, componentName);
    for (;;) {
      const existing = this.leases.get(scopeKey);
      const now = Date.now();
      if (existing === undefined || now - existing.acquiredAt > LEASE_TIMEOUT_MS) {
        this.leases.set(scopeKey, { holder, acquiredAt: now });
        return { scopeKey, leaseId: `${scopeKey}:${now}:${holder}` };
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  async releaseLease(ticket: LeaseTicket): Promise<void> {
    this.leases.delete(ticket.scopeKey);
  }

  async activate(
    scope: KnowledgeScope,
    componentName: string,
    revisionId: string,
    deploymentId: string,
  ): Promise<void> {
    const record = this.records.get(revisionId);
    if (record === undefined) {
      throw new KnowledgeError('not-found', `revision ${revisionId} is not staged`);
    }
    const scopeKey = knowledgeScopeKey(scope, componentName);
    const currentActive = [...this.records.values()].find(
      (candidate) =>
        candidate.state === 'active' &&
        knowledgeScopeKey(candidate.revision.scope, candidate.revision.componentName) === scopeKey,
    );
    if (currentActive !== undefined && currentActive.revision.revisionId !== revisionId) {
      currentActive.state = 'retired';
    }
    record.state = 'active';
    record.pins.add(deploymentId);
    this.pinRevision(deploymentId, revisionId);
  }

  async pin(revisionId: string, deploymentId: string): Promise<void> {
    const record = this.records.get(revisionId);
    if (record === undefined)
      throw new KnowledgeError('not-found', `revision ${revisionId} is not staged`);
    record.pins.add(deploymentId);
    this.pinRevision(deploymentId, revisionId);
  }

  private pinRevision(deploymentId: string, revisionId: string): void {
    const pins = this.deploymentPins.get(deploymentId) ?? new Set<string>();
    pins.add(revisionId);
    this.deploymentPins.set(deploymentId, pins);
  }

  async unpin(revisionId: string, deploymentId: string): Promise<void> {
    this.records.get(revisionId)?.pins.delete(deploymentId);
    this.deploymentPins.get(deploymentId)?.delete(revisionId);
  }

  async rollback(deploymentId: string): Promise<readonly KnowledgeRevision[]> {
    const revisionIds = this.deploymentPins.get(deploymentId);
    if (revisionIds === undefined) return [];
    const restored: KnowledgeRevision[] = [];
    for (const revisionId of revisionIds) {
      const record = this.records.get(revisionId);
      if (record === undefined) continue;
      const scopeKey = knowledgeScopeKey(record.revision.scope, record.revision.componentName);
      for (const candidate of this.records.values()) {
        if (
          candidate.state === 'active' &&
          knowledgeScopeKey(candidate.revision.scope, candidate.revision.componentName) ===
            scopeKey &&
          candidate.revision.revisionId !== revisionId
        ) {
          candidate.state = 'retired';
        }
      }
      record.state = 'active';
      restored.push(record.revision);
    }
    return restored;
  }

  async collectGarbage(): Promise<number> {
    let removed = 0;
    for (const [revisionId, record] of this.records) {
      if (record.state !== 'active' && record.pins.size === 0) {
        this.records.delete(revisionId);
        this.sealedText.delete(revisionId);
        removed += 1;
      }
    }
    return removed;
  }

  async active(
    scope: KnowledgeScope,
    componentName: string,
  ): Promise<KnowledgeRevision | undefined> {
    const scopeKey = knowledgeScopeKey(scope, componentName);
    const record = [...this.records.values()].find(
      (candidate) =>
        candidate.state === 'active' &&
        knowledgeScopeKey(candidate.revision.scope, candidate.revision.componentName) === scopeKey,
    );
    return record?.revision;
  }

  async record(revisionId: string): Promise<RevisionRecord | undefined> {
    const record: MutableRecord | undefined = this.records.get(revisionId);
    if (record === undefined) return undefined;
    return { ...record, pins: new Set(record.pins) };
  }

  async delete(revisionId: string): Promise<void> {
    const record = this.records.get(revisionId);
    if (record === undefined) return;
    if (record.state === 'active') {
      throw new KnowledgeError('store', 'cannot delete the active revision');
    }
    if (record.pins.size > 0) {
      throw new KnowledgeError('store', 'cannot delete a deployment-pinned revision');
    }
    this.records.delete(revisionId);
    this.sealedText.delete(revisionId);
  }

  async findByContentHash(
    scope: KnowledgeScope,
    componentName: string,
    contentHash: string,
  ): Promise<KnowledgeRevision | undefined> {
    const scopeKey = knowledgeScopeKey(scope, componentName);
    const record = [...this.records.values()].find(
      (candidate) =>
        candidate.contentHash === contentHash &&
        knowledgeScopeKey(candidate.revision.scope, candidate.revision.componentName) === scopeKey,
    );
    return record?.revision;
  }

  async stageDocuments(revisionId: string, documents: readonly StagedDocument[]): Promise<void> {
    if (!this.records.has(revisionId)) {
      throw new KnowledgeError('not-found', `revision ${revisionId} is not staged`);
    }
    const sealed = new Map<string, Buffer>();
    for (const document of documents) {
      sealed.set(
        document.descriptor.path,
        await this.codec.seal(Buffer.from(document.text, 'utf8')),
      );
    }
    this.sealedText.set(revisionId, sealed);
  }

  async documents(revisionId: string): Promise<readonly StagedDocument[]> {
    const record = this.records.get(revisionId);
    if (record === undefined) {
      throw new KnowledgeError('not-found', `revision ${revisionId} is not staged`);
    }
    const sealed = this.sealedText.get(revisionId);
    if (sealed === undefined && record.revision.documents.length > 0) {
      throw new KnowledgeError('store', `revision ${revisionId} has no staged document text`);
    }
    const documents: StagedDocument[] = [];
    for (const descriptor of record.revision.documents) {
      const ciphertext = sealed?.get(descriptor.path);
      if (ciphertext === undefined) {
        throw new KnowledgeError(
          'store',
          `revision ${revisionId} is missing text for ${descriptor.path}`,
        );
      }
      documents.push({ descriptor, text: (await this.codec.open(ciphertext)).toString('utf8') });
    }
    return documents;
  }
}
