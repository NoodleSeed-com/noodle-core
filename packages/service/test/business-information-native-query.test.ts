import { MANAGED_RECORD_QUERY_SCAN_LIMIT } from '@noodle-borg/wire-contracts';
import { describe, expect, it } from 'vitest';
import { InMemoryBusinessInformationStore } from '../src/business-information/in-memory-store.js';
import { planNativeQuery, runNativeQuery } from '../src/business-information/native-query.js';

async function fixture() {
  const now = new Date('2030-01-01T00:00:00.000Z');
  const store = new InMemoryBusinessInformationStore({ now: () => now });
  const scope = { org: 'query', app: 'query', env: 'prod', installationId: 'query' };
  const installation = await store.createInstallation({
    scope,
    profileKey: 'travel',
    managedCollections: ['travel_requests'],
    actorSubject: 'owner',
  });
  if (installation.disposition !== 'created') throw new Error('installation failed');
  const result = await store.createRequest({
    scope,
    collectionKey: 'travel_requests',
    idempotencyKey: 'fixture',
    payload: { request_type: 'refund', summary: 'Synthetic only' },
    actorSubject: 'owner',
    origin: { kind: 'portal' },
  });
  if (result.disposition !== 'created') throw new Error('record failed');
  const collection = installation.installation.definition.collections[0];
  if (collection === undefined) throw new Error('collection failed');
  return { now, scope, record: result.record, collection };
}

describe('bounded native query evaluation', () => {
  it('rejects the complete payload query after 10,000 candidates without a partial page', async () => {
    const { now, scope, record, collection } = await fixture();
    const input = { scope, collectionKey: collection.key, sortField: 'status', limit: 1 };
    const plan = await planNativeQuery(input, collection, now, async () => undefined);
    let visited = 0;
    function* candidates() {
      for (let i = 0; i < MANAGED_RECORD_QUERY_SCAN_LIMIT + 100; i++) {
        visited++;
        yield { ...record, id: `record-${String(i).padStart(6, '0')}` };
      }
    }
    await expect(runNativeQuery(plan, candidates())).rejects.toMatchObject({
      code: 'query_limit_exceeded',
      message: expect.stringContaining('createdAtFrom/createdAtTo'),
    });
    expect(visited).toBe(MANAGED_RECORD_QUERY_SCAN_LIMIT + 1);
    const ordinary = await planNativeQuery(
      { scope, collectionKey: collection.key, limit: 2 },
      collection,
      now,
      async () => undefined,
    );
    visited = 0;
    expect((await runNativeQuery(ordinary, candidates())).records).toHaveLength(2);
    expect(visited).toBe(3);
  });

  it('compares numbers numerically, booleans strictly and missing fields last in both directions', async () => {
    const { now, scope, record, collection } = await fixture();
    const typedCollection = {
      ...collection,
      recordSchema: {
        type: 'object',
        properties: { rank: { type: 'integer' }, enabled: { type: 'boolean' } },
      },
      filterFields: ['enabled'],
      sortFields: ['rank'],
    };
    const records = [10, 2, undefined].map((rank, index) => ({
      ...record,
      id: `r-${index}`,
      content: {
        payload: { ...(rank === undefined ? {} : { rank }), enabled: index !== 1 },
        notes: [],
      },
    }));
    const input = { scope, collectionKey: collection.key, sortField: 'rank' };
    const asc = await planNativeQuery(input, typedCollection, now, async () => undefined);
    expect((await runNativeQuery(asc, records)).records.map((entry) => entry.id)).toEqual([
      'r-1',
      'r-0',
      'r-2',
    ]);
    const desc = await planNativeQuery(
      { ...input, sortDirection: 'desc', filters: [{ field: 'enabled', value: true }] },
      typedCollection,
      now,
      async () => undefined,
    );
    expect((await runNativeQuery(desc, records)).records.map((entry) => entry.id)).toEqual([
      'r-0',
      'r-2',
    ]);
    await expect(
      planNativeQuery(
        { ...input, filters: [{ field: 'enabled', value: 'true' }] },
        typedCollection,
        now,
        async () => undefined,
      ),
    ).rejects.toThrow(/schema/);
  });
});
