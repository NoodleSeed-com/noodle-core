import { describe, expect, it, vi } from 'vitest';
import { type ActivityHistoryAllowance, ApplicationActivity } from '../src/application-activity.js';
import { InMemoryOperationEvidenceStore } from '../src/operation-evidence-memory.js';

describe('hypothetical installation history preview', () => {
  const scope = { org: 'acme', app: 'sales', env: 'production', installationId: 'sales' };
  const authority = {
    maximumDays: 90,
    defaultDays: 30,
    revision: 'verified-snapshot-and-subscription',
    preview: {
      asOf: '2026-09-07T00:00:00.000Z',
      paidPeriodEnd: '2026-10-01T00:00:00.000Z',
      scenarios: [{ id: 'lower', label: 'Lower plan', maximumDays: 30 }],
    },
  } satisfies ActivityHistoryAllowance;
  function fixture(values: readonly (ActivityHistoryAllowance | undefined)[]) {
    let index = 0;
    const allowance = vi.fn(async () => values[Math.min(index++, values.length - 1)]);
    const store = new InMemoryOperationEvidenceStore();
    const activity = new ApplicationActivity({
      store,
      allowance,
      epoch: 'test',
      identityKey: 'test',
    });
    return { activity, allowance, store };
  }
  it('projects a comparison without changing settings or claiming a scheduled downgrade', async () => {
    const { activity, allowance, store } = fixture([authority]);
    expect(await activity.preview(scope)).toMatchObject({
      state: 'available',
      kind: 'hypothetical',
      asOf: authority.preview?.asOf,
      paidPeriodEnd: authority.preview?.paidPeriodEnd,
      currentMaximumDays: 90,
      currentlyAccessibleCount: 0,
      physicallyExpiresByPeriodEndCount: 0,
      scenarios: [
        {
          id: 'lower',
          label: 'Lower plan',
          maximumDays: 30,
          additionallyHiddenAtPeriodEndCount: 0,
        },
      ],
    });
    expect(allowance).toHaveBeenCalledWith('acme', { includePreview: true });
    expect(await store.readRetention(scope)).toBeUndefined();
  });
  it('fails closed with a safe policy error when authority or aggregate storage is unavailable', async () => {
    const failedAuthority = fixture([authority]);
    failedAuthority.allowance.mockRejectedValueOnce(new Error('private storage diagnostic'));
    await expect(failedAuthority.activity.preview(scope)).rejects.toMatchObject({
      code: 'activity_unavailable',
    });
    const failedStore = fixture([authority]);
    vi.spyOn(failedStore.store, 'preview').mockRejectedValueOnce(
      new Error('private storage diagnostic'),
    );
    await expect(failedStore.activity.preview(scope)).rejects.toMatchObject({
      code: 'activity_unavailable',
    });
  });
  it('does not disclose counts without verified period evidence and rejects authority changes', async () => {
    expect(
      await fixture([{ maximumDays: 7, defaultDays: 7, revision: 'free' }]).activity.preview(scope),
    ).toEqual({
      state: 'unavailable',
      reason: 'no_verified_paid_period',
    });
    await expect(fixture([undefined]).activity.preview(scope)).rejects.toMatchObject({
      code: 'activity_unavailable',
    });
    await expect(
      fixture([authority, { ...authority, revision: 'changed' }]).activity.preview(scope),
    ).rejects.toMatchObject({ code: 'activity_conflict' });
    await expect(
      fixture([
        { ...authority, preview: { ...authority.preview, paidPeriodEnd: 'forged-date' } },
      ]).activity.preview(scope),
    ).rejects.toMatchObject({ code: 'activity_unavailable' });
  });
});
