import type { ExternalRecord, SourceBindingRecord } from './source-ingestion-contracts.js';

export interface StoredExternalRecord {
  readonly record: ExternalRecord;
  readonly lastSeenGeneration: number;
  readonly contentDigest: string;
}

export interface MutableBinding {
  readonly record: SourceBindingRecord;
  readonly leaseMs?: number;
}

export function erasedMemoryExternal(
  stored: StoredExternalRecord,
  now: Date,
): StoredExternalRecord {
  const { record: ignoredPayload, source, ...metadata } = stored.record;
  void ignoredPayload;
  return {
    ...stored,
    record: {
      ...metadata,
      source: {
        bindingId: source.bindingId,
        bindingGeneration: source.bindingGeneration,
        id: '',
      },
      revision: metadata.revision + 1,
      deletedAt: now.toISOString(),
      observedAt: now.toISOString(),
      updatedAt: now.toISOString(),
      completeness: 'complete',
    },
  };
}

export function restoreMap<K, V>(target: Map<K, V>, saved: Map<K, V>): void {
  target.clear();
  for (const [key, value] of saved) target.set(key, value);
}
