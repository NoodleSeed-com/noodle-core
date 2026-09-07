import { describe, expect, it } from 'vitest';
import { InMemorySourceIngestionStore } from '../src/business-information/source-ingestion-memory-store.js';
import { refreshBinding } from './source-refresh-conformance.js';

describe('source refresh receipt custody', () => {
  it('retains pending demand indefinitely and expires terminal replay only after its 30-day window', async () => {
    let now = new Date('2026-09-07T00:00:00Z');
    const store = new InMemorySourceIngestionStore({
      identityKey: 'fixture-source-identity-at-least-32-bytes',
      now: () => now,
    });
    const binding = refreshBinding('memory-retention');
    await store.createBinding(binding);
    const requested = await store.requestRefresh({
      ...binding,
      expectedRevision: 1,
      idempotencyKey: 'first',
      now,
    });
    if (!requested.ok) throw new Error('Missing request');
    const lease = await store.claimDue({ now, workerId: 'scan', leaseMs: 60_000 });
    if (!lease) throw new Error('Missing lease');
    const committed = await store.commitPage({
      lease,
      now,
      page: { records: [], deletedIds: [], complete: true },
    });
    if (!committed.ok) throw new Error('Missing completion');
    const pending = await store.requestRefresh({
      ...binding,
      expectedRevision: committed.binding.revision,
      idempotencyKey: 'pending',
      now,
    });
    if (!pending.ok) throw new Error('Missing pending demand');
    const replay = () =>
      store.requestRefresh({ ...binding, expectedRevision: 1, idempotencyKey: 'first', now });
    expect(await replay()).toMatchObject({
      ok: true,
      receipt: {
        id: requested.receipt.id,
        state: 'completed',
        replayExpiresAt: '2026-10-07T00:00:00.000Z',
      },
    });
    now = new Date('2026-10-06T23:59:59.999Z');
    expect(await store.purgeExpired({ limit: 1 })).toBe(0);
    now = new Date('2026-10-07T00:00:00Z');
    expect(await store.purgeExpired({ limit: 1 })).toBe(1);
    expect(await replay()).toMatchObject({ ok: false, reason: 'conflict' });
    expect(
      await store.requestRefresh({
        ...binding,
        expectedRevision: 1,
        idempotencyKey: 'pending',
        now,
      }),
    ).toMatchObject({ ok: true, receipt: { id: pending.receipt.id, state: 'queued' } });
    expect(await store.purgeExpired({ limit: 1 })).toBe(0);
    const restartedKey = await store.requestRefresh({
      ...binding,
      expectedRevision: pending.binding.revision,
      idempotencyKey: 'first',
      now,
    });
    expect(restartedKey).toMatchObject({ ok: true, receipt: { state: 'queued', coalesced: true } });
    if (restartedKey.ok) expect(restartedKey.receipt.id).not.toBe(requested.receipt.id);
  });

  it('expires replaced unfinished work only after its superseded replay window', async () => {
    let now = new Date('2026-09-07T00:00:00Z');
    const store = new InMemorySourceIngestionStore({
      identityKey: 'fixture-source-identity-at-least-32-bytes',
      now: () => now,
    });
    const binding = refreshBinding('memory-replacement');
    await store.createBinding(binding);
    const pending = await store.requestRefresh({
      ...binding,
      expectedRevision: 1,
      idempotencyKey: 'pending',
      now,
    });
    if (!pending.ok) throw new Error('Missing demand');
    await store.replaceBinding({
      ...binding,
      generation: 2,
      expectedRevision: pending.binding.revision,
      now,
    });
    now = new Date('2026-10-07T00:00:00Z');
    expect(await store.purgeExpired({ limit: 1 })).toBe(1);
  });
});
