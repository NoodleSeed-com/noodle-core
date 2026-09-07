import { describe, expect, it } from 'vitest';
import {
  supersededRunIds,
  supersedeWaitingRuns,
} from '../../../scripts/system-release-supersede.mjs';

describe('system release supersession', () => {
  it('cancels only older candidates whose promotion has not started', () => {
    const runs = [
      {
        id: 18,
        runNumber: 18,
        status: 'completed',
        promote: { status: 'completed', startedAt: 'x' },
      },
      { id: 19, runNumber: 19, status: 'waiting', promote: { status: 'waiting', startedAt: null } },
      {
        id: 20,
        runNumber: 20,
        status: 'in_progress',
        promote: { status: 'in_progress', startedAt: 'x' },
      },
      { id: 21, runNumber: 21, status: 'queued', promote: { status: 'queued', startedAt: null } },
      {
        id: 22,
        runNumber: 22,
        status: 'in_progress',
        promote: { status: 'queued', startedAt: null },
      },
    ];
    expect(supersededRunIds(runs, 22)).toEqual([19, 21]);
  });

  it('executes the same GitHub CLI contract used by the workflow', () => {
    const calls: string[][] = [];
    const execute = (args: string[]) => {
      calls.push(args);
      if (args[0] === 'run' && args[1] === 'list') {
        return JSON.stringify([
          { databaseId: 19, number: 19, status: 'waiting' },
          { databaseId: 22, number: 22, status: 'in_progress' },
        ]);
      }
      if (args[0] === 'api') {
        const id = Number(args[1].split('/').at(-2));
        return JSON.stringify({
          jobs: [
            {
              name: 'promote',
              status: id === 19 ? 'waiting' : 'queued',
              started_at: '2026-07-13T00:00:00Z',
              steps: [{ status: 'pending' }],
            },
          ],
        });
      }
      return '';
    };
    expect(
      supersedeWaitingRuns({
        currentRunNumber: 22,
        repository: 'NoodleSeed-com/noodle-borg',
        execute,
      }),
    ).toEqual([19]);
    expect(calls).toContainEqual(['run', 'cancel', '19']);
  });

  it('quiesces release publication before a staged candidate is finally bound', async () => {
    const predecessorSha = 'a'.repeat(40);
    const candidateSha = 'b'.repeat(40);
    const calls: string[][] = [];
    const waits: number[] = [];
    let poll = 0;
    const execute = (args: string[]) => {
      calls.push(args);
      if (args[0] === 'run' && args[1] === 'list') {
        poll += 1;
        return JSON.stringify([
          {
            databaseId: 31,
            number: 31,
            status: poll === 1 ? 'waiting' : 'completed',
            headSha: predecessorSha,
          },
          {
            databaseId: 32,
            number: 32,
            status: poll === 1 ? 'in_progress' : 'completed',
            headSha: predecessorSha,
          },
        ]);
      }
      if (args[0] === 'api') {
        const id = Number(args[1].split('/').at(-2));
        return JSON.stringify({
          jobs: [
            {
              name: 'promote',
              status: id === 31 ? 'waiting' : 'in_progress',
              started_at: '2026-07-29T00:00:00Z',
              steps: [{ status: id === 31 ? 'pending' : 'in_progress' }],
            },
          ],
        });
      }
      return '';
    };

    await expect(
      supersedeWaitingRuns({
        beforeCandidate: true,
        candidateSha,
        repository: 'NoodleSeed-com/noodle-borg',
        execute,
        isAncestor: (older: string, newer: string) =>
          older === predecessorSha && newer === candidateSha,
        wait: async (milliseconds: number) => {
          waits.push(milliseconds);
        },
        pollIntervalMs: 25,
        maxPolls: 2,
      }),
    ).resolves.toEqual({
      cancelled: [31],
      waited: [32],
    });
    expect(calls).toContainEqual(['run', 'cancel', '31']);
    expect(calls).not.toContainEqual(['run', 'cancel', '32']);
    expect(waits).toEqual([25]);
  });

  it('treats GitHub completed-during-cancel as terminal when the run list is stale', async () => {
    const predecessorSha = 'a'.repeat(40);
    const candidateSha = 'b'.repeat(40);
    const calls: string[][] = [];
    const waits: number[] = [];
    const execute = (args: string[]) => {
      calls.push(args);
      if (args[0] === 'run' && args[1] === 'list') {
        return JSON.stringify([
          {
            databaseId: 31115026147,
            number: 422,
            status: 'queued',
            headSha: predecessorSha,
          },
        ]);
      }
      if (args[0] === 'api') return JSON.stringify({ jobs: [] });
      if (args[0] === 'run' && args[1] === 'cancel') {
        throw Object.assign(new Error('Command failed: gh run cancel 31115026147'), {
          stderr: 'Cannot cancel a workflow run that is completed\n',
        });
      }
      return '';
    };

    await expect(
      supersedeWaitingRuns({
        beforeCandidate: true,
        candidateSha,
        repository: 'NoodleSeed-com/noodle-borg',
        execute,
        isAncestor: (older: string, newer: string) =>
          older === predecessorSha && newer === candidateSha,
        wait: async (milliseconds: number) => {
          waits.push(milliseconds);
        },
        pollIntervalMs: 25,
        maxPolls: 2,
      }),
    ).resolves.toEqual({ cancelled: [], waited: [] });
    expect(calls.filter((args) => args[0] === 'run' && args[1] === 'cancel')).toEqual([
      ['run', 'cancel', '31115026147'],
    ]);
    expect(waits).toEqual([]);
  });

  it('fails closed for cancellation errors other than the exact completed response', async () => {
    const predecessorSha = 'a'.repeat(40);
    const candidateSha = 'b'.repeat(40);
    const execute = (args: string[]) => {
      if (args[0] === 'run' && args[1] === 'list') {
        return JSON.stringify([
          {
            databaseId: 61,
            number: 61,
            status: 'queued',
            headSha: predecessorSha,
          },
        ]);
      }
      if (args[0] === 'api') return JSON.stringify({ jobs: [] });
      if (args[0] === 'run' && args[1] === 'cancel') {
        throw Object.assign(new Error('Command failed: gh run cancel 61'), {
          stderr: 'HTTP 503: service unavailable\n',
        });
      }
      return '';
    };

    await expect(
      supersedeWaitingRuns({
        beforeCandidate: true,
        candidateSha,
        repository: 'NoodleSeed-com/noodle-borg',
        execute,
        isAncestor: (older: string, newer: string) =>
          older === predecessorSha && newer === candidateSha,
        wait: async () => undefined,
        pollIntervalMs: 1,
        maxPolls: 1,
      }),
    ).rejects.toThrow(/Command failed: gh run cancel 61/);
  });

  it('fails closed when an active promotion does not settle before candidate binding', async () => {
    const predecessorSha = 'a'.repeat(40);
    const candidateSha = 'b'.repeat(40);
    const execute = (args: string[]) => {
      if (args[0] === 'run' && args[1] === 'list') {
        return JSON.stringify([
          {
            databaseId: 41,
            number: 41,
            status: 'in_progress',
            headSha: predecessorSha,
          },
        ]);
      }
      if (args[0] === 'api') {
        return JSON.stringify({
          jobs: [
            {
              name: 'promote',
              status: 'in_progress',
              started_at: '2026-07-29T00:00:00Z',
              steps: [{ status: 'in_progress' }],
            },
          ],
        });
      }
      return '';
    };

    await expect(async () =>
      supersedeWaitingRuns({
        beforeCandidate: true,
        candidateSha,
        repository: 'NoodleSeed-com/noodle-borg',
        execute,
        isAncestor: (older: string, newer: string) =>
          older === predecessorSha && newer === candidateSha,
        wait: async () => undefined,
        pollIntervalMs: 1,
        maxPolls: 1,
      }),
    ).rejects.toThrow(/active System Release did not settle/i);
  });

  it('waits for a strictly-older active release run to complete before promotion mutates', async () => {
    // Serialized behind the production concurrency group, promote must still not start mutating
    // while an older run's finalize is pushing component tags — the tag re-preflight that follows
    // this wait needs to see final reality (issue #1189).
    const calls: string[][] = [];
    const waits: number[] = [];
    let poll = 0;
    const execute = (args: string[]) => {
      calls.push(args);
      if (args[0] === 'run' && args[1] === 'list') {
        poll += 1;
        return JSON.stringify(
          poll === 1
            ? [{ databaseId: 610, number: 610, status: 'in_progress', headSha: 'a'.repeat(40) }]
            : [],
        );
      }
      if (args[0] === 'api') return JSON.stringify({ jobs: [] });
      return '';
    };

    await expect(
      supersedeWaitingRuns({
        awaitPrior: true,
        currentRunNumber: 611,
        repository: 'NoodleSeed-com/noodle-borg',
        execute,
        wait: async (milliseconds: number) => {
          waits.push(milliseconds);
        },
        pollIntervalMs: 25,
        maxPolls: 2,
      }),
    ).resolves.toEqual({ waited: [610] });
    expect(waits).toEqual([25]);
    expect(calls.filter((args) => args[1] === 'cancel')).toEqual([]);
  });

  it('ignores newer active release runs at the promotion boundary', async () => {
    const calls: string[][] = [];
    const execute = (args: string[]) => {
      calls.push(args);
      if (args[0] === 'run' && args[1] === 'list') {
        return JSON.stringify([
          { databaseId: 612, number: 612, status: 'waiting', headSha: 'b'.repeat(40) },
        ]);
      }
      if (args[0] === 'api') return JSON.stringify({ jobs: [] });
      return '';
    };

    await expect(
      supersedeWaitingRuns({
        awaitPrior: true,
        currentRunNumber: 611,
        repository: 'NoodleSeed-com/noodle-borg',
        execute,
        wait: async () => {
          throw new Error('must not wait on newer runs');
        },
        pollIntervalMs: 1,
        maxPolls: 1,
      }),
    ).resolves.toEqual({ waited: [] });
    expect(calls.filter((args) => args[1] === 'cancel')).toEqual([]);
  });

  it('fails closed when an older release run never completes before promotion', async () => {
    const execute = (args: string[]) => {
      if (args[0] === 'run' && args[1] === 'list') {
        return JSON.stringify([
          { databaseId: 610, number: 610, status: 'in_progress', headSha: 'a'.repeat(40) },
        ]);
      }
      if (args[0] === 'api') return JSON.stringify({ jobs: [] });
      return '';
    };

    await expect(async () =>
      supersedeWaitingRuns({
        awaitPrior: true,
        currentRunNumber: 611,
        repository: 'NoodleSeed-com/noodle-borg',
        execute,
        wait: async () => undefined,
        pollIntervalMs: 1,
        maxPolls: 1,
      }),
    ).rejects.toThrow(/older System Release did not complete before promotion: 610/i);
  });

  it('never cancels an active System Release for a newer source revision', async () => {
    const candidateSha = 'a'.repeat(40);
    const newerSha = 'b'.repeat(40);
    const calls: string[][] = [];
    const execute = (args: string[]) => {
      calls.push(args);
      if (args[0] === 'run' && args[1] === 'list') {
        return JSON.stringify([
          {
            databaseId: 51,
            number: 51,
            status: 'waiting',
            headSha: newerSha,
          },
        ]);
      }
      if (args[0] === 'api') {
        return JSON.stringify({
          jobs: [
            {
              name: 'promote',
              status: 'waiting',
              started_at: '2026-07-29T00:00:00Z',
              steps: [{ status: 'pending' }],
            },
          ],
        });
      }
      return '';
    };
    const isAncestor = (older: string, newer: string) =>
      older === candidateSha && newer === newerSha;

    await expect(async () =>
      supersedeWaitingRuns({
        beforeCandidate: true,
        candidateSha,
        repository: 'NoodleSeed-com/noodle-borg',
        execute,
        isAncestor,
        wait: async () => undefined,
        pollIntervalMs: 1,
        maxPolls: 1,
      }),
    ).rejects.toThrow(/newer active System Release/i);
    expect(calls).not.toContainEqual(['run', 'cancel', '51']);
  });
});
