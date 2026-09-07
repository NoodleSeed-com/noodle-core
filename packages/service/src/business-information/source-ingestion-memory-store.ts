import { createHmac } from 'node:crypto';
import type { JsonObject } from './contracts.js';
import { SourceMemoryCapacity } from './source-custody-memory.js';
import type {
  ExternalRecord,
  ExternalRecordListRequest,
  ExternalRecordLookup,
  SourceBindingCreate,
  SourceBindingKey,
  SourceBindingMutationResult,
  SourceBindingRecord,
  SourceIngestionLease,
  SourceIngestionStore,
  SourcePageCommitResult,
  SourceRefreshRequestResult,
  SourceScanPage,
  SourceSuppressionRecord,
} from './source-ingestion-contracts.js';
import { sourceFailureHealth } from './source-ingestion-failures.js';
import {
  bindingFingerprint,
  bindingKey,
  completedBinding,
  due,
  dueOrder,
  externalRecordId,
  externalRecordKey,
  leaseFrom,
  normalizeSuppression,
  ownsLease,
  refreshIdempotencyDigest,
  refreshJobId,
  refreshReceipt,
  refreshRequestKey,
  type StoredRefreshRequest,
  suppressionKey,
  validatePage,
  withoutScanState,
} from './source-ingestion-memory-state.js';
import {
  erasedMemoryExternal,
  type MutableBinding,
  restoreMap,
  type StoredExternalRecord,
} from './source-ingestion-memory-types.js';
import {
  boundedInteger,
  clone,
  jsonDigest,
  requiredCursor,
  requiredScanMode,
  sourceToken,
} from './source-ingestion-memory-values.js';
import {
  decodeExternalRecordCursor,
  encodeExternalRecordCursor,
  externalRecordPageLimit,
} from './source-ingestion-pagination.js';
import {
  normalizeSourceBindingCreate,
  sourceBindingCreateFrom,
} from './source-ingestion-validation.js';
import { pruneMemoryRefreshReceipts, terminalRefresh } from './source-refresh-retention.js';
import { validateManagedPayload, validateScalar } from './validation.js';

export interface InMemorySourceIngestionStoreOptions {
  readonly identityKey: string;
  readonly now?: () => Date;
}

/** Process-local reference implementation for generic source-ingestion conformance. */
export class InMemorySourceIngestionStore implements SourceIngestionStore {
  readonly #bindings = new Map<string, MutableBinding>();
  readonly #records = new Map<string, StoredExternalRecord>();
  readonly #suppressions = new Map<string, SourceSuppressionRecord>();
  readonly #refreshRequests = new Map<string, StoredRefreshRequest>();
  readonly #identityKey: string;
  readonly #now: () => Date;
  #pending: Promise<void> = Promise.resolve();
  readonly #capacity = new SourceMemoryCapacity();

  constructor(options: InMemorySourceIngestionStoreOptions) {
    if (Buffer.byteLength(options.identityKey, 'utf8') < 32) {
      throw new Error('source identity key must contain at least 32 bytes');
    }
    this.#identityKey = options.identityKey;
    this.#now = options.now ?? (() => new Date());
  }

  createBinding(input: SourceBindingCreate): Promise<SourceBindingRecord> {
    return this.#exclusive(() => {
      const normalized = normalizeSourceBindingCreate(input);
      const key = bindingKey(normalized);
      const existing = this.#bindings.get(key)?.record;
      if (existing !== undefined) {
        if (
          bindingFingerprint(sourceBindingCreateFrom(existing)) !== bindingFingerprint(normalized)
        ) {
          throw new Error('source binding already exists with different immutable configuration');
        }
        return clone(existing);
      }
      const timestamp = this.#now().toISOString();
      const record: SourceBindingRecord = {
        ...normalized,
        state: 'active',
        health: 'initializing',
        completeness: 'incomplete',
        revision: 1,
        fence: 0,
        scanGeneration: 0,
        nextAttemptAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      this.#bindings.set(key, { record });
      return clone(record);
    });
  }

  replaceBinding(
    input: SourceBindingCreate & { readonly expectedRevision: number; readonly now: Date },
  ): Promise<SourceBindingMutationResult> {
    return this.#exclusive(() => {
      const normalized = normalizeSourceBindingCreate(input);
      const key = bindingKey(normalized);
      const current = this.#bindings.get(key)?.record;
      if (current === undefined) return { ok: false, reason: 'not_found', currentRevision: 0 };
      if (current.revision !== input.expectedRevision) {
        return { ok: false, reason: 'conflict', currentRevision: current.revision };
      }
      if (normalized.generation <= current.generation) {
        return { ok: false, reason: 'invalid_state', currentRevision: current.revision };
      }
      const sameAccount =
        normalized.bindingReference === current.bindingReference &&
        normalized.credentialIdentity?.account === current.credentialIdentity?.account;
      const timestamp = input.now.toISOString();
      const replacement: SourceBindingRecord = {
        ...normalized,
        state: 'active',
        health: 'initializing',
        completeness: 'incomplete',
        revision: current.revision + 1,
        fence: current.fence + 1,
        scanGeneration: 0,
        nextAttemptAt: timestamp,
        createdAt: current.createdAt,
        updatedAt: timestamp,
      };
      for (const recordKey of this.#records.keys()) {
        if (recordKey.startsWith(`${key}\0record\0`)) this.#records.delete(recordKey);
      }
      const carried = [...this.#suppressions.entries()].filter(
        ([suppressionKeyValue, item]) =>
          suppressionKeyValue.startsWith(`${key}\0suppression\0`) &&
          item.bindingGeneration === current.generation,
      );
      for (const suppressionKeyValue of this.#suppressions.keys()) {
        if (suppressionKeyValue.startsWith(`${key}\0suppression\0`)) {
          this.#suppressions.delete(suppressionKeyValue);
        }
      }
      if (sameAccount) {
        for (const [, item] of carried) {
          const next = { ...item, bindingGeneration: normalized.generation };
          this.#suppressions.set(suppressionKey(replacement, item.sourceIdentityDigest), next);
        }
      }
      this.#setRefreshJobState(key, current.generation, 'superseded', Number.MAX_SAFE_INTEGER);
      this.#bindings.set(key, { record: replacement });
      return { ok: true, binding: clone(replacement) };
    });
  }

  getBinding(input: SourceBindingKey): Promise<SourceBindingRecord | undefined> {
    const record = this.#bindings.get(bindingKey(input))?.record;
    return Promise.resolve(record === undefined ? undefined : clone(record));
  }

  setBindingState(
    input: SourceBindingKey & {
      readonly expectedRevision: number;
      readonly state: 'active' | 'paused';
      readonly now: Date;
    },
  ): Promise<SourceBindingMutationResult> {
    return this.#exclusive(() => {
      const key = bindingKey(input);
      const current = this.#bindings.get(key)?.record;
      if (current === undefined) {
        return { ok: false, reason: 'not_found', currentRevision: 0 };
      }
      if (current.revision !== input.expectedRevision) {
        return { ok: false, reason: 'conflict', currentRevision: current.revision };
      }
      if (current.state === 'revoked' || current.state === input.state) {
        return { ok: false, reason: 'invalid_state', currentRevision: current.revision };
      }
      const { leaseOwner: ignoredOwner, leaseExpiresAt: ignoredExpiry, ...rest } = current;
      void ignoredOwner;
      void ignoredExpiry;
      const changed: SourceBindingRecord = {
        ...rest,
        state: input.state,
        health:
          input.state === 'paused'
            ? 'paused'
            : current.lastSuccessfulSyncAt === undefined
              ? 'initializing'
              : 'stale',
        ...(input.state === 'active' ? { nextAttemptAt: input.now.toISOString() } : {}),
        revision: current.revision + 1,
        updatedAt: input.now.toISOString(),
      };
      this.#bindings.set(key, { record: changed });
      return { ok: true, binding: clone(changed) };
    });
  }

  requestRefresh(
    input: SourceBindingKey & {
      readonly expectedRevision: number;
      readonly idempotencyKey: string;
      readonly now: Date;
    },
  ): Promise<SourceRefreshRequestResult> {
    return this.#exclusive(() => {
      const key = bindingKey(input);
      const current = this.#bindings.get(key);
      if (current === undefined) return { ok: false, reason: 'not_found', currentRevision: 0 };
      const idempotencyDigest = refreshIdempotencyDigest(input.idempotencyKey);
      const requestKey = refreshRequestKey(key, current.record.generation, idempotencyDigest);
      const replay = this.#refreshRequests.get(requestKey);
      if (replay !== undefined) {
        return {
          ok: true,
          binding: clone(current.record),
          receipt: refreshReceipt(replay, true),
        };
      }
      if (current.record.revision !== input.expectedRevision) {
        return { ok: false, reason: 'conflict', currentRevision: current.record.revision };
      }
      if (current.record.state !== 'active') {
        return { ok: false, reason: 'invalid_state', currentRevision: current.record.revision };
      }
      const targetScanGeneration = current.record.scanGeneration + 1;
      const pending = [...this.#refreshRequests.values()].find(
        (item) =>
          item.bindingKey === key &&
          item.bindingGeneration === current.record.generation &&
          item.targetScanGeneration === targetScanGeneration &&
          !terminalRefresh(item.state),
      );
      const request: StoredRefreshRequest =
        pending === undefined
          ? {
              bindingKey: key,
              bindingGeneration: current.record.generation,
              idempotencyDigest,
              targetScanGeneration,
              jobId: refreshJobId(
                key,
                current.record.generation,
                idempotencyDigest,
                targetScanGeneration,
              ),
              requestedAt: input.now.toISOString(),
              state: 'queued',
            }
          : { ...pending, idempotencyDigest };
      const record: SourceBindingRecord = {
        ...current.record,
        nextAttemptAt: input.now.toISOString(),
        revision: current.record.revision + 1,
        updatedAt: input.now.toISOString(),
      };
      this.#bindings.set(key, {
        ...current,
        record,
      });
      this.#refreshRequests.set(requestKey, request);
      return {
        ok: true,
        binding: clone(record),
        receipt: refreshReceipt(request, pending !== undefined),
      };
    });
  }

  claimDue(input: {
    readonly now: Date;
    readonly workerId: string;
    readonly leaseMs: number;
  }): Promise<SourceIngestionLease | undefined> {
    return this.#exclusive(() => {
      const workerId = validateScalar('source worker id', input.workerId, 128);
      const leaseMs = boundedInteger('source lease', input.leaseMs, 1_000, 15 * 60_000);
      const candidate = [...this.#bindings.entries()]
        .filter(([, item]) => due(item.record, input.now))
        .sort((left, right) => dueOrder(left[1].record, right[1].record))[0];
      if (candidate === undefined) return undefined;
      const [key, current] = candidate;
      const continuing = current.record.cursor !== undefined;
      const mode = continuing
        ? requiredScanMode(current.record.scanMode)
        : current.record.checkpoint === undefined
          ? 'snapshot'
          : 'changes';
      const scanGeneration = continuing
        ? current.record.scanGeneration
        : current.record.scanGeneration + 1;
      const fence = current.record.fence + 1;
      const expiresAt = new Date(input.now.getTime() + leaseMs).toISOString();
      const record: SourceBindingRecord = {
        ...current.record,
        health: current.record.lastSuccessfulSyncAt === undefined ? 'initializing' : 'stale',
        completeness: 'incomplete',
        scanMode: mode,
        scanGeneration,
        fence,
        leaseOwner: workerId,
        leaseExpiresAt: expiresAt,
        revision: current.record.revision + 1,
        updatedAt: input.now.toISOString(),
      };
      this.#bindings.set(key, { record, leaseMs });
      this.#setRefreshJobState(key, record.generation, 'running', record.scanGeneration);
      return leaseFrom(record, workerId, leaseMs);
    });
  }

  commitPage(input: {
    readonly lease: SourceIngestionLease;
    readonly now: Date;
    readonly page: SourceScanPage;
  }): Promise<SourcePageCommitResult> {
    return this.#exclusive(() => {
      validatePage(input.page);
      const key = bindingKey(input.lease.binding);
      const mutable = this.#bindings.get(key);
      if (!ownsLease(mutable?.record, input.lease, input.now)) {
        return { ok: false, reason: 'stale_fence' };
      }
      if (mutable.record.cursor !== input.lease.cursor) {
        return { ok: false, reason: 'stale_cursor' };
      }
      for (const source of input.page.records) {
        this.#upsertExternal(mutable.record, input.lease.scanGeneration, source, input.now);
      }
      for (const sourceId of input.page.deletedIds) {
        this.#deleteExternal(mutable.record, sourceId);
      }
      if (input.page.complete) return this.#completePage(key, mutable, input);
      const leaseMs = mutable.leaseMs ?? input.lease.leaseMs;
      const expiresAt = new Date(input.now.getTime() + leaseMs).toISOString();
      const record: SourceBindingRecord = {
        ...mutable.record,
        cursor: requiredCursor(input.page.nextCursor),
        leaseExpiresAt: expiresAt,
        revision: mutable.record.revision + 1,
        updatedAt: input.now.toISOString(),
      };
      this.#bindings.set(key, { record, leaseMs });
      return {
        ok: true,
        binding: clone(record),
        lease: leaseFrom(record, input.lease.owner, leaseMs),
      };
    });
  }

  resetCheckpoint(input: {
    readonly lease: SourceIngestionLease;
    readonly now: Date;
    readonly errorCode: string;
  }): Promise<boolean> {
    return this.#exclusive(() => {
      const key = bindingKey(input.lease.binding);
      const current = this.#bindings.get(key);
      if (!ownsLease(current?.record, input.lease, input.now)) return false;
      const record = withoutScanState(current.record, {
        health: current.record.lastSuccessfulSyncAt === undefined ? 'initializing' : 'stale',
        completeness: 'incomplete',
        errorCode: validateScalar('source error code', input.errorCode, 80),
        nextAttemptAt: input.now.toISOString(),
        revision: current.record.revision + 1,
        updatedAt: input.now.toISOString(),
      });
      this.#bindings.set(key, { record });
      this.#setRefreshJobState(key, record.generation, 'queued', record.scanGeneration);
      return true;
    });
  }

  failLease(input: {
    readonly lease: SourceIngestionLease;
    readonly now: Date;
    readonly errorCode: string;
    readonly retryAt: Date;
  }): Promise<boolean> {
    return this.#exclusive(() => {
      const key = bindingKey(input.lease.binding);
      const current = this.#bindings.get(key);
      if (!ownsLease(current?.record, input.lease, input.now, true)) return false;
      const { leaseOwner: ignoredOwner, leaseExpiresAt: ignoredExpiry, ...rest } = current.record;
      void ignoredOwner;
      void ignoredExpiry;
      const record: SourceBindingRecord = {
        ...rest,
        health: sourceFailureHealth(input.errorCode),
        completeness: 'incomplete',
        errorCode: validateScalar('source error code', input.errorCode, 80),
        nextAttemptAt: input.retryAt.toISOString(),
        revision: current.record.revision + 1,
        updatedAt: input.now.toISOString(),
      };
      this.#bindings.set(key, { record });
      this.#setRefreshJobState(key, record.generation, 'queued', record.scanGeneration);
      return true;
    });
  }

  listExternalRecords(input: ExternalRecordListRequest): Promise<{
    records: readonly ExternalRecord[];
    nextCursor?: string;
  }> {
    const binding = this.#bindings.get(bindingKey(input))?.record;
    if (
      binding === undefined ||
      binding.health === 'reauth_required' ||
      binding.state === 'revoked'
    ) {
      return Promise.resolve({ records: [] });
    }
    const prefix = `${bindingKey(input)}\0record\0`;
    const cursor = decodeExternalRecordCursor(input.cursor, input);
    const limit = externalRecordPageLimit(input.limit);
    const now = this.#now().toISOString();
    const matched = [...this.#records.entries()]
      .filter(
        ([key, stored]) =>
          key.startsWith(prefix) &&
          stored.record.source.bindingGeneration === input.generation &&
          stored.record.deletedAt === undefined &&
          stored.record.retentionExpiresAt > now,
      )
      .map(([key, stored]) => ({ digest: key.slice(prefix.length), record: stored.record }))
      .filter((item) => cursor === undefined || item.digest > cursor)
      .sort((left, right) => left.digest.localeCompare(right.digest))
      .slice(0, limit + 1);
    const selected = matched.slice(0, limit);
    const records = selected
      .map((item) => clone(item.record))
      .sort((left, right) => left.source.id.localeCompare(right.source.id));
    const last = selected.at(-1);
    return Promise.resolve({
      records,
      ...(matched.length > limit && last !== undefined
        ? { nextCursor: encodeExternalRecordCursor(input, last.digest) }
        : {}),
    });
  }

  getExternalRecord(input: ExternalRecordLookup): Promise<ExternalRecord | undefined> {
    const binding = this.#bindings.get(bindingKey(input))?.record;
    if (
      binding === undefined ||
      binding.health === 'reauth_required' ||
      binding.state === 'revoked'
    ) {
      return Promise.resolve(undefined);
    }
    const prefix = `${bindingKey(input)}\0record\0`;
    const recordId = validateScalar('external record id', input.recordId, 128);
    const now = this.#now().toISOString();
    const record = [...this.#records.entries()].find(
      ([key, stored]) =>
        key.startsWith(prefix) &&
        stored.record.id === recordId &&
        stored.record.source.bindingGeneration === input.generation &&
        stored.record.deletedAt === undefined &&
        stored.record.retentionExpiresAt > now,
    )?.[1].record;
    return Promise.resolve(record === undefined ? undefined : clone(record));
  }

  suppressExternalRecord(
    input: SourceBindingKey & {
      readonly sourceId: string;
      readonly reason: SourceSuppressionRecord['reason'];
      readonly now: Date;
    },
  ): Promise<void> {
    return this.#exclusive(() => {
      const key = bindingKey(input);
      const binding = this.#bindings.get(key)?.record;
      if (binding === undefined) throw new Error('source binding not found');
      const digest = this.#sourceDigest(binding, input.sourceId);
      const suppression: SourceSuppressionRecord = {
        scope: clone(binding.scope),
        collectionKey: binding.collectionKey,
        id: binding.id,
        bindingGeneration: binding.generation,
        sourceIdentityDigest: digest,
        reason: input.reason,
        erasedAt: input.now.toISOString(),
      };
      this.#suppressions.set(suppressionKey(binding, digest), suppression);
      this.#eraseStoredRecord(binding, digest);
    });
  }

  listSuppressions(input: SourceBindingKey): Promise<readonly SourceSuppressionRecord[]> {
    const prefix = `${bindingKey(input)}\0suppression\0`;
    return Promise.resolve(
      [...this.#suppressions.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, item]) => clone(item)),
    );
  }

  restoreSuppressions(input: readonly SourceSuppressionRecord[]): Promise<void> {
    return this.#exclusive(() => {
      for (const raw of input) {
        const binding = this.#bindings.get(bindingKey(raw))?.record;
        if (binding === undefined || binding.generation !== raw.bindingGeneration) {
          throw new Error('source suppression does not match an active binding generation');
        }
        const item = normalizeSuppression(raw);
        this.#suppressions.set(suppressionKey(binding, item.sourceIdentityDigest), item);
        this.#eraseStoredRecord(binding, item.sourceIdentityDigest);
      }
    });
  }

  purgeExpired(input: { readonly limit?: number }): Promise<number> {
    return this.#exclusive(() => {
      const limit = boundedInteger('source retention limit', input.limit ?? 100, 1, 100);
      const now = this.#now().toISOString();
      const candidates = [...this.#records.entries()]
        .filter(
          ([, stored]) =>
            stored.record.deletedAt === undefined && stored.record.retentionExpiresAt <= now,
        )
        .sort((left, right) =>
          left[1].record.retentionExpiresAt.localeCompare(right[1].record.retentionExpiresAt),
        )
        .slice(0, limit);
      for (const [key, stored] of candidates)
        this.#records.set(key, erasedMemoryExternal(stored, this.#now()));
      return (
        candidates.length +
        pruneMemoryRefreshReceipts(this.#refreshRequests, this.#now(), limit - candidates.length)
      );
    });
  }

  #completePage(
    key: string,
    mutable: MutableBinding,
    input: {
      readonly lease: SourceIngestionLease;
      readonly now: Date;
      readonly page: SourceScanPage;
    },
  ): SourcePageCommitResult {
    if (input.lease.mode === 'snapshot') {
      const prefix = `${key}\0record\0`;
      for (const [recordKey, stored] of this.#records) {
        if (
          recordKey.startsWith(prefix) &&
          stored.record.deletedAt === undefined &&
          stored.lastSeenGeneration !== input.lease.scanGeneration
        ) {
          this.#records.set(recordKey, erasedMemoryExternal(stored, input.now));
        }
      }
    }
    const checkpoint =
      input.page.checkpoint ??
      (input.lease.mode === 'changes' ? mutable.record.checkpoint : undefined);
    const completeAt = input.now.toISOString();
    this.#setRefreshJobState(
      key,
      mutable.record.generation,
      'completed',
      mutable.record.scanGeneration,
    );
    const pending = [...this.#refreshRequests.values()].some(
      (request) =>
        request.bindingKey === key &&
        request.bindingGeneration === mutable.record.generation &&
        !terminalRefresh(request.state),
    );
    const record = {
      ...completedBinding(mutable.record, completeAt, checkpoint),
      ...(pending ? { health: 'stale' as const, nextAttemptAt: completeAt } : {}),
    };
    this.#bindings.set(key, { record });
    const prefix = `${key}\0record\0`;
    for (const [recordKey, stored] of this.#records) {
      if (recordKey.startsWith(prefix) && stored.record.deletedAt === undefined) {
        this.#records.set(recordKey, {
          ...stored,
          record: { ...stored.record, lastSuccessfulSyncAt: completeAt },
        });
      }
    }
    return { ok: true, binding: clone(record) };
  }

  #upsertExternal(
    binding: SourceBindingRecord,
    scanGeneration: number,
    source: { readonly id: string; readonly version?: string; readonly record: JsonObject },
    now: Date,
  ): void {
    const sourceId = sourceToken('source record id', source.id);
    const digest = this.#sourceDigest(binding, sourceId);
    if (this.#suppressions.has(suppressionKey(binding, digest))) return;
    const key = externalRecordKey(binding, digest);
    const current = this.#records.get(key);
    const content = validateManagedPayload(source.record);
    const contentDigest = jsonDigest(content);
    const timestamp = now.toISOString();
    if (
      current !== undefined &&
      current.contentDigest === contentDigest &&
      current.record.source.version === source.version &&
      current.record.deletedAt === undefined
    ) {
      this.#records.set(key, {
        ...current,
        lastSeenGeneration: scanGeneration,
        record: {
          ...current.record,
          observedAt: timestamp,
          retentionExpiresAt: new Date(
            now.getTime() + binding.retentionDays * 86_400_000,
          ).toISOString(),
          updatedAt: timestamp,
        },
      });
      return;
    }
    const createdAt = current?.record.createdAt ?? timestamp;
    const record: ExternalRecord = {
      scope: clone(binding.scope),
      collectionKey: binding.collectionKey,
      id: externalRecordId(binding, digest),
      authority: 'external',
      schemaVersion: binding.schemaVersion,
      schemaDigest: binding.schemaDigest,
      source: {
        bindingId: binding.id,
        bindingGeneration: binding.generation,
        id: sourceId,
        ...(source.version === undefined
          ? {}
          : { version: sourceToken('source version', source.version) }),
      },
      record: content,
      revision: (current?.record.revision ?? 0) + 1,
      completeness: 'complete',
      observedAt: timestamp,
      ...(current?.record.lastSuccessfulSyncAt === undefined
        ? {}
        : { lastSuccessfulSyncAt: current.record.lastSuccessfulSyncAt }),
      retentionExpiresAt: new Date(
        now.getTime() + binding.retentionDays * 86_400_000,
      ).toISOString(),
      createdAt,
      updatedAt: timestamp,
    };
    this.#records.set(key, { record, lastSeenGeneration: scanGeneration, contentDigest });
  }

  #deleteExternal(binding: SourceBindingRecord, sourceId: string): void {
    const digest = this.#sourceDigest(binding, sourceToken('deleted source id', sourceId));
    this.#eraseStoredRecord(binding, digest);
  }

  #eraseStoredRecord(binding: SourceBindingRecord, digest: string): void {
    const key = externalRecordKey(binding, digest);
    const current = this.#records.get(key);
    if (current === undefined || current.record.deletedAt !== undefined) return;
    this.#records.set(key, erasedMemoryExternal(current, this.#now()));
  }

  #sourceDigest(binding: SourceBindingRecord, sourceId: string): string {
    return createHmac('sha256', this.#identityKey)
      .update(`${bindingKey(binding)}\0${binding.bindingReference ?? binding.id}\0${sourceId}`)
      .digest('hex');
  }

  #setRefreshJobState(
    key: string,
    generation: number,
    state: StoredRefreshRequest['state'],
    scanGeneration: number,
  ): void {
    for (const [requestKey, request] of this.#refreshRequests) {
      if (
        request.bindingKey === key &&
        request.bindingGeneration === generation &&
        request.targetScanGeneration <= scanGeneration &&
        !terminalRefresh(request.state)
      ) {
        this.#refreshRequests.set(requestKey, {
          ...request,
          state,
          ...(terminalRefresh(state) ? { terminalAt: this.#now().toISOString() } : {}),
        });
      }
    }
  }

  async #exclusive<T>(operation: () => T): Promise<T> {
    const previous = this.#pending;
    let release: () => void = () => {};
    this.#pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const bindings = new Map(this.#bindings);
    const records = new Map(this.#records);
    const suppressions = new Map(this.#suppressions);
    const refresh = new Map(this.#refreshRequests);
    try {
      const result = operation();
      this.#capacity.admit(
        { bindings, records, suppressions, refresh },
        {
          bindings: this.#bindings,
          records: this.#records,
          suppressions: this.#suppressions,
          refresh: this.#refreshRequests,
        },
      );
      return result;
    } catch (error) {
      restoreMap(this.#bindings, bindings);
      restoreMap(this.#records, records);
      restoreMap(this.#suppressions, suppressions);
      restoreMap(this.#refreshRequests, refresh);
      throw error;
    } finally {
      release();
    }
  }
}
