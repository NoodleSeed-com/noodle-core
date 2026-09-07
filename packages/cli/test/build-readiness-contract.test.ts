import { describe, expect, it } from 'vitest';

import {
  type BuildReadinessSnapshot,
  type BuildRunState,
  parseBuildReadinessSnapshot,
  transitionBuildRun,
} from '../src/plugin-mode/build-readiness-contract.js';

const NOW = '2026-07-18T02:00:00.000Z';
const LATER = '2026-07-18T02:00:01.000Z';
const HANDLE = 'BhmB7x7_MxWBwY2g0ER6hA';
const DIGEST = `sha256:${'a'.repeat(64)}`;

function run(overrides: Partial<BuildRunState> = {}): BuildRunState {
  return {
    runId: 'run_BhmB7x7_MxWBwY2g0ER6hA',
    stage: 'validate',
    status: 'running',
    sourceFingerprint: DIGEST,
    startedAt: NOW,
    heartbeatAt: NOW,
    ...overrides,
  };
}

function snapshot(overrides: Partial<BuildReadinessSnapshot> = {}): BuildReadinessSnapshot {
  return {
    schemaVersion: 1,
    workspaceHandle: HANDLE,
    workspaceDigest: DIGEST,
    updatedAt: NOW,
    runs: [run()],
    ...overrides,
  };
}

describe('build readiness contract', () => {
  it('accepts one bounded sanitized snapshot', () => {
    expect(parseBuildReadinessSnapshot(snapshot())).toEqual(snapshot());
  });

  it.each([
    ['absolute workspace path', { workspaceDigest: '/Users/person/project' }],
    ['invalid workspace handle', { workspaceHandle: '../project' }],
    ['unknown top-level field', { rawStdout: 'token' }],
    ['oversized run history', { runs: Array.from({ length: 65 }, () => run()) }],
  ])('rejects %s', (_label, change) => {
    expect(() => parseBuildReadinessSnapshot({ ...snapshot(), ...change })).toThrow();
  });

  it('rejects secret-shaped persisted finding content', () => {
    expect(() =>
      parseBuildReadinessSnapshot({
        ...snapshot(),
        findings: [
          {
            code: 'validation_failed',
            severity: 'error',
            message: 'Authorization: Bearer secret-value',
          },
        ],
      }),
    ).toThrow(/secret|sensitive/i);
  });

  it('allows legal running terminal transitions', () => {
    expect(
      transitionBuildRun(run(), {
        status: 'succeeded',
        heartbeatAt: LATER,
        finishedAt: LATER,
      }),
    ).toMatchObject({ status: 'succeeded', heartbeatAt: LATER, finishedAt: LATER });
  });

  it('prevents terminal runs from returning to running', () => {
    const succeeded = run({ status: 'succeeded', finishedAt: LATER, heartbeatAt: LATER });
    expect(() => transitionBuildRun(succeeded, { status: 'running', heartbeatAt: LATER })).toThrow(
      /terminal/i,
    );
  });

  it('requires a finish timestamp for every terminal state', () => {
    expect(() => transitionBuildRun(run(), { status: 'failed', heartbeatAt: LATER })).toThrow(
      /finishedAt/i,
    );
  });

  it('never permits a cancelled run to become successful later', () => {
    const cancelled = run({ status: 'cancelled', finishedAt: LATER, heartbeatAt: LATER });
    expect(() =>
      transitionBuildRun(cancelled, {
        status: 'succeeded',
        heartbeatAt: LATER,
        finishedAt: LATER,
      }),
    ).toThrow(/terminal/i);
  });
});
