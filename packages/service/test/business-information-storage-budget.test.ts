import { describe, expect, it } from 'vitest';
import {
  NATIVE_RETAINED_BYTES_LIMIT,
  NativeStorageBudget,
  NativeStorageLimitError,
} from '../src/business-information/native-storage-budget.js';

describe('native content custody budget', () => {
  it('uses a generous fixed engineering ceiling, independent of plan', () => {
    expect(NATIVE_RETAINED_BYTES_LIMIT).toBe(1024 ** 3);
  });
  it('atomically rejects growth, isolates installations, and admits shrinkage/replay at the ceiling', () => {
    const budget = new NativeStorageBudget(100);
    budget.replace('one', 0, 70);
    expect(() => budget.replace('one', 0, 31)).toThrow(NativeStorageLimitError);
    budget.replace('one', 0, 30);
    budget.replace('one', 100, 100);
    budget.replace('two', 0, 100);
    budget.replace('one', 70, 0);
    budget.replace('one', 0, 70);
    expect(() => budget.replace('one', 0, 1)).toThrow(NativeStorageLimitError);
    expect(() => budget.replace('two', 0, 1)).toThrow(NativeStorageLimitError);
  });
});

// Boundary proof uses real accepted records but a small local helper budget; production has no override.
import type { ManagedRequestRecord } from '../src/business-information/contracts.js';
import { InMemoryBusinessInformationStore } from '../src/business-information/in-memory-store.js';
import { activityFromRecord, deletedRecord } from '../src/business-information/model.js';
import {
  commitNativeMemoryRecord,
  NATIVE_TERMINAL_RESERVE_BYTES,
  nativeCustodyBytes,
} from '../src/business-information/native-storage-budget.js';

async function recordFixture(): Promise<ManagedRequestRecord> {
  const store = new InMemoryBusinessInformationStore();
  const scope = { org: 'acme', app: 'travel', env: 'prod', installationId: 'travel-prod' };
  await store.createInstallation({
    scope,
    profileKey: 'travel',
    managedCollections: ['travel_requests'],
    actorSubject: 'founder',
  });
  const created = await store.createRequest({
    scope,
    collectionKey: 'travel_requests',
    idempotencyKey: 'record',
    payload: { request_type: 'refund', summary: 'Initial' },
    origin: { kind: 'mcp' },
    actorSubject: 'founder',
  });
  if (created.disposition !== 'created') throw new Error('Fixture missing');
  return created.record;
}

it('prepaid terminal space covers maximum bounded actor/identifier metadata, with no exempt writes', async () => {
  const original = await recordFixture();
  const record = {
    ...original,
    scope: {
      org: 'a'.repeat(64),
      app: 'a'.repeat(64),
      env: 'a'.repeat(64),
      installationId: 'a'.repeat(64),
    },
    id: '\\'.repeat(128),
    collectionKey: '\\'.repeat(128),
    assigneeSubject: '😀'.repeat(128),
  };
  const erased = deletedRecord(record, '😀'.repeat(128), new Date(), 'customer_request');
  const event = activityFromRecord(erased, 'deleted');
  expect(nativeCustodyBytes(event)).toBeLessThan(NATIVE_TERMINAL_RESERVE_BYTES / 2);
  expect(nativeCustodyBytes(erased) + nativeCustodyBytes(event)).toBeLessThan(
    nativeCustodyBytes(record),
  );
});

it('rejects the complete memory mutation atomically and preserves paid-for history after erase', async () => {
  const original = await recordFixture();
  const event = activityFromRecord(original, 'created');
  const budget = new NativeStorageBudget(nativeCustodyBytes(original) + nativeCustodyBytes(event));
  const records = new Map<string, ManagedRequestRecord>();
  const activities = new Map<string, (typeof event)[]>();
  commitNativeMemoryRecord(records, activities, budget, 'record', original, event);
  const changed = { ...original, revision: 2 };
  expect(() =>
    commitNativeMemoryRecord(
      records,
      activities,
      budget,
      'record',
      changed,
      activityFromRecord(changed, 'updated'),
    ),
  ).toThrow(NativeStorageLimitError);
  expect(records.get('record')?.revision).toBe(1);
  expect(activities.get('record')).toHaveLength(1);
  const erased = deletedRecord(original, 'founder', new Date(), 'customer_request');
  commitNativeMemoryRecord(
    records,
    activities,
    budget,
    'record',
    erased,
    activityFromRecord(erased, 'deleted'),
  );
  expect(activities.get('record')?.map((entry) => entry.kind)).toEqual(['created', 'deleted']);
  expect(activities.get('record')?.every((entry) => entry.content === undefined)).toBe(true);
  // Content erasure reclaims capacity, but immutable metadata prevents infinite create/erase reuse.
  expect(() =>
    commitNativeMemoryRecord(records, activities, budget, 'new', original, event),
  ).toThrow(NativeStorageLimitError);
});
