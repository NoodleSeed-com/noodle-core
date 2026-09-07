import { describe, expect, it } from 'vitest';

import { assessPostgresRun } from '../../../scripts/assert-postgres-suites-ran.mjs';
import { gateSpawnOptions, postgresPlan } from '../../../scripts/dev-ready.mjs';
import {
  installHint,
  nextFreePort,
  resolvePgBin,
  startOnFirstFreePort,
} from '../../../scripts/local-postgres.mjs';

function report(files: Array<{ name: string; statuses: string[] }>) {
  return {
    testResults: files.map((file) => ({
      name: file.name,
      assertionResults: file.statuses.map((status, index) => ({
        status,
        title: `case ${index}`,
      })),
    })),
  };
}

describe('assert-postgres-suites-ran', () => {
  it('accepts a run where postgres suites executed and passed', () => {
    const outcome = assessPostgresRun(
      report([
        {
          name: 'packages/service/test/billing-store-postgres.test.ts',
          statuses: ['passed', 'passed'],
        },
        { name: 'packages/knowledge/test/postgres-revision-store.test.ts', statuses: ['passed'] },
        { name: 'packages/cli/test/features.test.ts', statuses: ['passed'] },
      ]),
    );
    expect(outcome.ok).toBe(true);
    // Only the two Postgres files count as executed; the plain unit file is out of scope.
    expect(outcome.executed).toBe(2);
  });

  it('rejects a run where every postgres suite silently skipped', () => {
    const outcome = assessPostgresRun(
      report([
        {
          name: 'packages/service/test/billing-store-postgres.test.ts',
          statuses: ['skipped', 'skipped'],
        },
        { name: 'packages/cli/test/features.test.ts', statuses: ['passed'] },
      ]),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('skipped');
  });

  it('rejects a run containing no postgres suites at all', () => {
    const outcome = assessPostgresRun(
      report([{ name: 'packages/cli/test/features.test.ts', statuses: ['passed'] }]),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('no Postgres');
  });

  it('ignores postgres appearing only in a directory name', () => {
    // A worktree literally named "postgres-determinism" must not make every file count.
    const outcome = assessPostgresRun(
      report([
        {
          name: '/w/postgres-determinism/packages/cli/test/features.test.ts',
          statuses: ['passed'],
        },
      ]),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('no Postgres');
  });

  it('treats pending and todo like skips, not executions', () => {
    const outcome = assessPostgresRun(
      report([
        {
          name: 'packages/service/test/oauth-store-postgres.test.ts',
          statuses: ['pending', 'todo'],
        },
      ]),
    );
    expect(outcome.ok).toBe(false);
  });
});

describe('local-postgres helpers', () => {
  it('resolves the pg bin dir from brew when the probe finds one', () => {
    const bin = resolvePgBin({
      brewPrefix: () => '/opt/homebrew/opt/postgresql@16',
      binaryExists: (path: string) => path === '/opt/homebrew/opt/postgresql@16/bin/initdb',
    });
    expect(bin).toBe('/opt/homebrew/opt/postgresql@16/bin');
  });

  it('returns undefined when no postgres installation is found', () => {
    const bin = resolvePgBin({
      brewPrefix: () => undefined,
      binaryExists: () => false,
    });
    expect(bin).toBeUndefined();
  });

  it('scans past busy ports deterministically', () => {
    const busy = new Set([55432, 55433]);
    expect(nextFreePort(55432, (port: number) => busy.has(port))).toBe(55434);
  });

  it('names the install command in the missing-binaries hint', () => {
    expect(installHint()).toContain('postgresql@16');
  });
});

describe('dev-ready postgres plan', () => {
  it('reuses an externally provided database and syncs both env names', () => {
    const plan = postgresPlan({ DATABASE_URL_TEST: 'postgres://x/db' });
    expect(plan.mode).toBe('external');
    expect(plan.env.DATABASE_URL).toBe('postgres://x/db');
    expect(plan.env.DATABASE_URL_TEST).toBe('postgres://x/db');
  });

  it('syncs the legacy name onto the canonical one', () => {
    const plan = postgresPlan({ DATABASE_URL: 'postgres://y/db' });
    expect(plan.mode).toBe('external');
    expect(plan.env.DATABASE_URL_TEST).toBe('postgres://y/db');
  });

  it('provisions a throwaway cluster when neither name is set', () => {
    expect(postgresPlan({}).mode).toBe('provision');
  });

  it('allows an explicit, loud opt-out only via the escape env', () => {
    expect(postgresPlan({ NOODLE_ALLOW_POSTGRES_SKIP: '1' }).mode).toBe('skip-allowed');
  });
});

describe('dev-ready gate env application', () => {
  it('applies a gate-declared env on top of the process env', () => {
    const options = gateSpawnOptions({ CI: 'true' }, { PATH: '/bin', HOME: '/h' });
    expect(options.env.CI).toBe('true');
    expect(options.env.PATH).toBe('/bin');
  });

  it('passes the process env through unchanged when a gate declares none', () => {
    const options = gateSpawnOptions(undefined, { PATH: '/bin' });
    expect(options.env.PATH).toBe('/bin');
  });
});

// `nextFreePort` probed for a free port, then ran initdb (seconds), then bound — a TOCTOU window
// wide enough that two concurrent `dev:ready` gates picked the same port and corrupted each
// other's run (observed 2026-08-17: two worktrees' Postgres suites failed in beforeEach, and both
// passed alone immediately after). The bind itself must be the test, with a bounded retry.
describe('concurrent cluster startup', () => {
  it('advances past a port that was taken between probe and bind', () => {
    const taken = new Set([55432, 55433]);
    const attempted: number[] = [];
    const port = startOnFirstFreePort(55432, (candidate: number) => {
      attempted.push(candidate);
      if (taken.has(candidate)) throw new Error(`port ${candidate} already in use`);
    });
    expect(port).toBe(55434);
    expect(attempted).toEqual([55432, 55433, 55434]);
  });

  it('succeeds immediately when the first port binds', () => {
    expect(startOnFirstFreePort(55500, () => undefined)).toBe(55500);
  });

  it('gives up with a clear error rather than scanning forever', () => {
    expect(() =>
      startOnFirstFreePort(55432, () => {
        throw new Error('always busy');
      }),
    ).toThrow(/could not bind/i);
  });
});
