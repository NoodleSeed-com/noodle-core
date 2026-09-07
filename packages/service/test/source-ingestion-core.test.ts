import { describe, expect, it } from 'vitest';
import type { InstallationScope, JsonObject } from '../src/business-information/contracts.js';
import type {
  SourceBindingCreate,
  SourceScanPage,
} from '../src/business-information/source-ingestion-contracts.js';
import {
  SourceIngestionCoordinator,
  type SourceReadExecutor,
} from '../src/business-information/source-ingestion-coordinator.js';
import { InMemorySourceIngestionStore } from '../src/business-information/source-ingestion-memory-store.js';

const scope: InstallationScope = {
  org: 'acme',
  app: 'operations',
  env: 'prod',
  installationId: 'installation-one',
};

const binding: SourceBindingCreate = {
  scope,
  collectionKey: 'stock',
  id: 'warehouse-source',
  generation: 1,
  schemaVersion: 3,
  schemaDigest: 'a'.repeat(64),
  queryFingerprint: 'b'.repeat(64),
  scan: {
    connector: 'warehouse',
    connectorVersion: '2026-09-05',
    operation: 'scan_stock',
    signatureDigest: 'c'.repeat(64),
  },
  retentionDays: 30,
  pollIntervalMs: 60_000,
};

describe('generic source ingestion', () => {
  it('replays only an identical immutable binding declaration', async () => {
    const store = memoryStore(mutableClock());
    const created = await store.createBinding(binding);

    await expect(store.createBinding(structuredClone(binding))).resolves.toEqual(created);
    await expect(
      store.createBinding({ ...binding, queryFingerprint: 'd'.repeat(64) }),
    ).rejects.toThrow(/different immutable configuration/i);
  });

  it('replaces a binding with CAS, fences old work, and retains suppressions only for the same account', async () => {
    const clock = mutableClock();
    const store = memoryStore(clock);
    const created = await store.createBinding({ ...binding, bindingReference: 'account-a' });
    const oldLease = required(
      await store.claimDue({ now: clock.now(), workerId: 'old-worker', leaseMs: 10_000 }),
    );
    await store.suppressExternalRecord({
      ...binding,
      sourceId: 'sku-a',
      reason: 'customer_request',
      now: clock.now(),
    });

    const replaced = await store.replaceBinding({
      ...binding,
      bindingReference: 'account-a',
      generation: 2,
      expectedRevision: oldLease.binding.revision,
      now: clock.now(),
    });
    expect(replaced).toMatchObject({
      ok: true,
      binding: { generation: 2, fence: oldLease.fence + 1, scanGeneration: 0 },
    });
    await expect(
      store.commitPage({
        lease: oldLease,
        now: clock.now(),
        page: page({ records: [record('sku-a', 1)], complete: true }),
      }),
    ).resolves.toEqual({ ok: false, reason: 'stale_fence' });
    expect((await store.listSuppressions(binding)).map((item) => item.bindingGeneration)).toEqual([
      2,
    ]);
    await coordinatorFor(
      store,
      queuedExecutor([page({ records: [record('sku-a', 99)], complete: true })]),
      clock,
    ).runOne();
    await expect(store.listExternalRecords({ ...binding, generation: 2 })).resolves.toEqual({
      records: [],
    });

    const afterSameAccount = required(await store.getBinding(binding));
    const changedAccount = await store.replaceBinding({
      ...binding,
      bindingReference: 'account-b',
      generation: 3,
      expectedRevision: afterSameAccount.revision,
      now: clock.now(),
    });
    expect(changedAccount).toMatchObject({ ok: true, binding: { generation: 3 } });
    expect(await store.listSuppressions(binding)).toEqual([]);
    await coordinatorFor(
      store,
      queuedExecutor([page({ records: [record('sku-a', 100)], complete: true })]),
      clock,
    ).runOne();
    await expect(store.listExternalRecords({ ...binding, generation: 3 })).resolves.toMatchObject({
      records: [{ source: { id: 'sku-a', bindingGeneration: 3 } }],
    });
    await expect(
      store.replaceBinding({
        ...binding,
        bindingReference: 'account-b',
        generation: 4,
        expectedRevision: created.revision,
        now: clock.now(),
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'conflict' });
  });

  it('commits a multi-page snapshot and applies later source changes and deletions', async () => {
    const clock = mutableClock();
    const store = memoryStore(clock);
    await store.createBinding(binding);
    const executor = queuedExecutor([
      page({ records: [record('sku-a', 2), record('sku-b', 3)], nextCursor: 'page-2' }),
      page({ records: [record('sku-c', 4)], complete: true, checkpoint: 'checkpoint-1' }),
    ]);
    const coordinator = coordinatorFor(store, executor, clock);

    await expect(coordinator.runOne()).resolves.toMatchObject({ disposition: 'completed' });
    await expect(store.listExternalRecords(binding)).resolves.toMatchObject({
      records: [
        { authority: 'external', source: { id: 'sku-a' }, record: { quantity: 2 } },
        { authority: 'external', source: { id: 'sku-b' }, record: { quantity: 3 } },
        { authority: 'external', source: { id: 'sku-c' }, record: { quantity: 4 } },
      ],
    });
    expect(executor.requests).toEqual([
      { mode: 'snapshot', limit: 100 },
      { mode: 'snapshot', cursor: 'page-2', limit: 100 },
    ]);

    clock.advance(60_000);
    executor.push(
      page({
        records: [record('sku-a', 7, 'version-2')],
        deletedIds: ['sku-b'],
        complete: true,
        checkpoint: 'checkpoint-2',
      }),
    );
    await expect(coordinator.runOne()).resolves.toMatchObject({ disposition: 'completed' });
    await expect(store.listExternalRecords(binding)).resolves.toMatchObject({
      records: [
        { source: { id: 'sku-a', version: 'version-2' }, record: { quantity: 7 } },
        { source: { id: 'sku-c' }, record: { quantity: 4 } },
      ],
    });
    expect(executor.requests.at(-1)).toEqual({
      mode: 'changes',
      checkpoint: 'checkpoint-1',
      limit: 100,
    });
  });

  it('pages external records with a binding-scoped cursor and exact record lookup', async () => {
    const clock = mutableClock();
    const store = memoryStore(clock);
    await store.createBinding(binding);
    await coordinatorFor(
      store,
      queuedExecutor([
        page({
          records: [record('sku-a', 1), record('sku-b', 2), record('sku-c', 3), record('sku-d', 4)],
          complete: true,
        }),
      ]),
      clock,
    ).runOne();

    const first = await store.listExternalRecords({ ...binding, limit: 2 });
    expect(first.records).toHaveLength(2);
    expect(first.nextCursor).toBeTypeOf('string');
    const second = await store.listExternalRecords({
      ...binding,
      cursor: first.nextCursor,
      limit: 2,
    });
    expect(second.records).toHaveLength(2);
    expect(second.nextCursor).toBeUndefined();
    expect([...first.records, ...second.records].map((item) => item.source.id).sort()).toEqual([
      'sku-a',
      'sku-b',
      'sku-c',
      'sku-d',
    ]);

    const last = required(second.records.at(-1));
    await expect(store.getExternalRecord({ ...binding, recordId: last.id })).resolves.toMatchObject(
      { id: last.id, source: { id: last.source.id } },
    );

    const otherBinding = { ...binding, id: 'second-warehouse-source' };
    await store.createBinding(otherBinding);
    expect(() => store.listExternalRecords({ ...otherBinding, cursor: first.nextCursor })).toThrow(
      /cursor/i,
    );
    expect(() => store.listExternalRecords({ ...binding, limit: 501 })).toThrow(/page limit/i);
  });

  it('preserves record revisions across unchanged snapshots while marking them seen', async () => {
    const clock = mutableClock();
    const store = memoryStore(clock);
    await store.createBinding(binding);
    const executor = queuedExecutor([
      page({ records: [record('sku-a', 2), record('sku-b', 3)], complete: true }),
      page({ records: [record('sku-a', 2)], complete: true }),
    ]);
    const coordinator = coordinatorFor(store, executor, clock);

    await coordinator.runOne();
    const first = await store.listExternalRecords(binding);
    expect(first.records).toMatchObject([
      { source: { id: 'sku-a' }, revision: 1 },
      { source: { id: 'sku-b' }, revision: 1 },
    ]);

    clock.advance(60_000);
    await coordinator.runOne();
    await expect(store.listExternalRecords(binding)).resolves.toMatchObject({
      records: [{ source: { id: 'sku-a' }, record: { quantity: 2 }, revision: 1 }],
    });
  });

  it('renews observed replicas and erases expired payloads without permanent suppression', async () => {
    const clock = mutableClock();
    const store = memoryStore(clock);
    await store.createBinding(binding);
    const executor = queuedExecutor([
      page({ records: [record('sku-a', 2)], complete: true }),
      page({ records: [record('sku-a', 2)], complete: true }),
      page({ records: [record('sku-a', 2)], complete: true }),
    ]);
    const coordinator = coordinatorFor(store, executor, clock);

    await coordinator.runOne();
    clock.advance(29 * 86_400_000);
    await coordinator.runOne();
    clock.advance(2 * 86_400_000);
    await expect(store.purgeExpired({ limit: 100 })).resolves.toBe(0);

    const expiring = required((await store.listExternalRecords(binding)).records[0]);
    clock.advance(29 * 86_400_000);
    await expect(store.listExternalRecords(binding)).resolves.toEqual({ records: [] });
    await expect(
      store.getExternalRecord({ ...binding, recordId: expiring.id }),
    ).resolves.toBeUndefined();
    await expect(store.purgeExpired({ limit: 100 })).resolves.toBe(1);
    await expect(store.listExternalRecords(binding)).resolves.toEqual({ records: [] });

    await coordinator.runOne();
    await expect(store.listExternalRecords(binding)).resolves.toMatchObject({
      records: [{ source: { id: 'sku-a' }, record: { quantity: 2 } }],
    });
    await expect(store.listSuppressions(binding)).resolves.toEqual([]);
  });

  it('rejects stale fences and replayed or reordered pages without moving observations backwards', async () => {
    const clock = mutableClock();
    const store = memoryStore(clock);
    await store.createBinding(binding);
    const first = await store.claimDue({
      now: clock.now(),
      workerId: 'worker-one',
      leaseMs: 1_000,
    });
    expect(first).toBeDefined();
    clock.advance(1_001);
    const second = await store.claimDue({
      now: clock.now(),
      workerId: 'worker-two',
      leaseMs: 10_000,
    });
    expect(second?.fence).toBeGreaterThan(first?.fence ?? 0);

    await expect(
      store.commitPage({
        lease: required(first),
        now: clock.now(),
        page: page({ records: [record('sku-a', 1)], complete: true }),
      }),
    ).resolves.toEqual({ ok: false, reason: 'stale_fence' });

    const firstPage = await store.commitPage({
      lease: required(second),
      now: clock.now(),
      page: page({ records: [record('sku-a', 9, 'new')], nextCursor: 'next' }),
    });
    expect(firstPage).toMatchObject({ ok: true, lease: { cursor: 'next' } });
    await expect(
      store.commitPage({
        lease: required(second),
        now: clock.now(),
        page: page({ records: [record('sku-a', 1, 'old')], nextCursor: 'next' }),
      }),
    ).resolves.toEqual({ ok: false, reason: 'stale_cursor' });
    await expect(store.listExternalRecords(binding)).resolves.toMatchObject({
      records: [{ source: { version: 'new' }, record: { quantity: 9 } }],
    });
  });

  it('refuses a contradictory page before applying any record', async () => {
    const clock = mutableClock();
    const store = memoryStore(clock);
    await store.createBinding(binding);
    const lease = required(
      await store.claimDue({ now: clock.now(), workerId: 'worker-one', leaseMs: 10_000 }),
    );

    await expect(
      store.commitPage({
        lease,
        now: clock.now(),
        page: page({
          records: [record('sku-a', 1)],
          deletedIds: ['sku-a'],
          complete: true,
        }),
      }),
    ).rejects.toThrow(/overlap/i);
    await expect(store.listExternalRecords(binding)).resolves.toEqual({ records: [] });
  });

  it('resets an invalid checkpoint and never infers deletion from an incomplete snapshot', async () => {
    const clock = mutableClock();
    const store = memoryStore(clock);
    await store.createBinding(binding);
    const executor = queuedExecutor([
      page({
        records: [record('sku-a', 1), record('sku-b', 2)],
        complete: true,
        checkpoint: 'old',
      }),
      page({ resetRequired: true }),
      page({ records: [record('sku-a', 3)] }),
    ]);
    const coordinator = coordinatorFor(store, executor, clock);
    await coordinator.runOne();
    clock.advance(60_000);
    await expect(coordinator.runOne()).resolves.toMatchObject({ disposition: 'reset' });
    await expect(coordinator.runOne()).rejects.toThrow(/incomplete source page/i);

    const current = await store.listExternalRecords(binding);
    expect(current.records.map((item) => item.source.id)).toEqual(['sku-a', 'sku-b']);
    const resetBinding = await store.getBinding(binding);
    expect(resetBinding).toMatchObject({ completeness: 'incomplete' });
    expect(resetBinding).not.toHaveProperty('checkpoint');
  });

  it('retains suppression through recovery restore and blocks every later full snapshot', async () => {
    const clock = mutableClock();
    const original = memoryStore(clock);
    await original.createBinding(binding);
    const initial = coordinatorFor(
      original,
      queuedExecutor([page({ records: [record('sku-a', 1)], complete: true })]),
      clock,
    );
    await initial.runOne();
    await original.suppressExternalRecord({
      ...binding,
      sourceId: 'sku-a',
      reason: 'customer_request',
      now: clock.now(),
    });
    const recovery = await original.listSuppressions(binding);

    const restored = memoryStore(clock);
    await restored.createBinding(binding);
    await restored.restoreSuppressions(recovery);
    await coordinatorFor(
      restored,
      queuedExecutor([page({ records: [record('sku-a', 99)], complete: true })]),
      clock,
    ).runOne();

    await expect(restored.listExternalRecords(binding)).resolves.toEqual({ records: [] });
    await expect(restored.listSuppressions(binding)).resolves.toHaveLength(1);
  });

  it('exposes only the normalized read protocol to the injected source executor', async () => {
    const clock = mutableClock();
    const store = memoryStore(clock);
    await store.createBinding(binding);
    const executor = queuedExecutor([page({ complete: true })]);

    await coordinatorFor(store, executor, clock).runOne();

    expect(executor.calls).toBe(1);
    expect(Object.keys(executor.requests[0] ?? {}).sort()).toEqual(['limit', 'mode']);
    expect(executor.effects).toBe(0);
  });

  it('uses optimistic revisions when pausing and resuming a source', async () => {
    const clock = mutableClock();
    const store = memoryStore(clock);
    const created = await store.createBinding(binding);
    const paused = await store.setBindingState({
      ...binding,
      expectedRevision: created.revision,
      state: 'paused',
      now: clock.now(),
    });
    expect(paused).toMatchObject({ ok: true, binding: { state: 'paused', health: 'paused' } });
    await expect(
      store.setBindingState({
        ...binding,
        expectedRevision: created.revision,
        state: 'active',
        now: clock.now(),
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'conflict' });
    if (!paused.ok) throw new Error('expected paused source');
    await expect(
      store.setBindingState({
        ...binding,
        expectedRevision: paused.binding.revision,
        state: 'active',
        now: clock.now(),
      }),
    ).resolves.toMatchObject({ ok: true, binding: { state: 'active', health: 'initializing' } });
  });

  it('durably replays and coalesces idempotent refresh requests', async () => {
    const clock = mutableClock();
    const store = memoryStore(clock);
    const created = await store.createBinding(binding);
    const refreshed = await store.requestRefresh({
      ...binding,
      expectedRevision: created.revision,
      idempotencyKey: 'refresh-one',
      now: clock.now(),
    });
    expect(refreshed).toMatchObject({
      ok: true,
      binding: { revision: created.revision + 1 },
      receipt: { state: 'queued', coalesced: false },
    });
    await expect(
      store.requestRefresh({
        ...binding,
        expectedRevision: created.revision,
        idempotencyKey: 'refresh-one',
        now: clock.now(),
      }),
    ).resolves.toMatchObject({
      ok: true,
      receipt: { id: refreshed.ok ? refreshed.receipt.id : '', coalesced: true },
    });
    await expect(
      store.requestRefresh({
        ...binding,
        expectedRevision: created.revision + 1,
        idempotencyKey: 'refresh-two',
        now: clock.now(),
      }),
    ).resolves.toMatchObject({
      ok: true,
      receipt: { id: refreshed.ok ? refreshed.receipt.id : '', coalesced: true },
    });
  });

  it('suppresses reads after authorization loss while retaining stale data for transient failures', async () => {
    const clock = mutableClock();
    const store = memoryStore(clock);
    await store.createBinding(binding);
    let failureCode: string | undefined;
    const executor = {
      requests: [] as unknown[],
      scan: () =>
        failureCode === undefined
          ? Promise.resolve(page({ records: [record('sku-auth', 1)], complete: true }))
          : Promise.reject(Object.assign(new Error('source failure'), { code: failureCode })),
    } satisfies SourceReadExecutor & { requests: unknown[] };
    const coordinator = coordinatorFor(store, executor, clock);

    await coordinator.runOne();
    const visible = required(
      (await store.listExternalRecords({ ...binding, generation: 1 })).records[0],
    );
    failureCode = 'source_scan_failed';
    clock.advance(60_000);
    await expect(coordinator.runOne()).rejects.toMatchObject({ code: 'source_scan_failed' });
    await expect(store.getBinding(binding)).resolves.toMatchObject({ health: 'failed' });
    await expect(
      store.getExternalRecord({ ...binding, generation: 1, recordId: visible.id }),
    ).resolves.toMatchObject({ id: visible.id });

    failureCode = 'credential_unavailable';
    clock.advance(60_000);
    await expect(coordinator.runOne()).rejects.toMatchObject({ code: 'credential_unavailable' });
    await expect(store.getBinding(binding)).resolves.toMatchObject({
      health: 'reauth_required',
      errorCode: 'source_authorization_lost',
    });
    await expect(store.listExternalRecords({ ...binding, generation: 1 })).resolves.toEqual({
      records: [],
    });
    await expect(
      store.getExternalRecord({ ...binding, generation: 1, recordId: visible.id }),
    ).resolves.toBeUndefined();
  });
});

function memoryStore(clock: ReturnType<typeof mutableClock>) {
  return new InMemorySourceIngestionStore({
    now: clock.now,
    identityKey: 'test-source-identity-key-with-32-bytes',
  });
}

function coordinatorFor(
  store: InMemorySourceIngestionStore,
  executor: SourceReadExecutor & { requests: unknown[] },
  clock: ReturnType<typeof mutableClock>,
) {
  return new SourceIngestionCoordinator({
    store,
    executor,
    workerId: 'worker-main',
    now: clock.now,
    validateRecord: (_binding, value) => value as JsonObject,
  });
}

function queuedExecutor(initial: SourceScanPage[]) {
  const pages = [...initial];
  return {
    requests: [] as unknown[],
    calls: 0,
    effects: 0,
    push(pageValue: SourceScanPage) {
      pages.push(pageValue);
    },
    scan(input: Parameters<SourceReadExecutor['scan']>[0]) {
      this.calls += 1;
      this.requests.push(structuredClone(input.request));
      const next = pages.shift();
      if (next === undefined) throw new Error('incomplete source page queue');
      return Promise.resolve(structuredClone(next));
    },
  } satisfies SourceReadExecutor & {
    requests: unknown[];
    calls: number;
    effects: number;
    push(pageValue: SourceScanPage): void;
  };
}

function record(id: string, quantity: number, version = 'version-1') {
  return { id, version, record: { quantity } };
}

function page(input: Partial<SourceScanPage>): SourceScanPage {
  return {
    records: [],
    deletedIds: [],
    complete: false,
    ...input,
  };
}

function mutableClock() {
  let value = new Date('2030-01-01T00:00:00.000Z');
  return {
    now: () => new Date(value),
    advance(milliseconds: number) {
      value = new Date(value.getTime() + milliseconds);
    },
  };
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected value');
  return value;
}
