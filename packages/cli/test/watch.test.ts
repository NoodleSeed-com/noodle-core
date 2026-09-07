import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliFailure } from '../src/commands/shared.js';
import { CLEAR_EOL, cursorUp, HIDE_CURSOR, SHOW_CURSOR } from '../src/gradient.js';
import {
  DEFAULT_WATCH_INTERVAL_SECONDS,
  MIN_WATCH_INTERVAL_SECONDS,
  parseWatchFlags,
  runWatch,
  type WatchFrame,
  watchJsonConflictFailure,
} from '../src/watch.js';

// TTY/ANSI assertions must not depend on the invoking environment: the pipeline runs with CI=true,
// which detectColorMode treats as color 'none' (this exact leak auto-reverted PR #318 — the tests
// were green locally and deterministically red in CI). Pin a clean env for every test here.
beforeEach(() => {
  vi.stubEnv('CI', '');
  vi.stubEnv('NO_COLOR', '');
  delete process.env.CI;
  delete process.env.NO_COLOR;
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const CR = String.fromCharCode(13);
const NL = String.fromCharCode(10);
const ESC = String.fromCharCode(27);

function fakeStream(isTTY: boolean): { stream: NodeJS.WriteStream; writes: string[] } {
  const writes: string[] = [];
  const stream = {
    isTTY,
    columns: 80,
    write: (s: string) => {
      writes.push(s);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return { stream, writes };
}

const noSleep = async (): Promise<void> => {};

const FAILURE: CliFailure = {
  code: 'service_error',
  message: 'boom',
  cause: 'boom',
  fix: 'retry',
  next: 'noodle doctor',
  exitCode: 1,
};

describe('parseWatchFlags', () => {
  it('defaults to no watch and the default interval', () => {
    expect(parseWatchFlags([])).toEqual({
      watch: false,
      intervalMs: DEFAULT_WATCH_INTERVAL_SECONDS * 1000,
    });
  });

  it('parses --watch and --interval', () => {
    expect(parseWatchFlags(['--watch', '--interval', '10'])).toEqual({
      watch: true,
      intervalMs: 10_000,
    });
  });

  it('floors --interval at the minimum', () => {
    expect(parseWatchFlags(['--watch', '--interval', '1'])).toEqual({
      watch: true,
      intervalMs: MIN_WATCH_INTERVAL_SECONDS * 1000,
    });
  });

  it('ignores a non-numeric --interval and keeps the default', () => {
    expect(parseWatchFlags(['--interval', 'nope']).intervalMs).toBe(
      DEFAULT_WATCH_INTERVAL_SECONDS * 1000,
    );
  });
});

describe('watchJsonConflictFailure', () => {
  it('is a usage-error CliFailure naming the conflict', () => {
    const failure = watchJsonConflictFailure('noodle apps list --json');
    expect(failure.code).toBe('watch_json_conflict');
    expect(failure.exitCode).toBe(2);
    expect(failure.next).toBe('noodle apps list --json');
  });
});

describe('runWatch — TTY repaint', () => {
  it('paints the first frame with no leading cursorUp (nothing to erase yet)', async () => {
    const { stream, writes } = fakeStream(true);
    const render = async (): Promise<WatchFrame> => ({ ok: true, frame: 'row-a\nrow-b' });
    await runWatch({
      command: 'apps',
      render,
      intervalMs: 5000,
      stream,
      sleep: noSleep,
      maxPolls: 1,
      now: () => new Date('2026-01-01T12:04:31Z'),
    });
    expect(writes[0]).toBe(HIDE_CURSOR);
    // first paint: 2 frame lines + 1 footer = 3 lines, no cursorUp yet (previousLineCount was 0)
    expect(writes[1]).not.toMatch(/\d+A/); // no "<n>A" cursor-up sequence on the very first paint
    expect(writes[1]).toContain('row-a');
    expect(writes[1]).toContain('row-b');
    expect(writes[1]).toContain('watching');
    expect(writes.at(-1)).toBe(SHOW_CURSOR);
  });

  it('repaints in place on the next tick, moving the cursor up over the previous frame', async () => {
    const { stream, writes } = fakeStream(true);
    let call = 0;
    const render = async (): Promise<WatchFrame> => {
      call += 1;
      return { ok: true, frame: call === 1 ? 'row-a\nrow-b\nrow-c' : 'row-a\nrow-b\nrow-c' };
    };
    await runWatch({
      command: 'apps',
      render,
      intervalMs: 5000,
      stream,
      sleep: noSleep,
      maxPolls: 2,
      now: () => new Date('2026-01-01T12:04:31Z'),
    });
    // tick1: 3 frame lines + 1 footer = 4 lines drawn, no cursorUp.
    // tick2: same shape, so it should move up exactly 4 lines and redraw 4 lines again.
    expect(writes[2]).toContain(cursorUp(4));
  });

  it('grows cleanly when the frame gains lines, with no stale-line blanking needed', async () => {
    const { stream, writes } = fakeStream(true);
    let call = 0;
    const render = async (): Promise<WatchFrame> => {
      call += 1;
      return call === 1 ? { ok: true, frame: 'row-a' } : { ok: true, frame: 'row-a\nrow-b\nrow-c' };
    };
    await runWatch({
      command: 'apps',
      render,
      intervalMs: 5000,
      stream,
      sleep: noSleep,
      maxPolls: 2,
      now: () => new Date('2026-01-01T12:04:31Z'),
    });
    // tick1: 1 frame line + footer = 2 lines. tick2: 3 frame lines + footer = 4 lines (grows).
    const tick2 = writes[2] as string;
    expect(tick2).toContain(cursorUp(2)); // move back up over tick1's 2 lines only
    expect(tick2).not.toContain(cursorUp(4)); // no over-correction; nothing to blank when growing
    expect(tick2).toContain('row-b');
    expect(tick2).toContain('row-c');
  });

  it('clears stale trailing lines when the frame shrinks, and repositions the cursor', async () => {
    const { stream, writes } = fakeStream(true);
    let call = 0;
    const render = async (): Promise<WatchFrame> => {
      call += 1;
      return call === 1 ? { ok: true, frame: 'row-a\nrow-b\nrow-c' } : { ok: true, frame: 'row-a' };
    };
    await runWatch({
      command: 'apps',
      render,
      intervalMs: 5000,
      stream,
      sleep: noSleep,
      maxPolls: 2,
      now: () => new Date('2026-01-01T12:04:31Z'),
    });
    // tick1: 3 frame lines + footer = 4 lines. tick2: 1 frame line + footer = 2 lines. shrinkBy = 2.
    const tick2 = writes[2] as string;
    expect(tick2).toContain(cursorUp(4)); // move back up over tick1's 4 lines
    const blankClear = `${CR}${CLEAR_EOL}${NL}`;
    const blankCount = tick2.split(blankClear).length - 1;
    expect(blankCount).toBeGreaterThanOrEqual(2); // blanks the 2 now-stale trailing lines
    expect(tick2).toContain(cursorUp(2)); // repositions after the new (shorter) content
    // "row-c" (only ever part of tick1's frame) must not appear in tick2's redraw.
    const tick2Lines = tick2.split(NL);
    expect(tick2Lines.some((l) => l.includes('row-c'))).toBe(false);
  });

  it('does not crash on a failing tick: keeps the previous frame and appends a dim retry note', async () => {
    const { stream, writes } = fakeStream(true);
    let call = 0;
    const render = async (): Promise<WatchFrame> => {
      call += 1;
      return call === 1 ? { ok: true, frame: 'good frame' } : { ok: false, error: FAILURE };
    };
    const code = await runWatch({
      command: 'apps',
      render,
      intervalMs: 5000,
      stream,
      sleep: noSleep,
      maxPolls: 3,
      now: () => new Date('2026-01-01T12:04:31Z'),
    });
    expect(code).toBe(0); // hasn't hit the failure cap yet
    expect(writes[2]).toContain('good frame'); // the last good frame stays visible
    expect(writes[2]).toContain('refresh failed');
  });

  it('gives up after 5 consecutive failures and exits with the last failure via printCliFailure', async () => {
    const { stream } = fakeStream(true);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let calls = 0;
    const render = async (): Promise<WatchFrame> => {
      calls += 1;
      if (calls === 1) return { ok: true, frame: 'good' };
      return { ok: false, error: FAILURE };
    };
    const code = await runWatch({
      command: 'apps',
      render,
      intervalMs: 10,
      stream,
      sleep: noSleep,
      now: () => new Date('2026-01-01T12:04:31Z'),
    });
    expect(code).toBe(1);
    expect(calls).toBe(6); // 1 success + 5 consecutive failures
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('SIGINT stops the loop, shows the cursor again, and exits 0', async () => {
    const { stream, writes } = fakeStream(true);
    const render = async (): Promise<WatchFrame> => ({ ok: true, frame: 'x' });
    const neverResolves = () => new Promise<void>(() => {});
    const promise = runWatch({
      command: 'apps',
      render,
      intervalMs: 60_000,
      stream,
      sleep: neverResolves,
      now: () => new Date(),
    });
    // Let the first render + repaint (all microtask-based) settle before signalling.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    process.emit('SIGINT');
    const code = await promise;
    expect(code).toBe(0);
    expect(writes.at(-1)).toBe(SHOW_CURSOR);
  });
});

describe('runWatch — non-TTY plain snapshots', () => {
  it('appends timestamped plain snapshots honoring maxPolls, with no ANSI', async () => {
    const { stream, writes } = fakeStream(false);
    let call = 0;
    const render = async (): Promise<WatchFrame> => {
      call += 1;
      return { ok: true, frame: `frame-${call}` };
    };
    const sleepCalls: number[] = [];
    const code = await runWatch({
      command: 'apps',
      render,
      intervalMs: 5000,
      stream,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
      maxPolls: 3,
      now: () => new Date('2026-01-01T12:04:31Z'),
    });
    expect(code).toBe(0);
    expect(writes).toHaveLength(3);
    expect(writes.join('')).not.toContain(ESC);
    expect(sleepCalls).toEqual([5000, 5000]); // slept between ticks, not after the last
    expect(writes[0]).toContain('frame-1');
    expect(writes[2]).toContain('frame-3');
  });

  it('does not crash on a failing tick and gives up after 5 consecutive failures', async () => {
    const { stream, writes } = fakeStream(false);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let calls = 0;
    const render = async (): Promise<WatchFrame> => {
      calls += 1;
      if (calls === 1) return { ok: true, frame: 'good' };
      return { ok: false, error: FAILURE };
    };
    const code = await runWatch({
      command: 'apps',
      render,
      intervalMs: 10,
      stream,
      sleep: noSleep,
      now: () => new Date('2026-01-01T12:04:31Z'),
    });
    expect(code).toBe(1);
    expect(calls).toBe(6);
    expect(writes.some((w) => w.includes('good'))).toBe(true);
    expect(writes.some((w) => w.includes('refresh failed'))).toBe(true);
    expect(writes.join('')).not.toContain(ESC);
    errSpy.mockRestore();
  });

  it('CI=true is treated as non-TTY even when the stream reports isTTY', async () => {
    const { stream, writes } = fakeStream(true);
    const render = async (): Promise<WatchFrame> => ({ ok: true, frame: 'x' });
    await runWatch({
      command: 'apps',
      render,
      intervalMs: 10,
      stream,
      env: { CI: 'true' },
      sleep: noSleep,
      maxPolls: 1,
      now: () => new Date(),
    });
    expect(writes.join('')).not.toContain(ESC);
    expect(writes.some((w) => w.includes(HIDE_CURSOR))).toBe(false);
  });
});
