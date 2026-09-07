import { describe, expect, it } from 'vitest';
import {
  assertSourceMetadata,
  SOURCE_MAX_REFRESH_KEYS,
  SOURCE_MAX_REPLICA_ROWS,
  SOURCE_METADATA_BYTES,
  SOURCE_ORG_CUSTODY_BYTES,
  SOURCE_REFRESH_REPLAY_MS,
  SourceCapacityError,
  sourceDatasetCharge,
  sourceRowCost,
} from '../src/business-information/source-custody-budget.js';
import {
  SourceMemoryCapacity,
  type SourceMemoryState,
} from '../src/business-information/source-custody-memory.js';
import { bindingKey } from '../src/business-information/source-ingestion-memory-state.js';
import { InMemorySourceIngestionStore } from '../src/business-information/source-ingestion-memory-store.js';
import {
  erasedMemoryExternal,
  type StoredExternalRecord,
} from '../src/business-information/source-ingestion-memory-types.js';
import { refreshBinding } from './source-refresh-conformance.js';

describe('source custody engineering bounds', () => {
  it('keeps ordinary source capacity independent of customer Activity retention and price', () => {
    expect(SOURCE_ORG_CUSTODY_BYTES).toBe(1024 ** 3);
    expect(SOURCE_MAX_REPLICA_ROWS).toBe(100_000);
    expect(SOURCE_MAX_REFRESH_KEYS).toBe(50_000);
    expect(SOURCE_REFRESH_REPLAY_MS).toBe(30 * 86_400_000);
  });
  it('prepays replacement headroom, admits an equal replacement and charges growth', () => {
    expect(sourceDatasetCharge(100, undefined, 0)).toBe(200);
    expect(sourceDatasetCharge(170, 100, 70)).toBe(200);
    expect(sourceDatasetCharge(200, 100, 100)).toBe(200);
    expect(sourceDatasetCharge(220, 100, 120)).toBe(240);
    expect(sourceDatasetCharge(120, undefined, 0)).toBe(240);
  });
  it('prepays a durable suppression row even when a live payload is very small', () => {
    const live = sourceRowCost('record', 3, true);
    const erased = sourceRowCost('record', 0, false) + sourceRowCost('suppression', 0, false);
    expect(erased).toBeLessThanOrEqual(live);
    expect(sourceRowCost('refresh', 0, false)).toBe(SOURCE_METADATA_BYTES);
  });
  it('rejects unbudgeted future metadata instead of silently undercounting it', () => {
    expect(() => assertSourceMetadata({ value: 'x'.repeat(SOURCE_METADATA_BYTES) })).toThrow(
      /metadata exceeds/,
    );
  });
});

it('memory accounting refuses growth atomically, isolates organizations and funds erasure at its exact charge', async () => {
  const store = new InMemorySourceIngestionStore({
    identityKey: 'fixture-source-identity-at-least-32-bytes',
  });
  const binding = refreshBinding('capacity-one');
  const record = await store.createBinding(binding);
  const empty: SourceMemoryState = {
    bindings: new Map(),
    records: new Map(),
    suppressions: new Map(),
    refresh: new Map(),
  };
  const initial: SourceMemoryState = {
    ...empty,
    bindings: new Map([[bindingKey(binding), { record }]]),
  };
  const accepted: StoredExternalRecord = {
    contentDigest: 'a'.repeat(64),
    lastSeenGeneration: 1,
    record: {
      scope: binding.scope,
      collectionKey: binding.collectionKey,
      id: 'replica-one',
      authority: 'external',
      schemaVersion: 1,
      schemaDigest: 'a'.repeat(64),
      source: { bindingId: binding.id, bindingGeneration: 1, id: 'source-one' },
      record: { stock: 1 },
      revision: 1,
      completeness: 'complete',
      observedAt: record.createdAt,
      retentionExpiresAt: '2026-12-01T00:00:00Z',
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    },
  };
  const once: SourceMemoryState = { ...initial, records: new Map([['record-one', accepted]]) };
  const twice: SourceMemoryState = {
    ...once,
    records: new Map([
      ...once.records,
      ['record-two', { ...accepted, record: { ...accepted.record, id: 'replica-two' } }],
    ]),
  };
  const budget = new SourceMemoryCapacity(40_000);
  budget.admit(empty, initial);
  budget.admit(initial, once);
  expect(() => budget.admit(once, twice)).toThrow(SourceCapacityError);
  expect(() => budget.admit(once, once)).not.toThrow();
  const erased: SourceMemoryState = {
    ...once,
    records: new Map([['record-one', erasedMemoryExternal(accepted, new Date())]]),
    suppressions: new Map([
      [
        'suppression-one',
        {
          ...binding,
          bindingGeneration: 1,
          sourceIdentityDigest: 'b'.repeat(64),
          reason: 'customer_request',
          erasedAt: new Date().toISOString(),
        },
      ],
    ]),
  };
  expect(() => budget.admit(once, erased)).not.toThrow();
  const otherBinding = { ...binding, scope: { ...binding.scope, org: 'another-org' } };
  const other: SourceMemoryState = {
    ...erased,
    bindings: new Map([
      ...erased.bindings,
      [bindingKey(otherBinding), { record: { ...record, ...otherBinding } }],
    ]),
  };
  expect(() => budget.admit(erased, other)).not.toThrow();
});
