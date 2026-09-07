import { describe, expect, it } from 'vitest';

import { planQueueRecovery } from '../../../scripts/merge-queue-recovery.mjs';

describe('merge queue recovery planning', () => {
  it('re-arms auto-merge once for confirmed transient workflow conclusions', () => {
    for (const conclusion of ['cancelled', 'timed_out', 'startup_failure', 'stale']) {
      expect(planQueueRecovery({ conclusion, alreadyRetried: false })).toEqual({
        action: 'requeue',
        reason: `transient:${conclusion}`,
      });
    }
  });

  it('notifies without requeueing a deterministic failure', () => {
    expect(planQueueRecovery({ conclusion: 'failure', alreadyRetried: false })).toEqual({
      action: 'notify-blocked',
      reason: 'validation-failure',
    });
  });

  it('never retries the same PR head twice', () => {
    expect(planQueueRecovery({ conclusion: 'timed_out', alreadyRetried: true })).toEqual({
      action: 'notify-blocked',
      reason: 'transient-retry-exhausted',
    });
  });

  it('does nothing for successful or neutral conclusions', () => {
    for (const conclusion of ['success', 'skipped', 'neutral']) {
      expect(planQueueRecovery({ conclusion, alreadyRetried: false }).action).toBe('none');
    }
  });
});
