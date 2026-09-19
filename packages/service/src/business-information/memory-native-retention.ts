import type {
  ManagedRequestActivity,
  ManagedRequestRecord,
  RequestMutationResult,
} from './contracts.js';
import { cloneRecord, deletedRecord } from './model.js';

export interface MemoryNativeRetention {
  readonly records: ReadonlyMap<string, ManagedRequestRecord>;
  readonly commit: (
    key: string,
    record: ManagedRequestRecord,
    kind: ManagedRequestActivity['kind'],
  ) => void;
}
export function expireNativeMemoryRecord(
  store: MemoryNativeRetention,
  key: string,
  now: Date,
): ManagedRequestRecord | undefined {
  const current = store.records.get(key);
  if (
    current === undefined ||
    current.deletedAt !== undefined ||
    current.retentionExpiresAt === null ||
    current.retentionExpiresAt > now.toISOString()
  )
    return current;
  const erased = deletedRecord(current, 'system:retention', now, 'retention_expired');
  store.commit(key, erased, 'retention_expired');
  return erased;
}

/** Recheck after acquiring the record lock: a reviewed migration may have won since sweep selection. */
export function eraseNativeMemoryRecord(
  store: MemoryNativeRetention,
  key: string,
  expectedRevision: number,
  actorSubject: string,
  reason: 'customer_request' | 'retention_expired',
  now: Date,
): RequestMutationResult {
  const current =
    reason === 'retention_expired'
      ? store.records.get(key)
      : expireNativeMemoryRecord(store, key, now);
  if (current === undefined || current.deletedAt !== undefined)
    return { ok: false, reason: 'not_found', currentRevision: current?.revision ?? 0 };
  if (current.revision !== expectedRevision)
    return { ok: false, reason: 'conflict', currentRevision: current.revision };
  if (
    reason === 'retention_expired' &&
    (current.retentionExpiresAt === null || current.retentionExpiresAt > now.toISOString())
  )
    return { ok: false, reason: 'invalid_transition', currentRevision: current.revision };
  const erased = deletedRecord(current, actorSubject, now, reason);
  store.commit(key, erased, reason === 'customer_request' ? 'deleted' : 'retention_expired');
  return { ok: true, record: cloneRecord(erased) };
}
