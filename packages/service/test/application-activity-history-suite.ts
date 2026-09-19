import { describe, expect, it, vi } from 'vitest';
import { type ActivityHistoryAllowance, ApplicationActivity } from '../src/application-activity.js';
import type { OperationEvidenceStore } from '../src/operation-evidence.js';

/** The same policy proof runs against memory and real PostgreSQL, not only a mocked page. */
export function describeActivityHistoryPolicy(create: () => Promise<OperationEvidenceStore>) {
  const scope = { org: 'history', app: 'site', env: 'production', installationId: 'site' };
  const day = 86_400_000;
  const now = 1_800_000_000_000;
  async function fixture() {
    const store = await create();
    let allowance: ActivityHistoryAllowance = {
      maximumDays: 90,
      defaultDays: 90,
      revision: 'verified-history-v1',
      preview: {
        asOf: new Date(now).toISOString(),
        paidPeriodEnd: new Date(now + day).toISOString(),
        scenarios: [
          { id: 'lower', label: 'Lower plan', maximumDays: 30 },
          { id: 'shortest', label: 'Shortest plan', maximumDays: 1 },
        ],
      },
    };
    const activity = new ApplicationActivity({
      store,
      allowance: async () => allowance,
      now: () => now,
      epoch: 'history-policy-epoch-0001',
      identityKey: 'history-policy-identity-key-longer-than-thirty-two-characters',
    });
    const select = async (retentionDays: number) => {
      const { projection } = await activity.settings(scope, true);
      return activity.save(scope, { retentionDays, expectedRevision: projection.revision });
    };
    const add = async (index: number, age: number) => {
      const id = index.toString(16).padStart(64, '0');
      const startedAt = now - age;
      expect(
        await store.claim({
          scope,
          id,
          lease: 'fixture-lease',
          epoch: 'fixture-epoch',
          deploymentId: 'release',
          tool: 'submit_request',
          connector: 'native',
          operation: 'submit',
          actorDigest: 'protected-actor',
          intentDigest: 'protected-intent',
          startedAt,
          executionDeadline: startedAt + 1000,
          historyExpiresAt: startedAt + 90 * day,
          outcome: 'dispatching',
        }),
      ).toBe(true);
      expect(
        await store.finish(
          scope,
          id,
          'fixture-lease',
          'fixture-epoch',
          {
            outcome: 'completed',
            reference: `request-${index}`,
          },
          startedAt,
        ),
      ).toBe(true);
      return id;
    };
    return {
      store,
      activity,
      select,
      add,
      setAllowance(value: Partial<ActivityHistoryAllowance>) {
        allowance = { ...allowance, ...value };
      },
    };
  }
  describe('effective Activity history policy', () => {
    it.each([
      'list',
      'export',
    ] as const)('applies a shorter selection immediately to %s, including the exact cutoff', async (purpose) => {
      const { activity, store, select, add } = await fixture();
      const recent = await add(1, day);
      const boundary = await add(2, 3 * day);
      await add(3, 3 * day + 1);
      await add(4, 20 * day);
      await select(3);
      const page = await activity.page(scope, { purpose, limit: 100 });
      expect(page.historyDays).toBe(3);
      expect(page.activities.map(({ id }) => id)).toEqual([recent, boundary]);
      // Logical access is not an unreviewed migration of assigned expiry or native data.
      expect(await store.list(scope, now, 90, 100)).toHaveLength(4);
    });
    it('uses the smaller of the live allowance and selection without extending on upgrade', async () => {
      const { activity, select, add, setAllowance } = await fixture();
      await add(1, 2 * day);
      await add(2, 8 * day);
      await select(10);
      setAllowance({ maximumDays: 7, defaultDays: 7, revision: 'free' });
      expect(await activity.page(scope, { purpose: 'list', limit: 100 })).toMatchObject({
        historyDays: 7,
        activities: [{ reference: 'request-1' }],
      });
      setAllowance({ maximumDays: 90, defaultDays: 90, revision: 'paid-again' });
      expect(await activity.page(scope, { purpose: 'list', limit: 100 })).toMatchObject({
        historyDays: 10,
        activities: [{ reference: 'request-1' }, { reference: 'request-2' }],
      });
    });
    it.each([
      'list',
      'export',
    ] as const)('rejects old %s cursors after a selection changes', async (purpose) => {
      const { activity, select, add } = await fixture();
      await add(1, day);
      await add(2, 2 * day);
      const first = await activity.page(scope, { purpose, limit: 1 });
      expect(first.nextCursor).toBeDefined();
      if (first.nextCursor === undefined) throw new Error('Expected a complete paging proof');
      await select(3);
      await expect(
        activity.page(scope, {
          purpose,
          limit: 1,
          cursor: first.nextCursor,
        }),
      ).rejects.toMatchObject({ code: 'activity_invalid' });
    });
    it.each([
      'list',
      'export',
    ] as const)('does not return a %s page across a settings race', async (purpose) => {
      const { activity, store, add } = await fixture();
      await add(1, 20 * day);
      const read = store.list.bind(store);
      const spy = vi.spyOn(store, 'list').mockImplementationOnce(async (...args) => {
        const records = await read(...args);
        const setting = await store.readRetention(scope);
        expect(await store.setRetention(scope, 3, setting?.revision)).toBe(true);
        return records;
      });
      try {
        await expect(activity.page(scope, { purpose, limit: 100 })).rejects.toMatchObject({
          code: 'activity_conflict',
        });
      } finally {
        spy.mockRestore();
      }
    });
    it('previews only selected history and never invents additional loss above that window', async () => {
      const { activity, select, add } = await fixture();
      await add(1, 2 * day);
      await add(2, 8 * day);
      await add(3, 40 * day);
      await select(7);
      expect(await activity.preview(scope)).toMatchObject({
        currentMaximumDays: 90,
        currentlyAccessibleCount: 1,
        physicallyExpiresByPeriodEndCount: 0,
        scenarios: [
          { id: 'lower', maximumDays: 30, additionallyHiddenAtPeriodEndCount: 0 },
          { id: 'shortest', maximumDays: 1, additionallyHiddenAtPeriodEndCount: 1 },
        ],
      });
    });
    it('uses the verified default without writing a setting when previewing a new installation', async () => {
      const { activity, store, add, setAllowance } = await fixture();
      setAllowance({ defaultDays: 30 });
      await add(1, 20 * day);
      await add(2, 40 * day);
      expect(await activity.preview(scope)).toMatchObject({ currentlyAccessibleCount: 1 });
      expect(await store.readRetention(scope)).toBeUndefined();
    });
    it('binds preview revisions to the selected policy even if aggregate counts do not change', async () => {
      const { activity, select } = await fixture();
      const previous = await activity.preview(scope);
      await select(7);
      const next = await activity.preview(scope);
      expect(previous.state).toBe('available');
      expect(next.state).toBe('available');
      if (previous.state === 'available' && next.state === 'available')
        expect(next.revision).not.toBe(previous.revision);
    });
    it('rejects preview counts if settings change while the aggregate is read', async () => {
      const { activity, store, add } = await fixture();
      await add(1, 40 * day);
      const preview = store.preview.bind(store);
      const spy = vi.spyOn(store, 'preview').mockImplementationOnce(async (...args) => {
        const counts = await preview(...args);
        expect(await store.setRetention(scope, 3, undefined)).toBe(true);
        return counts;
      });
      try {
        await expect(activity.preview(scope)).rejects.toMatchObject({ code: 'activity_conflict' });
      } finally {
        spy.mockRestore();
      }
    });
  });
}
