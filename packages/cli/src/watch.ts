/**
 * Live `--watch` dashboards for the resource `list`/`status` commands (ADR 0129: the ANIMATED
 * warm gradient — `cyclic` from `gradient.ts` — is reserved for this live-redraw moment;
 * one-shot tables/spinners elsewhere only ever use a static/per-position tint).
 *
 * TTY mode repaints in place: hide the cursor, render a frame, then on every tick move the
 * cursor back up over the previous frame and redraw — blanking any now-stale trailing lines
 * when the new frame is shorter than the last, so a shrinking table never leaves orphaned rows
 * behind. A footer line (`watching · refreshed HH:MM:SS · every Ns · Ctrl-C to stop`) is
 * appended every tick; its leading glyph is tinted by the tick's position in the warm cyclic
 * gradient, so the display visibly "breathes" between refreshes. SIGINT restores the cursor and
 * exits 0 — a stopped watch is not a failure.
 *
 * Non-TTY mode (piped output, CI) never repaints or emits ANSI: it appends timestamped
 * plain-text snapshots, mirroring `logs --follow`'s polling shape, and honors a poll cap.
 *
 * A failing tick never crashes the loop: the previous frame stays on screen with a dim
 * "refresh failed" note; `MAX_CONSECUTIVE_FAILURES` in a row gives up and exits with the last
 * failure via `printCliFailure`.
 */

import { dimText } from './commands/resource-shared.js';
import type { CliFailure } from './commands/shared.js';
import { printCliFailure } from './commands/shared.js';
import {
  CLEAR_EOL,
  type ColorMode,
  cursorUp,
  cyclic,
  detectColorMode,
  detectGlyphMode,
  type GlyphMode,
  HIDE_CURSOR,
  paint,
  SHOW_CURSOR,
} from './gradient.js';

const CR = String.fromCharCode(13);
const NL = String.fromCharCode(10);

export const DEFAULT_WATCH_INTERVAL_SECONDS = 5;
export const MIN_WATCH_INTERVAL_SECONDS = 2;
const MAX_CONSECUTIVE_FAILURES = 5;
const WATCH_GLYPH_UNICODE = '◆';
const WATCH_GLYPH_ASCII = '*';

/** One rendered tick: either a fully-rendered multi-line frame, or a failure to report. */
export type WatchFrame =
  | { readonly ok: true; readonly frame: string }
  | { readonly ok: false; readonly error: CliFailure };

export interface RunWatchOptions {
  /** Command label `printCliFailure` prints against when the failure cap is hit. */
  readonly command: string;
  readonly render: () => Promise<WatchFrame>;
  readonly intervalMs: number;
  readonly stream?: NodeJS.WriteStream;
  readonly env?: NodeJS.ProcessEnv;
  /** Cap the number of renders — tests only; real usage leaves this unset (SIGINT/failure-cap stop it). */
  readonly maxPolls?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
}

/** Parse `--watch` / `--interval <seconds>` (default 5s, floored at `MIN_WATCH_INTERVAL_SECONDS`). */
export function parseWatchFlags(rest: readonly string[]): {
  readonly watch: boolean;
  readonly intervalMs: number;
} {
  let watch = false;
  let seconds = DEFAULT_WATCH_INTERVAL_SECONDS;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--watch') watch = true;
    else if (arg === '--interval') {
      const value = Number(rest[++i]);
      if (Number.isFinite(value) && value > 0) {
        seconds = Math.max(MIN_WATCH_INTERVAL_SECONDS, value);
      }
    }
  }
  return { watch, intervalMs: seconds * 1000 };
}

/** `--watch` combined with `--json` is a usage error, not a silent pick of one over the other. */
export function watchJsonConflictFailure(nextCommand: string): CliFailure {
  return {
    code: 'watch_json_conflict',
    message: '--watch cannot be combined with --json',
    cause: '--watch is a live TTY/plain-snapshot dashboard; --json expects one structured payload.',
    fix: 'Poll it yourself with --json instead, or drop --watch.',
    next: nextCommand,
    exitCode: 2,
  };
}

function timeLabel(at: Date): string {
  return at.toTimeString().slice(0, 8);
}

/** The animated footer line: `<glyph> watching · refreshed HH:MM:SS · every Ns · Ctrl-C to stop`. */
function footerLine(
  tick: number,
  intervalMs: number,
  at: Date,
  color: ColorMode,
  glyph: GlyphMode,
): string {
  const dot = glyph === 'ascii' ? WATCH_GLYPH_ASCII : WATCH_GLYPH_UNICODE;
  const sep = glyph === 'ascii' ? '-' : '·';
  const tinted = paint(cyclic(tick * 0.15), dot, color);
  const seconds = Math.round(intervalMs / 1000);
  return (
    `${tinted} watching ${sep} refreshed ${timeLabel(at)} ${sep} ` +
    `every ${seconds}s ${sep} Ctrl-C to stop`
  );
}

/**
 * Repaint in place: move the cursor back up over the previous frame, redraw every line, and
 * blank any trailing lines the new frame no longer has (a shrinking table/list). Returns the new
 * line count, the caller's `previousLineCount` for the next tick.
 */
function repaint(
  stream: NodeJS.WriteStream,
  previousLineCount: number,
  lines: readonly string[],
): number {
  let out = previousLineCount > 0 ? cursorUp(previousLineCount) : '';
  for (const line of lines) out += `${CR}${line}${CLEAR_EOL}${NL}`;
  const shrinkBy = previousLineCount - lines.length;
  if (shrinkBy > 0) {
    for (let i = 0; i < shrinkBy; i++) out += `${CR}${CLEAR_EOL}${NL}`;
    out += cursorUp(shrinkBy);
  }
  stream.write(out);
  return lines.length;
}

export async function runWatch(opts: RunWatchOptions): Promise<number> {
  const stream = opts.stream ?? process.stdout;
  const env = opts.env ?? process.env;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? ((): Date => new Date());
  const maxPolls = opts.maxPolls ?? Number.POSITIVE_INFINITY;
  const tty = stream.isTTY === true && env.CI !== 'true';
  return tty
    ? runWatchTty(opts, stream, sleep, now, maxPolls)
    : runWatchPlain(opts, stream, sleep, now, maxPolls);
}

async function runWatchTty(
  opts: RunWatchOptions,
  stream: NodeJS.WriteStream,
  sleep: (ms: number) => Promise<void>,
  now: () => Date,
  maxPolls: number,
): Promise<number> {
  const color = detectColorMode(stream);
  const glyph = detectGlyphMode();
  let resolveSigint: () => void = () => {};
  const sigint = new Promise<void>((resolve) => {
    resolveSigint = resolve;
  });
  const onSigint = (): void => resolveSigint();
  process.once('SIGINT', onSigint);
  stream.write(HIDE_CURSOR);

  let previousLineCount = 0;
  let consecutiveFailures = 0;
  let lastGoodFrame: string[] = [];
  let tick = 0;
  let signalled = false;
  let exitCode = 0;
  try {
    for (;;) {
      const result = await opts.render();
      if (result.ok) {
        lastGoodFrame = result.frame.split(NL);
        consecutiveFailures = 0;
      } else {
        consecutiveFailures += 1;
      }
      const lines = [...lastGoodFrame, footerLine(tick, opts.intervalMs, now(), color, glyph)];
      if (!result.ok)
        lines.push(dimText(`refresh failed (${result.error.code}), retrying…`, stream));
      previousLineCount = repaint(stream, previousLineCount, lines);

      if (!result.ok && consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        exitCode = printCliFailure(opts.command, result.error, false);
        break;
      }
      tick += 1;
      if (tick >= maxPolls) break;

      const outcome = await Promise.race([
        sleep(opts.intervalMs).then((): 'tick' => 'tick'),
        sigint.then((): 'signal' => 'signal'),
      ]);
      if (outcome === 'signal') {
        signalled = true;
        break;
      }
    }
  } finally {
    process.off('SIGINT', onSigint);
    stream.write(SHOW_CURSOR);
  }
  return signalled ? 0 : exitCode;
}

async function runWatchPlain(
  opts: RunWatchOptions,
  stream: NodeJS.WriteStream,
  sleep: (ms: number) => Promise<void>,
  now: () => Date,
  maxPolls: number,
): Promise<number> {
  let consecutiveFailures = 0;
  let tick = 0;
  for (;;) {
    const result = await opts.render();
    const time = timeLabel(now());
    if (result.ok) {
      consecutiveFailures = 0;
      stream.write(`--- ${time} ---\n${result.frame}\n`);
    } else {
      consecutiveFailures += 1;
      stream.write(`--- ${time} --- refresh failed (${result.error.code}), retrying…\n`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        return printCliFailure(opts.command, result.error, false);
      }
    }
    tick += 1;
    if (tick >= maxPolls) break;
    await sleep(opts.intervalMs);
  }
  return 0;
}
