import { describe, expect, it } from 'vitest';

import { evaluatePushRefs, parsePushRefs } from '../../../scripts/guard-queued-branch.mjs';
import { fetchQueuedPrForBranch } from '../../../scripts/lib/pr-queue-status.mjs';

const SHA = 'a'.repeat(40);
const ZERO = '0'.repeat(40);

describe('guard-queued-branch', () => {
  it('parses pre-push ref lines into branch pushes, skipping deletes and tags', () => {
    const refs = parsePushRefs(
      [
        `refs/heads/feat/x ${SHA} refs/heads/feat/x ${SHA}`,
        `(delete) ${ZERO} refs/heads/feat/gone ${SHA}`,
        `refs/tags/v1.0.0 ${SHA} refs/tags/v1.0.0 ${ZERO}`,
        '',
      ].join('\n'),
    );
    expect(refs).toEqual([{ localRef: 'refs/heads/feat/x', branch: 'feat/x', isDelete: false }]);
  });

  it('blocks a push when the branch has a PR actively in the merge queue', () => {
    const { blocked, warnings } = evaluatePushRefs(
      [{ localRef: 'refs/heads/feat/x', branch: 'feat/x', isDelete: false }],
      () => ({ number: 42, queueState: 'AWAITING_CHECKS' }),
    );
    expect(blocked).toEqual([{ branch: 'feat/x', pr: 42 }]);
    expect(warnings).toEqual([]);
  });

  it('allows a push when the branch has no queued PR', () => {
    const { blocked, warnings } = evaluatePushRefs(
      [{ localRef: 'refs/heads/feat/x', branch: 'feat/x', isDelete: false }],
      () => null,
    );
    expect(blocked).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('fails open with a warning when the queue lookup errors (gh missing, auth, network)', () => {
    const { blocked, warnings } = evaluatePushRefs(
      [{ localRef: 'refs/heads/feat/x', branch: 'feat/x', isDelete: false }],
      () => {
        throw new Error('gh: command not found');
      },
    );
    expect(blocked).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('feat/x');
    expect(warnings[0]).toContain('allowing push');
  });

  it('fetchQueuedPrForBranch returns the queued PR from the GraphQL response', () => {
    const exec = () =>
      JSON.stringify({
        data: {
          repository: {
            pullRequests: {
              nodes: [
                { number: 7, mergeQueueEntry: null },
                { number: 42, mergeQueueEntry: { state: 'AWAITING_CHECKS', position: 1 } },
              ],
            },
          },
        },
      });
    expect(fetchQueuedPrForBranch('feat/x', exec)).toEqual({
      number: 42,
      queueState: 'AWAITING_CHECKS',
    });
  });

  it('fetchQueuedPrForBranch returns null when no open PR is queued', () => {
    const exec = () =>
      JSON.stringify({
        data: { repository: { pullRequests: { nodes: [{ number: 7, mergeQueueEntry: null }] } } },
      });
    expect(fetchQueuedPrForBranch('feat/x', exec)).toBeNull();
  });
});
