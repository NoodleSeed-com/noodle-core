import { createHash } from 'node:crypto';
import { scopeKey } from './pagination.js';
import type {
  SourceBindingCreate,
  SourceBindingKey,
  SourceBindingRecord,
  SourceIngestionLease,
  SourceRefreshReceipt,
  SourceScanPage,
  SourceSuppressionRecord,
} from './source-ingestion-contracts.js';
import {
  boundedInteger,
  clone,
  fixedDigest,
  jsonDigest,
  requiredCursor,
  requiredScanMode,
  sourceToken,
  suppressionReason,
  validInstant,
} from './source-ingestion-memory-values.js';
import { refreshReplayExpiresAt } from './source-refresh-retention.js';
import { validateScalar, validateScope } from './validation.js';

export interface StoredRefreshRequest {
  readonly bindingKey: string;
  readonly bindingGeneration: number;
  readonly idempotencyDigest: string;
  readonly jobId: string;
  readonly targetScanGeneration: number;
  readonly terminalAt?: string;
  readonly requestedAt: string;
  readonly state: SourceRefreshReceipt['state'];
}

export function normalizeSuppression(value: SourceSuppressionRecord): SourceSuppressionRecord {
  return {
    scope: clone(validateScope(value.scope)),
    collectionKey: validateScalar('source collection key', value.collectionKey, 128),
    id: validateScalar('source binding id', value.id, 128),
    bindingGeneration: boundedInteger(
      'source binding generation',
      value.bindingGeneration,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    sourceIdentityDigest: fixedDigest('source identity digest', value.sourceIdentityDigest),
    reason: suppressionReason(value.reason),
    erasedAt: validInstant('source suppression time', value.erasedAt),
  };
}

export function validatePage(page: SourceScanPage): void {
  if (page.records.length > 100 || page.deletedIds.length > 100) {
    throw new Error('source page exceeds the record limit');
  }
  if (page.resetRequired) throw new Error('source reset page must not be committed');
  if (page.complete && page.nextCursor !== undefined) {
    throw new Error('complete source page cannot include a next cursor');
  }
  if (!page.complete && page.nextCursor === undefined) {
    throw new Error('incomplete source page requires a next cursor');
  }
  const ids = new Set<string>();
  for (const item of page.records) {
    const id = sourceToken('source record id', item.id);
    if (ids.has(id)) throw new Error('source page contains duplicate record ids');
    ids.add(id);
  }
  for (const raw of page.deletedIds) {
    const id = sourceToken('deleted source id', raw);
    if (ids.has(id)) throw new Error('source page records and deletions overlap');
    ids.add(id);
  }
}

export function completedBinding(
  current: SourceBindingRecord,
  completeAt: string,
  checkpoint: string | undefined,
): SourceBindingRecord {
  const {
    cursor: ignoredCursor,
    scanMode: ignoredMode,
    leaseOwner: ignoredOwner,
    leaseExpiresAt: ignoredExpiry,
    errorCode: ignoredError,
    checkpoint: ignoredCheckpoint,
    ...rest
  } = current;
  void ignoredCursor;
  void ignoredMode;
  void ignoredOwner;
  void ignoredExpiry;
  void ignoredError;
  void ignoredCheckpoint;
  return {
    ...rest,
    ...(checkpoint === undefined
      ? {}
      : { checkpoint: sourceToken('source checkpoint', checkpoint) }),
    health: 'current',
    completeness: 'complete',
    lastSuccessfulSyncAt: completeAt,
    nextAttemptAt: new Date(Date.parse(completeAt) + current.pollIntervalMs).toISOString(),
    revision: current.revision + 1,
    updatedAt: completeAt,
  };
}

export function withoutScanState(
  current: SourceBindingRecord,
  update: Pick<
    SourceBindingRecord,
    'health' | 'completeness' | 'revision' | 'updatedAt' | 'nextAttemptAt' | 'errorCode'
  >,
): SourceBindingRecord {
  const {
    checkpoint: ignoredCheckpoint,
    cursor: ignoredCursor,
    scanMode: ignoredMode,
    leaseOwner: ignoredOwner,
    leaseExpiresAt: ignoredExpiry,
    ...rest
  } = current;
  void ignoredCheckpoint;
  void ignoredCursor;
  void ignoredMode;
  void ignoredOwner;
  void ignoredExpiry;
  return { ...rest, ...update };
}

export function leaseFrom(
  record: SourceBindingRecord,
  owner: string,
  leaseMs: number,
): SourceIngestionLease {
  return {
    binding: clone(record),
    owner,
    fence: record.fence,
    scanGeneration: record.scanGeneration,
    mode: requiredScanMode(record.scanMode),
    ...(record.cursor === undefined ? {} : { cursor: record.cursor }),
    ...(record.checkpoint === undefined ? {} : { checkpoint: record.checkpoint }),
    expiresAt: requiredCursor(record.leaseExpiresAt),
    leaseMs,
  };
}

export function ownsLease(
  current: SourceBindingRecord | undefined,
  lease: SourceIngestionLease,
  now: Date,
  allowExpired = false,
): current is SourceBindingRecord {
  return (
    current !== undefined &&
    current.state === 'active' &&
    current.fence === lease.fence &&
    current.scanGeneration === lease.scanGeneration &&
    current.leaseOwner === lease.owner &&
    (allowExpired || Date.parse(current.leaseExpiresAt ?? '') > now.getTime())
  );
}

export function due(record: SourceBindingRecord, now: Date): boolean {
  return (
    record.state === 'active' &&
    Date.parse(record.nextAttemptAt ?? record.createdAt) <= now.getTime() &&
    (record.leaseExpiresAt === undefined || Date.parse(record.leaseExpiresAt) <= now.getTime())
  );
}

export function dueOrder(left: SourceBindingRecord, right: SourceBindingRecord): number {
  return (
    (left.nextAttemptAt ?? left.createdAt).localeCompare(right.nextAttemptAt ?? right.createdAt) ||
    bindingKey(left).localeCompare(bindingKey(right))
  );
}

export function bindingKey(input: SourceBindingKey): string {
  return `${scopeKey(validateScope(input.scope))}\0${validateScalar('source collection key', input.collectionKey, 128)}\0${validateScalar('source binding id', input.id, 128)}`;
}

export function externalRecordKey(binding: SourceBindingKey, digest: string): string {
  return `${bindingKey(binding)}\0record\0${digest}`;
}

export function suppressionKey(binding: SourceBindingKey, digest: string): string {
  return `${bindingKey(binding)}\0suppression\0${digest}`;
}

export function bindingFingerprint(value: SourceBindingCreate): string {
  return jsonDigest(value);
}

export function refreshIdempotencyDigest(value: string): string {
  return createHash('sha256')
    .update(validateScalar('source refresh idempotency key', value, 256))
    .digest('hex');
}

export function refreshRequestKey(key: string, generation: number, digest: string): string {
  return `${key}\0refresh\0${generation}\0${digest}`;
}

export function refreshJobId(
  key: string,
  generation: number,
  digest: string,
  scanGeneration: number,
): string {
  return `sync_${createHash('sha256')
    .update(key)
    .update('\0')
    .update(String(generation))
    .update('\0')
    .update(digest)
    .update('\0')
    .update(String(scanGeneration))
    .digest('hex')
    .slice(0, 24)}`;
}

export function refreshReceipt(
  request: StoredRefreshRequest,
  coalesced: boolean,
): SourceRefreshReceipt {
  return {
    id: request.jobId,
    state: request.state,
    coalesced,
    requestedAt: request.requestedAt,
    ...(request.terminalAt === undefined
      ? {}
      : { replayExpiresAt: refreshReplayExpiresAt(request.terminalAt) }),
  };
}

export function externalRecordId(
  binding: SourceBindingRecord,
  sourceIdentityDigest: string,
): string {
  return `ext_${createHash('sha256')
    .update(sourceIdentityDigest)
    .update('\0')
    .update(String(binding.generation))
    .digest('hex')
    .slice(0, 32)}`;
}
