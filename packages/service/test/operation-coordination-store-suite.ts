import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  OperationCoordinationRecord,
  OperationCoordinationStore,
} from '../src/operation-coordination.js';

export const coordinationScope = {
  org: 'example',
  app: 'resource-app',
  env: 'test',
  installationId: 'installation-one',
};
export function coordinationRecord(
  overrides: Partial<OperationCoordinationRecord> = {},
): OperationCoordinationRecord {
  return {
    scope: coordinationScope,
    resource: 'a'.repeat(64),
    token: randomUUID(),
    epoch: 'current-epoch-00001',
    generation: 'connection-1',
    reference: 'private-source-reference',
    operationDigest: 'b'.repeat(64),
    startedAt: 1000,
    deadline: 9000,
    state: 'executing',
    ...overrides,
  };
}

/** The same operational-enforcement contract runs against memory and durable PostgreSQL. */
export function describeOperationCoordinationStore(
  create: () => Promise<OperationCoordinationStore>,
) {
  describe('coordination store conformance', () => {
    let store: OperationCoordinationStore;
    beforeEach(async () => {
      store = await create();
    });

    it('admits exactly one concurrent claimant for one resource', async () => {
      const results = await Promise.all(
        Array.from({ length: 16 }, () => store.claim(coordinationRecord())),
      );
      expect(results.filter((result) => result.acquired)).toHaveLength(1);
      const blocked = results.filter((result) => !result.acquired);
      expect(blocked.every((result) => result.previous?.resource === 'a'.repeat(64))).toBe(true);
      expect(new Set(blocked.map((result) => result.previous?.token)).size).toBe(1);
    });

    it('admits different resources independently and scopes list results', async () => {
      const first = coordinationRecord();
      const other = coordinationRecord({
        resource: 'c'.repeat(64),
        scope: { ...coordinationScope, org: 'other' },
      });
      expect((await store.claim(first)).acquired).toBe(true);
      expect((await store.claim(other)).acquired).toBe(true);
      expect(await store.list(coordinationScope)).toEqual([first]);
      expect(await store.list(other.scope)).toEqual([other]);
    });

    it('does not unlock old or unknown records merely because time passed', async () => {
      const record = coordinationRecord({ startedAt: 1, deadline: 2 });
      await store.claim(record);
      expect((await store.claim(coordinationRecord())).acquired).toBe(false);
      await store.markUnknown(record.resource, record.token);
      const next = await store.claim(
        coordinationRecord({ epoch: 'recovery-epoch-00002', generation: 'new-account' }),
      );
      expect(next).toEqual({ acquired: false, previous: { ...record, state: 'unknown' } });
    });

    it("never returns another scope's reference for a colliding internal resource key", async () => {
      await store.claim(coordinationRecord());
      await expect(
        store.claim(coordinationRecord({ scope: { ...coordinationScope, org: 'other' } })),
      ).rejects.toThrow();
    });

    it.each([0, 101, 1.5])('rejects unbounded list requests (%s)', async (limit) => {
      await expect(store.list(coordinationScope, limit)).rejects.toThrow();
    });

    it.each(['', 'x'.repeat(257)])('requires bounded reviewer and reason (%s)', async (value) => {
      const record = coordinationRecord();
      await store.claim(record);
      await expect(
        store.resolve(coordinationScope, record.resource, record.token, {
          reviewer: value,
          reason: 'Reviewed source',
        }),
      ).rejects.toThrow();
      await expect(
        store.resolve(coordinationScope, record.resource, record.token, {
          reviewer: 'operator',
          reason: value,
        }),
      ).rejects.toThrow();
      expect((await store.claim(coordinationRecord())).acquired).toBe(false);
    });

    it('requires the exact claim token for mutations and cannot release a subsequent claim', async () => {
      const record = coordinationRecord();
      await store.claim(record);
      await store.markUnknown(record.resource, randomUUID());
      expect(await store.release(record.resource, randomUUID(), 'completed')).toBe(false);
      expect((await store.claim(coordinationRecord())).previous?.state).toBe('executing');
      expect(await store.release(record.resource, record.token, 'completed')).toBe(true);
      const next = coordinationRecord();
      await store.claim(next);
      expect(await store.release(record.resource, record.token, 'source_verified')).toBe(false);
      expect((await store.claim(coordinationRecord())).previous?.token).toBe(next.token);
    });

    it.each([
      'completed',
      'rejected',
      'source_verified',
    ])('explicit %s resolution permits a new claim', async (resolution) => {
      const record = coordinationRecord();
      await store.claim(record);
      await store.markUnknown(record.resource, record.token);
      expect(await store.release(record.resource, record.token, resolution)).toBe(true);
      expect(await store.release(record.resource, record.token, resolution)).toBe(false);
      expect((await store.claim(coordinationRecord())).acquired).toBe(true);
    });

    it('returns stable lexicographic resource pages', async () => {
      for (const character of ['c', 'a', 'b'])
        await store.claim(coordinationRecord({ resource: character.repeat(64) }));
      expect((await store.list(coordinationScope, 2)).map((record) => record.resource)).toEqual([
        'a'.repeat(64),
        'b'.repeat(64),
      ]);
      expect(
        (await store.list(coordinationScope, 2, 'b'.repeat(64))).map((record) => record.resource),
      ).toEqual(['c'.repeat(64)]);
    });

    it('resolves reviewed records only within their exact scope and token', async () => {
      const record = coordinationRecord();
      await store.claim(record);
      await store.markUnknown(record.resource, record.token);
      const review = {
        reviewer: 'operator-1',
        reason: 'Verified original effect in source system',
      };
      expect(
        await store.resolve(
          { ...coordinationScope, org: 'other' },
          record.resource,
          record.token,
          review,
        ),
      ).toBe(false);
      expect(await store.resolve(coordinationScope, record.resource, randomUUID(), review)).toBe(
        false,
      );
      expect(await store.resolve(coordinationScope, record.resource, record.token, review)).toBe(
        true,
      );
      expect(await store.resolve(coordinationScope, record.resource, record.token, review)).toBe(
        false,
      );
    });

    it('never releases an active executor through reviewed resolution before its deadline', async () => {
      const record = coordinationRecord({ startedAt: Date.now(), deadline: Date.now() + 100000 });
      await store.claim(record);
      expect(
        await store.resolve(coordinationScope, record.resource, record.token, {
          reviewer: 'operator',
          reason: 'Reviewed',
        }),
      ).toBe(false);
      expect((await store.claim(coordinationRecord())).acquired).toBe(false);
    });
  });
}
