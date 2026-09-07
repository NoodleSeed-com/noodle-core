import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readConfig, writeConfig } from '../src/config.js';
import { run } from '../src/index.js';
import { maybeCheckForCliUpdate, type UpdateCheckInput } from '../src/update-check.js';

/**
 * The passive post-command update check (#242 / ADR 0124): a default interactive
 * "Update now?" prompt on human TTYs (Enter = yes, "n" snoozes 24h), a plain notice
 * when a prompt is not possible, and the NOODLE_UPDATE_MODE / NOODLE_NO_PROMPT /
 * NOODLE_UPDATE_JSON automation contract. A failed or declined check must never
 * change the outcome of the user's actual command.
 */
describe('noodle CLI update + skills checks', () => {
  let home: string;
  let outSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  const stderrTtyDescriptor = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'noodle-update-'));
    outSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    outSpy.mockRestore();
    errSpy.mockRestore();
    vi.unstubAllGlobals();
    if (stderrTtyDescriptor !== undefined) {
      Object.defineProperty(process.stderr, 'isTTY', stderrTtyDescriptor);
    }
    rmSync(home, { recursive: true, force: true });
  });

  function setInteractive(value: boolean): void {
    Object.defineProperty(process.stderr, 'isTTY', { value, configurable: true });
  }

  function stubLatestVersion(version: string, skillsVersion = '0.1.0'): ReturnType<typeof vi.fn> {
    const fetchImpl = vi.fn(async (url: string) => {
      const isSkills = String(url).includes('agent-kit');
      return new Response(JSON.stringify({ version: isSkills ? skillsVersion : version }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchImpl);
    return fetchImpl;
  }

  /** Unit-level harness: full injection so no real TTY, npm, or registry is touched. */
  function checkInput(
    overrides: Partial<UpdateCheckInput> & {
      latest?: string;
      confirmAnswer?: boolean;
    } = {},
  ): {
    input: UpdateCheckInput;
    fetchImpl: ReturnType<typeof vi.fn>;
    runUpdate: ReturnType<typeof vi.fn>;
    confirms: string[];
  } {
    const confirms: string[] = [];
    const latest = overrides.latest ?? '99.0.0';
    const fetchImpl = vi.fn(async (url: string) => {
      const isSkills = String(url).includes('agent-kit');
      return new Response(JSON.stringify({ version: isSkills ? '0.1.0' : latest }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const runUpdate = vi.fn(async () => 0);
    const input: UpdateCheckInput = {
      command: 'whoami',
      env: {},
      home,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      runUpdate,
      confirmImpl: async (message: string) => {
        confirms.push(message);
        return overrides.confirmAnswer ?? true;
      },
      promptCapable: true,
      noticeCapable: true,
      ...overrides,
    };
    return { input, fetchImpl, runUpdate, confirms };
  }

  const printedErr = () => errSpy.mock.calls.map((c) => String(c[0])).join('\n');

  // -------------------------------------------------------------------------
  // Notice fallback (stderr TTY without an interactive stdin) — legacy behavior
  // -------------------------------------------------------------------------

  it('prints a notice recommending `noodle update` when npm latest is newer (no prompt possible)', async () => {
    setInteractive(true);
    const fetchImpl = stubLatestVersion('99.0.0');
    expect(await run(['whoami'], {}, home)).toBe(0);
    const printed = printedErr();
    expect(printed).toContain('A newer Noodle CLI is available:');
    expect(printed).toContain('noodle update');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://registry.npmjs.org/%40noodleseed%2Fone/latest',
      expect.objectContaining({ headers: { accept: 'application/json' } }),
    );
    expect(readConfig(home).updateCheck?.latestVersion).toBe('99.0.0');
  });

  it('skips notice-mode update checks when recently checked', async () => {
    setInteractive(true);
    const fetchImpl = stubLatestVersion('99.0.0');
    await run(['target', 'set', '--runtime', 'cloud'], {}, home);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // CLI + skills check share one notifier pass
    errSpy.mockClear();
    await run(['whoami'], {}, home);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // recently checked → skipped both
    expect(errSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('A newer Noodle CLI is available'),
    );
  });

  it('skips update checks when disabled, in CI, noninteractive, or version', async () => {
    const fetchImpl = stubLatestVersion('99.0.0');
    setInteractive(true);
    expect(await run(['whoami'], { NOODLE_DISABLE_UPDATE_CHECK: '1' }, home)).toBe(0);
    expect(await run(['whoami'], { CI: 'true' }, home)).toBe(0);
    setInteractive(false);
    expect(await run(['whoami'], {}, home)).toBe(0);
    setInteractive(true);
    expect(await run(['--version'], {}, home)).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('skips the check for help, bare, update, and --json invocations', async () => {
    const skipped = [
      checkInput({ command: 'help' }),
      checkInput({ command: undefined }),
      checkInput({ command: 'update' }),
      checkInput({ command: 'status', argv: ['--json'] }),
    ];
    for (const { input } of skipped) await maybeCheckForCliUpdate(input);
    for (const { fetchImpl } of skipped) expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('prompts to refresh skills when agent-kit latest is newer than the bundled snapshot', async () => {
    setInteractive(true);
    const fetchImpl = vi.fn(async (url: string) => {
      const isSkills = String(url).includes('agent-kit');
      return new Response(JSON.stringify({ version: isSkills ? '99.0.0' : '0.0.1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchImpl);
    expect(await run(['whoami'], {}, home)).toBe(0);
    const printed = printedErr();
    expect(printed).toContain('Skills updated in v99.0.0');
    expect(printed).toContain('noodle agents setup --write');
    // No CLI notice — CLI latest (0.0.1) is older than the installed CLI.
    expect(printed).not.toContain('A newer Noodle CLI is available');
    expect(readConfig(home).updateCheck?.skillsLatestVersion).toBe('99.0.0');
  });

  it('ignores update check network failures', async () => {
    setInteractive(true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('registry unavailable');
      }),
    );
    expect(await run(['whoami'], {}, home)).toBe(0);
    expect(printedErr()).not.toContain('registry unavailable');
  });

  // -------------------------------------------------------------------------
  // Default interactive prompt (full TTY)
  // -------------------------------------------------------------------------

  it('prompts "Update now?" on a full TTY and runs the update on yes', async () => {
    const { input, runUpdate, confirms } = checkInput({ confirmAnswer: true });
    await maybeCheckForCliUpdate(input);
    expect(confirms.length).toBe(1);
    expect(confirms[0]).toContain('Update now?');
    expect(runUpdate).toHaveBeenCalledWith(['--yes']);
  });

  it('snoozes for 24 hours when the user declines', async () => {
    const { input, runUpdate } = checkInput({ confirmAnswer: false });
    await maybeCheckForCliUpdate(input);
    expect(runUpdate).not.toHaveBeenCalled();
    const snoozedUntil = readConfig(home).updateCheck?.snoozedUntil;
    expect(snoozedUntil).toBeDefined();
    expect(Date.parse(String(snoozedUntil))).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
  });

  it('never prompts again while snoozed', async () => {
    writeConfig(
      {
        updateCheck: {
          checkedAt: new Date().toISOString(),
          latestVersion: '99.0.0',
          snoozedUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        },
      },
      home,
    );
    const { input, fetchImpl, runUpdate, confirms } = checkInput({});
    await maybeCheckForCliUpdate(input);
    expect(confirms).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(runUpdate).not.toHaveBeenCalled();
  });

  it('prompts from a fresh cached latest without refetching', async () => {
    writeConfig(
      { updateCheck: { checkedAt: new Date().toISOString(), latestVersion: '99.0.0' } },
      home,
    );
    const { input, fetchImpl, runUpdate, confirms } = checkInput({ confirmAnswer: true });
    await maybeCheckForCliUpdate(input);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(confirms.length).toBe(1);
    expect(runUpdate).toHaveBeenCalledWith(['--yes']);
  });

  it('treats an aborted prompt as snooze and never throws', async () => {
    const { input, runUpdate } = checkInput({
      confirmImpl: async () => {
        throw new Error('aborted');
      },
    });
    await expect(maybeCheckForCliUpdate(input)).resolves.toBeUndefined();
    expect(runUpdate).not.toHaveBeenCalled();
    expect(readConfig(home).updateCheck?.snoozedUntil).toBeDefined();
  });

  it('a failing accepted update never rejects the check', async () => {
    const { input } = checkInput({
      confirmAnswer: true,
      runUpdate: vi.fn(async () => {
        throw new Error('npm exploded');
      }),
    });
    await expect(maybeCheckForCliUpdate(input)).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Env contract: NOODLE_NO_PROMPT, NOODLE_UPDATE_MODE, NOODLE_UPDATE_JSON
  // -------------------------------------------------------------------------

  it('NOODLE_NO_PROMPT downgrades the prompt to a notice', async () => {
    const { input, runUpdate, confirms } = checkInput({ env: { NOODLE_NO_PROMPT: '1' } });
    await maybeCheckForCliUpdate(input);
    expect(confirms).toEqual([]);
    expect(runUpdate).not.toHaveBeenCalled();
    expect(printedErr()).toContain('A newer Noodle CLI is available:');
  });

  it('NOODLE_UPDATE_MODE=off disables the check entirely', async () => {
    const { input, fetchImpl } = checkInput({ env: { NOODLE_UPDATE_MODE: 'off' } });
    await maybeCheckForCliUpdate(input);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('NOODLE_UPDATE_MODE=notify prints a notice and never prompts', async () => {
    const { input, runUpdate, confirms } = checkInput({ env: { NOODLE_UPDATE_MODE: 'notify' } });
    await maybeCheckForCliUpdate(input);
    expect(confirms).toEqual([]);
    expect(runUpdate).not.toHaveBeenCalled();
    expect(printedErr()).toContain('A newer Noodle CLI is available:');
  });

  it('NOODLE_UPDATE_MODE=check returns exit overlay 10 when an update is available', async () => {
    const { input, confirms } = checkInput({
      env: { NOODLE_UPDATE_MODE: 'check' },
      promptCapable: false,
      noticeCapable: false, // automation contract works without a TTY
    });
    expect(await maybeCheckForCliUpdate(input)).toBe(10);
    expect(confirms).toEqual([]);
  });

  it('NOODLE_UPDATE_MODE=check returns nothing when current', async () => {
    const { input } = checkInput({
      latest: '0.0.1',
      env: { NOODLE_UPDATE_MODE: 'check' },
      promptCapable: false,
      noticeCapable: false,
    });
    expect(await maybeCheckForCliUpdate(input)).toBeUndefined();
  });

  it('run() surfaces the mode=check overlay exit code after a successful command', async () => {
    stubLatestVersion('99.0.0');
    expect(await run(['whoami'], { NOODLE_UPDATE_MODE: 'check' }, home)).toBe(10);
  });

  it('NOODLE_UPDATE_MODE=auto updates without prompting on an interactive stderr', async () => {
    const { input, runUpdate, confirms } = checkInput({
      env: { NOODLE_UPDATE_MODE: 'auto' },
      promptCapable: false,
    });
    await maybeCheckForCliUpdate(input);
    expect(confirms).toEqual([]);
    expect(runUpdate).toHaveBeenCalledWith(['--yes']);
  });

  it('keeps NOODLE_AUTO_UPDATE working as an alias for mode=auto', async () => {
    const { input, runUpdate } = checkInput({
      env: { NOODLE_AUTO_UPDATE: '1' },
      promptCapable: false,
    });
    await maybeCheckForCliUpdate(input);
    expect(runUpdate).toHaveBeenCalledWith(['--yes']);
    expect(printedErr()).toContain('updating now');
  });

  it('never auto-updates under CI or noninteractive shells even with the opt-in set', async () => {
    const ci = checkInput({ env: { NOODLE_AUTO_UPDATE: '1', CI: 'true' } });
    await maybeCheckForCliUpdate(ci.input);
    const nonTty = checkInput({
      env: { NOODLE_AUTO_UPDATE: '1' },
      promptCapable: false,
      noticeCapable: false,
    });
    await maybeCheckForCliUpdate(nonTty.input);
    expect(ci.fetchImpl).not.toHaveBeenCalled();
    expect(nonTty.fetchImpl).not.toHaveBeenCalled();
    expect(ci.runUpdate).not.toHaveBeenCalled();
    expect(nonTty.runUpdate).not.toHaveBeenCalled();
  });

  it('NOODLE_UPDATE_JSON emits a machine-readable notice and never prompts', async () => {
    const { input, runUpdate, confirms } = checkInput({ env: { NOODLE_UPDATE_JSON: '1' } });
    await maybeCheckForCliUpdate(input);
    expect(confirms).toEqual([]);
    expect(runUpdate).not.toHaveBeenCalled();
    const jsonLine = outSpy.mock.calls
      .map((c) => String(c[0]))
      .find((line) => line.startsWith('{'));
    expect(jsonLine).toBeDefined();
    expect(JSON.parse(String(jsonLine))).toMatchObject({
      ok: true,
      data: {
        kind: 'event',
        event: {
          event: 'update_available',
          package: '@noodleseed/one',
          latest: '99.0.0',
          recommendedCommand: 'noodle update --yes --json',
        },
      },
    });
    expect(errSpy).not.toHaveBeenCalled();
  });
});
