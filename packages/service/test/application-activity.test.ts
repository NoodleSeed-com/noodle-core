import { describe, expect, it } from 'vitest';
import { type ActivityHistoryAllowance, ApplicationActivity } from '../src/application-activity.js';
import { InMemoryOperationEvidenceStore } from '../src/operation-evidence-memory.js';

describe('verified application history settings', () => {
  const scope = { org: 'acme', app: 'sales', env: 'production', installationId: 'sales' };
  function fixture() {
    let allowance: ActivityHistoryAllowance | undefined = {
      maximumDays: 7,
      defaultDays: 7,
      revision: 'free-v2',
    };
    const activity = new ApplicationActivity({
      store: new InMemoryOperationEvidenceStore(),
      epoch: 'fixture-epoch-0001',
      identityKey: 'fixture-key-longer-than-thirty-two-characters',
      allowance: async () => allowance,
    });
    return {
      activity,
      setAllowance: (value: ActivityHistoryAllowance | undefined) => {
        allowance = value;
      },
    };
  }
  it('pins the initial default and does not extend operator retention on upgrade', async () => {
    const { activity, setAllowance } = fixture();
    const free = await activity.settings(scope, true);
    expect(free.projection).toMatchObject({ retentionDays: 7, maximumDays: 7 });
    setAllowance({ maximumDays: 30, defaultDays: 30, revision: 'pro-v2' });
    const paid = await activity.settings(scope, true);
    expect(paid.projection).toMatchObject({ retentionDays: 7, maximumDays: 30 });
    expect(paid.projection.revision).not.toBe(free.projection.revision);
    await expect(
      activity.save(scope, { expectedRevision: free.projection.revision, retentionDays: 7 }),
    ).rejects.toMatchObject({ code: 'activity_conflict' });
  });
  it('enforces verified ceilings and CAS independently of display permissions', async () => {
    const { activity } = fixture();
    const current = (await activity.settings(scope, false)).projection;
    expect(current.canEdit).toBe(false);
    await expect(
      activity.save(scope, { expectedRevision: current.revision, retentionDays: 30 }),
    ).rejects.toMatchObject({ code: 'activity_invalid' });
    const responses = await Promise.allSettled(
      [3, 4].map((retentionDays) =>
        activity.save(scope, { expectedRevision: current.revision, retentionDays }),
      ),
    );
    expect(responses.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
  });
  it('fails closed on absent/invalid allowance and clamps new retention after downgrade', async () => {
    const { activity, setAllowance } = fixture();
    setAllowance({ maximumDays: 30, defaultDays: 30, revision: 'pro-v2' });
    await activity.settings(scope, true);
    setAllowance({ maximumDays: 7, defaultDays: 7, revision: 'free-v2' });
    expect((await activity.settings(scope, true)).projection.retentionDays).toBe(7);
    setAllowance(undefined);
    await expect(activity.settings(scope, true)).rejects.toMatchObject({
      code: 'activity_unavailable',
    });
    setAllowance({ maximumDays: 0, defaultDays: 7, revision: 'corrupt' });
    await expect(activity.settings(scope, true)).rejects.toMatchObject({
      code: 'activity_unavailable',
    });
  });
});
