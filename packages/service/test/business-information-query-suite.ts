import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { StoreHarness } from './business-information-store-suite.js';

export function describeNativeRecordQueries(makeHarness: () => Promise<StoreHarness>): void {
  it('filters declared payload fields and binds sorted cursors to query and anchor revision', async () => {
    const { store, advance } = await makeHarness();
    const scope = {
      org: `query-${randomUUID()}`,
      app: 'query',
      env: 'prod',
      installationId: 'query',
    };
    await store.createInstallation({
      scope,
      profileKey: 'travel',
      managedCollections: ['travel_requests'],
      actorSubject: 'owner',
    });
    const records = [];
    for (const status of ['new', 'resolved', 'new', 'closed']) {
      const result = await store.createRequest({
        scope,
        collectionKey: 'travel_requests',
        idempotencyKey: randomUUID(),
        payload: { request_type: 'refund', summary: 'Synthetic query', status },
        origin: { kind: 'portal' },
        actorSubject: 'owner',
      });
      if (result.disposition !== 'created') throw new Error('fixture creation failed');
      records.push(result.record);
      advance(1000);
    }
    const input = {
      scope,
      collectionKey: 'travel_requests',
      sortField: 'status',
      sortDirection: 'asc' as const,
      limit: 1,
    };
    const first = await store.listRequests(input);
    expect(first.records.map((record) => record.content?.payload.status)).toEqual(['closed']);
    expect(first.nextCursor).toBeDefined();
    const second = await store.listRequests({ ...input, cursor: first.nextCursor });
    expect(second.records.map((record) => record.content?.payload.status)).toEqual(['new']);
    await expect(
      store.listRequests({ ...input, sortDirection: 'desc', cursor: first.nextCursor }),
    ).rejects.toThrow(/cursor/);
    const filtered = await store.listRequests({
      scope,
      collectionKey: 'travel_requests',
      filters: [{ field: 'status', value: 'new' }],
    });
    expect(filtered.records.map((record) => record.id)).toEqual([records[0]?.id, records[2]?.id]);
    await expect(
      store.listRequests({ ...input, filters: [{ field: 'summary', value: 'Synthetic query' }] }),
    ).rejects.toThrow(/declared/);
    await expect(
      store.listRequests({ ...input, filters: [{ field: 'status', value: 5 }] }),
    ).rejects.toThrow(/schema/);
    const bounded = await store.listRequests({
      scope,
      collectionKey: 'travel_requests',
      createdAtFrom: records[1]?.createdAt,
      createdAtTo: records[2]?.createdAt,
    });
    expect(bounded.records.map((record) => record.id)).toEqual([records[1]?.id, records[2]?.id]);
    const anchor = first.records[0];
    if (anchor === undefined) throw new Error('missing anchor');
    await store.mutateRequest({
      scope,
      collectionKey: 'travel_requests',
      id: anchor.id,
      expectedRevision: anchor.revision,
      actorSubject: 'owner',
      operation: { kind: 'update', payload: { summary: 'Changed anchor' } },
    });
    await expect(store.listRequests({ ...input, cursor: first.nextCursor })).rejects.toThrow(
      /cursor/,
    );
    expect(Buffer.from(first.nextCursor ?? '', 'base64url').toString()).not.toContain('closed');
  });
}
