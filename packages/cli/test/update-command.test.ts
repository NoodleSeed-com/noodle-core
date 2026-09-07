import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runUpdateCommand, type UpdateCommandDeps } from '../src/commands/update-ops.js';
import { CLI_PACKAGE_NAME, currentCliVersion, GLOBAL_UPDATE_COMMAND } from '../src/update.js';
import type { NoodleBinaryInspection } from '../src/update-binary.js';

/**
 * `noodle update` command behavior (#242): human flows, the --check/--yes/--repair/--json
 * agent contract with its exact JSON shapes, and the stable exit codes
 * (0 ok · 10 update available · 11 update failed · 12 repair required ·
 * 13 unsafe conflicting binary · 14 network inconclusive).
 */

const BIN = '/prefix/bin/noodle';
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ spawn: spawnMock }));

afterEach(() => {
  spawnMock.mockReset();
  vi.restoreAllMocks();
});

function inspection(status: NoodleBinaryInspection['status']): NoodleBinaryInspection {
  return { expectedBinDir: '/prefix/bin', binPath: BIN, status };
}

interface Harness {
  readonly out: string[];
  readonly err: string[];
  readonly unlinked: string[];
  readonly confirms: string[];
  installs: number;
  deps: UpdateCommandDeps;
}

function harness(
  overrides: Partial<{
    latest: string | undefined; // undefined → registry unreachable
    status: NoodleBinaryInspection['status'];
    interactive: boolean;
    confirmAnswer: boolean;
    installExit: number;
    env: NodeJS.ProcessEnv;
    unlinkError: Error;
  }> = {},
): Harness {
  const h: Harness = { out: [], err: [], unlinked: [], confirms: [], installs: 0, deps: {} };
  const latest = 'latest' in overrides ? overrides.latest : '99.0.0';
  h.deps = {
    env: overrides.env ?? {},
    fetchImpl: (async () => {
      if (latest === undefined) throw new Error('offline');
      return new Response(JSON.stringify({ version: latest }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
    inspectImpl: () => inspection(overrides.status ?? { kind: 'none' }),
    installImpl: async () => {
      h.installs += 1;
      return overrides.installExit ?? 0;
    },
    unlinkImpl: (path: string) => {
      if (overrides.unlinkError) throw overrides.unlinkError;
      h.unlinked.push(path);
    },
    confirmImpl: async (message: string) => {
      h.confirms.push(message);
      return overrides.confirmAnswer ?? true;
    },
    interactive: overrides.interactive ?? false,
    log: (line: string) => h.out.push(line),
    logError: (line: string) => h.err.push(line),
  };
  return h;
}

function lastJson(h: Harness): unknown {
  return JSON.parse(h.out[h.out.length - 1] ?? 'null');
}

describe('noodle update — human flows', () => {
  it('reports up to date without prompting or installing', async () => {
    const h = harness({ latest: '0.0.1', interactive: true });
    expect(await runUpdateCommand([], h.deps)).toBe(0);
    expect(h.out.join('\n')).toContain('Noodle CLI is up to date.');
    expect(h.confirms).toEqual([]);
    expect(h.installs).toBe(0);
  });

  it('prompts "Update now?" and installs on yes', async () => {
    const h = harness({ interactive: true, confirmAnswer: true });
    expect(await runUpdateCommand([], h.deps)).toBe(0);
    expect(h.out.join('\n')).toContain(
      `Noodle CLI update available: ${currentCliVersion()} -> 99.0.0`,
    );
    expect(h.confirms.length).toBe(1);
    expect(h.confirms[0]).toContain('Update now?');
    expect(h.installs).toBe(1);
  });

  it('exits 0 and installs nothing when the user declines', async () => {
    const h = harness({ interactive: true, confirmAnswer: false });
    expect(await runUpdateCommand([], h.deps)).toBe(0);
    expect(h.installs).toBe(0);
    expect(h.unlinked).toEqual([]);
  });

  it('refuses an unsafe conflicting binary with the path and manual commands (exit 13)', async () => {
    const h = harness({ interactive: true, status: { kind: 'unsafe', reason: 'unknown file' } });
    expect(await runUpdateCommand([], h.deps)).toBe(13);
    const printed = h.err.join('\n');
    expect(printed).toContain('is not owned by this install, so I will not overwrite it');
    expect(printed).toContain(BIN);
    expect(printed).toContain(`rm ${BIN}`);
    expect(printed).toContain(GLOBAL_UPDATE_COMMAND);
    expect(printed).not.toContain('--force');
    expect(h.confirms).toEqual([]);
    expect(h.installs).toBe(0);
    expect(h.unlinked).toEqual([]);
  });

  it('asks "Repair and update now?" for a safe blocked binary and repairs on yes', async () => {
    const h = harness({
      interactive: true,
      confirmAnswer: true,
      status: { kind: 'safe-repair', reason: 'broken symlink' },
    });
    expect(await runUpdateCommand([], h.deps)).toBe(0);
    expect(h.confirms.length).toBe(1);
    expect(h.confirms[0]).toContain('Repair and update now?');
    expect(h.unlinked).toEqual([BIN]);
    expect(h.installs).toBe(1);
  });

  it('never prompts under NOODLE_NO_PROMPT even on a TTY; prints the plan and exits 0', async () => {
    const h = harness({ interactive: true, env: { NOODLE_NO_PROMPT: '1' } });
    expect(await runUpdateCommand([], h.deps)).toBe(0);
    expect(h.confirms).toEqual([]);
    expect(h.installs).toBe(0);
    expect(h.out.join('\n')).toContain('noodle update --yes');
  });

  it('prints an informational plan and exits 0 when non-interactive without flags', async () => {
    const h = harness({ interactive: false });
    expect(await runUpdateCommand([], h.deps)).toBe(0);
    expect(h.confirms).toEqual([]);
    expect(h.installs).toBe(0);
    expect(h.out.join('\n')).toContain('noodle update --yes');
  });
});

describe('noodle update --check', () => {
  it('emits the exact JSON shape and exits 10 when an update is available', async () => {
    const h = harness();
    expect(await runUpdateCommand(['--check', '--json'], h.deps)).toBe(10);
    expect(lastJson(h)).toEqual({
      ok: true,
      data: {
        package: CLI_PACKAGE_NAME,
        installed: currentCliVersion(),
        latest: '99.0.0',
        updateAvailable: true,
        recommendedCommand: 'noodle update --yes --json',
        repairRequired: false,
        repairSafe: false,
      },
    });
    expect(h.installs).toBe(0);
    expect(h.confirms).toEqual([]);
  });

  it('emits updateAvailable:false and exits 0 when current', async () => {
    const h = harness({ latest: '0.0.1' });
    expect(await runUpdateCommand(['--check', '--json'], h.deps)).toBe(0);
    expect(lastJson(h)).toEqual({
      ok: true,
      data: {
        package: CLI_PACKAGE_NAME,
        installed: currentCliVersion(),
        latest: '0.0.1',
        updateAvailable: false,
        repairRequired: false,
        repairSafe: false,
      },
    });
  });

  it('reports a safe blocked binary and recommends the repair command', async () => {
    const h = harness({ status: { kind: 'safe-repair', reason: 'stale symlink' } });
    expect(await runUpdateCommand(['--check', '--json'], h.deps)).toBe(10);
    expect(lastJson(h)).toEqual({
      ok: true,
      data: {
        package: CLI_PACKAGE_NAME,
        installed: currentCliVersion(),
        latest: '99.0.0',
        updateAvailable: true,
        recommendedCommand: 'noodle update --yes --repair --json',
        repairRequired: true,
        repairSafe: true,
      },
    });
  });

  it('exits 14 with a network_inconclusive error when the registry is unreachable', async () => {
    const h = harness({ latest: undefined });
    expect(await runUpdateCommand(['--check', '--json'], h.deps)).toBe(14);
    expect(lastJson(h)).toMatchObject({
      ok: false,
      error: {
        code: 'network_inconclusive',
        retryable: true,
        detail: { package: CLI_PACKAGE_NAME, installed: currentCliVersion() },
      },
    });
    expect(h.installs).toBe(0);
  });

  it('prints a human plan and exits 10 without --json', async () => {
    const h = harness();
    expect(await runUpdateCommand(['--check'], h.deps)).toBe(10);
    const printed = h.out.join('\n');
    expect(printed).toContain(currentCliVersion());
    expect(printed).toContain('99.0.0');
    expect(h.installs).toBe(0);
  });
});

describe('noodle update --yes', () => {
  it('installs without prompting and emits the exact success JSON', async () => {
    const h = harness({ interactive: true });
    expect(await runUpdateCommand(['--yes', '--json'], h.deps)).toBe(0);
    expect(h.confirms).toEqual([]);
    expect(h.installs).toBe(1);
    expect(lastJson(h)).toEqual({
      ok: true,
      data: {
        package: CLI_PACKAGE_NAME,
        installedBefore: currentCliVersion(),
        installedAfter: '99.0.0',
        command: GLOBAL_UPDATE_COMMAND,
      },
    });
  });

  it('exits 0 and reports current without installing when already up to date', async () => {
    const h = harness({ latest: '0.0.1' });
    expect(await runUpdateCommand(['--yes', '--json'], h.deps)).toBe(0);
    expect(h.installs).toBe(0);
    expect(lastJson(h)).toMatchObject({ ok: true, data: { updateAvailable: false } });
  });

  it('exits 11 with update_failed JSON when npm install fails', async () => {
    const h = harness({ installExit: 1 });
    expect(await runUpdateCommand(['--yes', '--json'], h.deps)).toBe(11);
    // A failed install still reports that a new version IS available and how to recover, rather
    // than a bare exit code (the reported "package already exists" case).
    expect(lastJson(h)).toMatchObject({
      ok: false,
      error: {
        code: 'update_failed',
        detail: {
          updateAvailable: true,
          recommendedCommand: expect.stringContaining('--repair'),
        },
      },
    });
  });

  it.each([
    'spawn-error',
    'nonzero-close',
  ] as const)('suppresses child diagnostics in JSON mode on %s', async (failureMode) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        if (failureMode === 'spawn-error') {
          child.emit('error', new Error('PRIVATE npm spawn diagnostic'));
        } else {
          child.stdout.emit('data', Buffer.from('PRIVATE npm stdout diagnostic'));
          child.stderr.emit('data', Buffer.from('PRIVATE npm stderr diagnostic'));
          child.emit('close', 7);
        }
      });
      return child;
    });
    const out: string[] = [];
    const err: string[] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(
      await runUpdateCommand(['--yes', '--json'], {
        env: {},
        fetchImpl: (async () => Response.json({ version: '99.0.0' })) as unknown as typeof fetch,
        inspectImpl: () => inspection({ kind: 'none' }),
        interactive: false,
        log: (line) => out.push(line),
        logError: (line) => err.push(line),
      }),
    ).toBe(11);

    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0] ?? 'null')).toMatchObject({
      ok: false,
      error: { code: 'update_failed', detail: { installExitCode: expect.any(Number) } },
    });
    expect(out.join('\n')).not.toContain('PRIVATE');
    expect(err).toEqual([]);
    expect(consoleError).not.toHaveBeenCalled();
    expect(stderrWrite).not.toHaveBeenCalled();
  });

  it('exits 12 with repair_required JSON when a safe repair is needed but --repair was not given', async () => {
    const h = harness({ status: { kind: 'safe-repair', reason: 'stale symlink' } });
    expect(await runUpdateCommand(['--yes', '--json'], h.deps)).toBe(12);
    expect(lastJson(h)).toMatchObject({
      ok: false,
      error: {
        code: 'repair_required',
        detail: {
          path: BIN,
          repairRequired: true,
          repairSafe: true,
          recommendedCommand: 'noodle update --yes --repair --json',
        },
      },
    });
    expect(h.unlinked).toEqual([]);
    expect(h.installs).toBe(0);
  });

  it('exits 13 with the exact conflicting_binary JSON for an unsafe binary', async () => {
    const h = harness({ status: { kind: 'unsafe', reason: 'unknown file' } });
    expect(await runUpdateCommand(['--yes', '--json'], h.deps)).toBe(13);
    expect(lastJson(h)).toMatchObject({
      ok: false,
      error: {
        code: 'conflicting_binary',
        message: 'Existing noodle binary is not known to be owned by @noodleseed/one.',
        detail: {
          package: CLI_PACKAGE_NAME,
          path: BIN,
          repairRequired: true,
          repairSafe: false,
          manualCommands: [`rm ${BIN}`, GLOBAL_UPDATE_COMMAND],
        },
      },
    });
    expect(h.unlinked).toEqual([]);
    expect(h.installs).toBe(0);
    expect(h.confirms).toEqual([]);
  });

  it('exits 14 when the registry is unreachable, before any install', async () => {
    const h = harness({ latest: undefined });
    expect(await runUpdateCommand(['--yes', '--json'], h.deps)).toBe(14);
    expect(h.installs).toBe(0);
  });
});

describe('noodle update --repair', () => {
  it('with --yes: performs exactly the one expected unlink, then installs, and reports it', async () => {
    const h = harness({ status: { kind: 'safe-repair', reason: 'broken symlink' } });
    expect(await runUpdateCommand(['--yes', '--repair', '--json'], h.deps)).toBe(0);
    expect(h.unlinked).toEqual([BIN]); // exactly one unlink, exactly this path
    expect(h.installs).toBe(1);
    expect(lastJson(h)).toEqual({
      ok: true,
      data: {
        package: CLI_PACKAGE_NAME,
        installedBefore: currentCliVersion(),
        installedAfter: '99.0.0',
        command: GLOBAL_UPDATE_COMMAND,
        repairPerformed: true,
        repairedPath: BIN,
      },
    });
    expect(h.err).toEqual([]);
  });

  it('with --yes: refuses an unsafe binary (exit 13) and unlinks nothing', async () => {
    const h = harness({ status: { kind: 'unsafe', reason: 'unknown file' } });
    expect(await runUpdateCommand(['--yes', '--repair', '--json'], h.deps)).toBe(13);
    expect(h.unlinked).toEqual([]);
    expect(h.installs).toBe(0);
  });

  it('without --yes on a TTY: confirms before repairing', async () => {
    const h = harness({
      interactive: true,
      confirmAnswer: true,
      status: { kind: 'safe-repair', reason: 'broken symlink' },
    });
    expect(await runUpdateCommand(['--repair'], h.deps)).toBe(0);
    expect(h.confirms.length).toBe(1);
    expect(h.confirms[0]).toContain('Repair and update now?');
    expect(h.unlinked).toEqual([BIN]);
    expect(h.installs).toBe(1);
  });

  it('without --yes non-interactively: exits 12 and touches nothing', async () => {
    const h = harness({ status: { kind: 'safe-repair', reason: 'broken symlink' } });
    expect(await runUpdateCommand(['--repair', '--json'], h.deps)).toBe(12);
    expect(h.unlinked).toEqual([]);
    expect(h.installs).toBe(0);
  });

  it('does not unlink anything when no repair is needed', async () => {
    const h = harness();
    expect(await runUpdateCommand(['--yes', '--repair', '--json'], h.deps)).toBe(0);
    expect(h.unlinked).toEqual([]);
    expect(h.installs).toBe(1);
    expect(lastJson(h)).toEqual({
      ok: true,
      data: {
        package: CLI_PACKAGE_NAME,
        installedBefore: currentCliVersion(),
        installedAfter: '99.0.0',
        command: GLOBAL_UPDATE_COMMAND,
      },
    });
  });

  it('reports repair_failed (exit 11) when the unlink itself fails', async () => {
    const h = harness({
      status: { kind: 'safe-repair', reason: 'broken symlink' },
      unlinkError: new Error('EACCES'),
    });
    expect(await runUpdateCommand(['--yes', '--repair', '--json'], h.deps)).toBe(11);
    expect(lastJson(h)).toMatchObject({ ok: false, error: { code: 'repair_failed' } });
    expect(h.installs).toBe(0);
  });
});

describe('noodle update --check --json — unsafe binary honesty', () => {
  // CodeRabbit finding on #280: the check must never recommend a command that
  // is guaranteed to exit 13; unsafe cases get manualCommands at check time.
  it('omits recommendedCommand and carries manualCommands when the binary is unsafe', async () => {
    const h = harness({ status: { kind: 'unsafe', reason: 'unknown file' } });
    const code = await runUpdateCommand(['--check', '--json'], h.deps);
    expect(code).toBe(10);
    const body = lastJson(h) as Record<string, unknown>;
    const data = body.data as Record<string, unknown>;
    expect(data.updateAvailable).toBe(true);
    expect(data.repairRequired).toBe(true);
    expect(data.repairSafe).toBe(false);
    expect(data.recommendedCommand).toBeUndefined();
    expect(data.manualCommands).toEqual([
      `rm ${(data as { path?: string }).path}`,
      'npm install -g @noodleseed/one@latest',
    ]);
    expect(typeof data.path).toBe('string');
  });
});
