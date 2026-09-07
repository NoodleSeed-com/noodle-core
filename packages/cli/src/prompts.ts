/**
 * Minimal, dependency-free prompt layer for the guided `noodle start` wizard:
 * a warm-styled select / text / confirm on `node:readline`, adaptive to the terminal
 * (truecolor / 256-color / none, Unicode / ASCII glyphs). Pure renderers are exported
 * for tests; the interactive runners are a thin keypress shell on top.
 *
 * Non-interactive callers (agents, `--json`, CI) never reach the readline layer —
 * `resolveAnswer` pulls from a supplied answer map and throws `MissingAnswerError`
 * (with the flag that would supply it) instead of blocking on a prompt.
 */
import { emitKeypressEvents } from 'node:readline';
import {
  CLEAR_EOL,
  type ColorMode,
  cursorUp,
  detectColorMode,
  detectGlyphMode,
  type GlyphMode,
  HIDE_CURSOR,
  paint,
  type RGB,
  SHOW_CURSOR,
} from './gradient.js';

const CR = String.fromCharCode(13);
const NL = String.fromCharCode(10);

const ORANGE: RGB = [249, 115, 22];
const AMBER: RGB = [245, 158, 11];
const GREEN: RGB = [34, 197, 94];
const INK: RGB = [230, 230, 230];
const DIM: RGB = [125, 125, 125];
const FAINT: RGB = [90, 90, 90];
const ROSE: RGB = [244, 63, 94];

/** Choose a glyph by terminal capability. */
const g = (unicode: string, ascii: string, glyph: GlyphMode): string =>
  glyph === 'unicode' ? unicode : ascii;

export interface SelectOption<T> {
  readonly value: T;
  readonly label: string;
  readonly hint?: string;
}

/**
 * A prompt is interactive on a real TTY that isn't CI. Interactivity is independent
 * of color — `NO_COLOR` on a TTY still runs the prompts, just uncolored (the runners
 * pick color via `detectColorMode`). Only a non-TTY or CI disables interaction.
 */
export function isInteractive(
  input: { isTTY?: boolean } = process.stdin,
  output: { isTTY?: boolean } = process.stdout,
): boolean {
  return input.isTTY === true && output.isTTY === true && process.env.CI === undefined;
}

/** Raised when a required answer is not supplied in non-interactive mode. Carries the flag that would. */
export class MissingAnswerError extends Error {
  constructor(
    readonly key: string,
    readonly flag: string,
  ) {
    super(`missing answer for "${key}" — supply ${flag}`);
    this.name = 'MissingAnswerError';
  }
}

/** Raised when the user aborts a prompt (Esc / Ctrl+C). */
export class AbortPromptError extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortPromptError';
  }
}

/**
 * Resolve an answer without prompting: return the supplied value, else the default,
 * else throw MissingAnswerError. This is the seam the interactive runners and the
 * non-interactive (`--json`/agent) path share, so both honor the same answer map.
 */
export function resolveAnswer<T>(
  answers: Record<string, unknown> | undefined,
  key: string,
  flag: string,
  fallback?: T,
): T {
  const supplied = answers?.[key];
  if (supplied !== undefined) return supplied as T;
  if (fallback !== undefined) return fallback;
  throw new MissingAnswerError(key, flag);
}

// ---------------------------------------------------------------------------
// Pure renderers (unit-tested)
// ---------------------------------------------------------------------------

/** Render a select menu to its lines: a message line + one line per option. */
export function renderSelect<T>(
  message: string,
  options: readonly SelectOption<T>[],
  index: number,
  color: ColorMode,
  glyph: GlyphMode = 'unicode',
): string[] {
  const head = `${paint(AMBER, '?', color)} ${paint(INK, message, color)}`;
  const rows = options.map((opt, i) => {
    const active = i === index;
    const pointer = active ? paint(ORANGE, g('❯', '>', glyph), color) : ' ';
    const label = paint(active ? INK : DIM, opt.label, color);
    const hint = opt.hint ? `  ${paint(FAINT, opt.hint, color)}` : '';
    return `  ${pointer} ${label}${hint}`;
  });
  return [head, ...rows];
}

/** Render the settled select line (after a choice): `✔ message · label`. */
export function renderSelectResult(
  message: string,
  label: string,
  color: ColorMode,
  glyph: GlyphMode = 'unicode',
): string {
  return `${paint(GREEN, g('✔', '+', glyph), color)} ${paint(DIM, message, color)} ${paint(INK, label, color)}`;
}

/** Render a text/confirm prompt line. `value` is the current buffer (may be empty). */
export function renderText(
  message: string,
  value: string,
  color: ColorMode,
  glyph: GlyphMode = 'unicode',
): string {
  const arrow = paint(FAINT, g('›', '>', glyph), color);
  return `${paint(AMBER, '?', color)} ${paint(INK, message, color)} ${arrow} ${paint(INK, value, color)}`;
}

/** Render the settled text/confirm result line. */
export function renderTextResult(
  message: string,
  value: string,
  color: ColorMode,
  glyph: GlyphMode = 'unicode',
): string {
  return `${paint(GREEN, g('✔', '+', glyph), color)} ${paint(DIM, message, color)} ${paint(INK, value, color)}`;
}

// ---------------------------------------------------------------------------
// Interactive runners (thin keypress shell; assume a TTY — caller gates)
// ---------------------------------------------------------------------------

interface RunnerIO {
  input?: NodeJS.ReadStream & { isTTY?: boolean };
  output?: NodeJS.WriteStream;
}

function enterPromptInput(input: NodeJS.ReadStream & { isTTY?: boolean }): () => void {
  const wasRaw = input.isRaw === true;
  emitKeypressEvents(input);
  if (input.isTTY) input.setRawMode(true);
  input.resume();
  return () => {
    if (input.isTTY) input.setRawMode(wasRaw);
    input.pause();
  };
}

/** Interactive arrow-key select. Resolves the chosen value; rejects AbortPromptError on Esc/Ctrl+C. */
export function select<T>(
  message: string,
  options: readonly SelectOption<T>[],
  opts: { initial?: number } & RunnerIO = {},
): Promise<T> {
  if (options.length === 0) {
    return Promise.reject(new RangeError('select requires at least one option'));
  }
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const color = detectColorMode(output);
  const glyph = detectGlyphMode();
  return new Promise<T>((resolve, reject) => {
    let index = Math.max(0, Math.min(options.length - 1, opts.initial ?? 0));
    let drawn = 0;
    const restoreInput = enterPromptInput(input);
    output.write(HIDE_CURSOR);

    const draw = (): void => {
      if (drawn > 0) output.write(cursorUp(drawn));
      const lines = renderSelect(message, options, index, color, glyph);
      output.write(lines.map((l) => `${CR}${l}${CLEAR_EOL}`).join(NL) + NL);
      drawn = lines.length;
    };
    const cleanup = (): void => {
      input.off('keypress', onKey);
      restoreInput();
      output.write(SHOW_CURSOR);
    };
    const writeSettled = (label: string): void => {
      const tail = Math.max(0, drawn - 1);
      const clearTail = Array.from({ length: tail }, () => `${CR}${CLEAR_EOL}${NL}`).join('');
      output.write(
        cursorUp(drawn) +
          CR +
          renderSelectResult(message, label, color, glyph) +
          CLEAR_EOL +
          NL +
          clearTail +
          (tail > 0 ? cursorUp(tail) : ''),
      );
    };
    const onKey = (_s: string, key: { name?: string; ctrl?: boolean } = {}): void => {
      if (key.name === 'up' || key.name === 'k')
        index = (index - 1 + options.length) % options.length;
      else if (key.name === 'down' || key.name === 'j') index = (index + 1) % options.length;
      else if (key.name === 'return' || key.name === 'enter') {
        cleanup();
        const chosen = options[index] as SelectOption<T>;
        writeSettled(chosen.label);
        resolve(chosen.value);
        return;
      } else if (key.name === 'escape' || (key.ctrl === true && key.name === 'c')) {
        cleanup();
        reject(new AbortPromptError());
        return;
      }
      draw();
    };
    input.on('keypress', onKey);
    draw();
  });
}

/** Interactive free-text prompt with a default. Rejects AbortPromptError on Ctrl+C. */
export function text(
  message: string,
  opts: { initial?: string; validate?: (v: string) => string | undefined } & RunnerIO = {},
): Promise<string> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const color = detectColorMode(output);
  const glyph = detectGlyphMode();
  return new Promise<string>((resolve, reject) => {
    let buf = opts.initial ?? '';
    const restoreInput = enterPromptInput(input);
    const redraw = (): void => {
      output.write(`${CR}${renderText(message, buf, color, glyph)}${CLEAR_EOL}`);
    };
    const cleanup = (): void => {
      input.off('keypress', onKey);
      restoreInput();
    };
    const onKey = (s: string, key: { name?: string; ctrl?: boolean } = {}): void => {
      if (key.name === 'return' || key.name === 'enter') {
        const err = opts.validate?.(buf);
        if (err) {
          // Keep the error on its own line; redraw the prompt on the next line, not over it.
          output.write(`${NL}  ${paint(ROSE, err, color)}${CLEAR_EOL}${NL}`);
          redraw();
          return;
        }
        cleanup();
        output.write(
          `${CR}${renderTextResult(message, buf || '(empty)', color, glyph)}${CLEAR_EOL}${NL}`,
        );
        resolve(buf);
        return;
      }
      if (key.ctrl === true && key.name === 'c') {
        cleanup();
        reject(new AbortPromptError());
        return;
      }
      if (key.name === 'backspace') buf = buf.slice(0, -1);
      else if (s && !key.ctrl && s.length === 1 && s >= ' ') buf += s;
      redraw();
    };
    input.on('keypress', onKey);
    redraw();
  });
}

/** Interactive yes/no confirm. */
export async function confirm(
  message: string,
  opts: { initial?: boolean } & RunnerIO = {},
): Promise<boolean> {
  const options: SelectOption<boolean>[] = [
    { value: true, label: 'Yes' },
    { value: false, label: 'No' },
  ];
  return select(message, options, {
    initial: opts.initial === false ? 1 : 0,
    ...(opts.input ? { input: opts.input } : {}),
    ...(opts.output ? { output: opts.output } : {}),
  });
}
