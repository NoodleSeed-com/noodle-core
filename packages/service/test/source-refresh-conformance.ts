import { expect, it } from 'vitest';
import type {
  SourceBindingCreate,
  SourceIngestionLease,
  SourceIngestionStore,
} from '../src/business-information/source-ingestion-contracts.js';

export function sourceRefreshConformance(
  create: () => Promise<{ store: SourceIngestionStore; binding: SourceBindingCreate }>,
): void {
  it('queues demand during an active scan for the next generation, coalesces it, and survives replay', async () => {
    const { store, binding } = await create();
    await store.createBinding(binding);
    const firstLease = required(
      await store.claimDue({ now: new Date(), workerId: 'scheduled', leaseMs: 60_000 }),
    );
    const firstPage = await store.commitPage({
      lease: firstLease,
      now: new Date(),
      page: {
        records: [{ id: 'A', record: { stock: 1 } }],
        deletedIds: [],
        nextCursor: 'second',
        complete: false,
      },
    });
    if (!firstPage.ok || firstPage.lease === undefined) throw new Error('Missing first page');
    const demand = await store.requestRefresh({
      ...binding,
      expectedRevision: firstPage.binding.revision,
      idempotencyKey: 'after-source-A-changed',
      now: new Date(),
    });
    if (!demand.ok) throw new Error('Missing demand');
    const coalesced = await store.requestRefresh({
      ...binding,
      expectedRevision: demand.binding.revision,
      idempotencyKey: 'same-next-generation',
      now: new Date(),
    });
    expect(coalesced).toMatchObject({
      ok: true,
      receipt: { id: demand.receipt.id, coalesced: true, state: 'queued' },
    });
    await store.commitPage({
      lease: firstPage.lease,
      now: new Date(),
      page: {
        records: [{ id: 'B', record: { stock: 3 } }],
        deletedIds: [],
        complete: true,
      },
    });
    const replay = () =>
      store.requestRefresh({
        ...binding,
        expectedRevision: 1,
        idempotencyKey: 'after-source-A-changed',
        now: new Date(),
      });
    expect(await replay()).toMatchObject({
      ok: true,
      receipt: { id: demand.receipt.id, state: 'queued' },
    });
    const next = required(
      await store.claimDue({ now: new Date(), workerId: 'manual', leaseMs: 60_000 }),
    );
    expect(next.scanGeneration).toBe(firstLease.scanGeneration + 1);
    await store.commitPage({
      lease: next,
      now: new Date(),
      page: {
        records: [
          { id: 'A', record: { stock: 2 } },
          { id: 'B', record: { stock: 3 } },
        ],
        deletedIds: [],
        complete: true,
      },
    });
    expect(await replay()).toMatchObject({
      ok: true,
      receipt: { id: demand.receipt.id, state: 'completed' },
    });
    expect(
      (await store.listExternalRecords({ ...binding, generation: 1 })).records.find(
        (row) => row.source.id === 'A',
      )?.record,
    ).toEqual({ stock: 2 });
  });

  it('retains a charged tombstone and monotonic revision when a source identity disappears and returns', async () => {
    const { store, binding } = await create();
    await store.createBinding(binding);
    const scan = async (records: readonly { id: string; record: { stock: number } }[]) => {
      const current = required(await store.getBinding(binding));
      await store.requestRefresh({
        ...binding,
        expectedRevision: current.revision,
        idempotencyKey: `scan-${current.revision}`,
        now: new Date(),
      });
      const lease = required(
        await store.claimDue({ now: new Date(), workerId: 'scan', leaseMs: 60_000 }),
      );
      await store.commitPage({
        lease,
        now: new Date(),
        page: { records, deletedIds: [], complete: true },
      });
    };
    await scan([{ id: 'A', record: { stock: 1 } }]);
    const original = required(
      (await store.listExternalRecords({ ...binding, generation: 1 })).records[0],
    );
    await scan([]);
    expect((await store.listExternalRecords({ ...binding, generation: 1 })).records).toEqual([]);
    await scan([{ id: 'A', record: { stock: 2 } }]);
    const returned = required(
      (await store.listExternalRecords({ ...binding, generation: 1 })).records[0],
    );
    expect(returned.id).toBe(original.id);
    expect(returned.revision).toBeGreaterThan(original.revision);
  });

  it('refuses the complete page atomically when a later row exceeds its payload bound', async () => {
    const { store, binding } = await create();
    await store.createBinding(binding);
    const lease: SourceIngestionLease = required(
      await store.claimDue({ now: new Date(), workerId: 'scan', leaseMs: 60_000 }),
    );
    await expect(
      store.commitPage({
        lease,
        now: new Date(),
        page: {
          records: [
            { id: 'A', record: { stock: 1 } },
            { id: 'B', record: { text: 'x'.repeat(32_768) } },
          ],
          deletedIds: [],
          complete: true,
        },
      }),
    ).rejects.toThrow();
    expect((await store.listExternalRecords({ ...binding, generation: 1 })).records).toEqual([]);
    expect(await store.getBinding(binding)).toMatchObject({
      revision: lease.binding.revision,
      completeness: 'incomplete',
    });
  });
}

export function refreshBinding(installationId: string): SourceBindingCreate {
  return {
    scope: { org: 'source-capacity', app: 'stock', env: 'prod', installationId },
    collectionKey: 'stock',
    id: 'source',
    generation: 1,
    schemaVersion: 1,
    schemaDigest: 'a'.repeat(64),
    queryFingerprint: 'b'.repeat(64),
    scan: {
      connector: 'warehouse',
      connectorVersion: 'v1',
      operation: 'scan',
      signatureDigest: 'c'.repeat(64),
    },
    retentionDays: 30,
    pollIntervalMs: 60_000,
  };
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing fixture value');
  return value;
}
