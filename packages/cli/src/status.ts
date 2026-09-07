/**
 * TTY-aware progress status for the CLI: a warm-gradient spinner for the active
 * step, and semantic step glyphs (done / fail / warn / pending) for the settled
 * ones. Adapts to the terminal — truecolor where advertised, a 256-color fallback
 * elsewhere (so macOS Terminal.app and bare xterm stay warm), and ASCII glyphs when
 * Unicode isn't safe. Under `--json` (the caller gates), pipes, CI, and `NO_COLOR`
 * it degrades to plain, escape-free lines so scripting/agent output stays clean.
 */
import {
  CLEAR_EOL,
  type ColorMode,
  cyclic,
  detectColorMode,
  detectGlyphMode,
  type GlyphMode,
  HIDE_CURSOR,
  paint,
  type RGB,
  SHOW_CURSOR,
} from './gradient.js';

const CR = String.fromCharCode(13); // carriage return (avoid a literal CR in source)
const NL = String.fromCharCode(10); // line feed

/** Spinner frames: braille where Unicode is safe, a classic ASCII spinner otherwise. */
const FRAMES_UNICODE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const FRAMES_ASCII = ['|', '/', '-', '\\'];

/** Semantic step glyphs (Unicode + ASCII fallback) and their colors. */
const SYMBOLS_UNICODE = { done: '✔', fail: '✗', warn: '⚠', pending: '◦' } as const;
const SYMBOLS_ASCII = { done: '+', fail: 'x', warn: '!', pending: '.' } as const;
export const SYMBOLS = SYMBOLS_UNICODE;
export type StepKind = keyof typeof SYMBOLS_UNICODE;
const SYMBOL_COLOR: Record<StepKind, RGB> = {
  done: [34, 197, 94], // green
  fail: [244, 63, 94], // rose
  warn: [245, 158, 11], // amber
  pending: [115, 115, 115], // dim grey
};

/** One spinner frame: `<glyph> <label>`, warm-tinted (flowing hue by index) per color mode. */
export function renderSpinnerFrame(
  index: number,
  label: string,
  color: ColorMode,
  glyph: GlyphMode = 'unicode',
): string {
  const frames = glyph === 'ascii' ? FRAMES_ASCII : FRAMES_UNICODE;
  const ch = frames[((index % frames.length) + frames.length) % frames.length] as string;
  return `${paint(cyclic(index / frames.length), ch, color)} ${label}`;
}

/** One settled step line: `<symbol> <text>`, semantic color per color mode. */
export function renderStep(
  kind: StepKind,
  text: string,
  color: ColorMode,
  glyph: GlyphMode = 'unicode',
): string {
  const symbol = (glyph === 'ascii' ? SYMBOLS_ASCII : SYMBOLS_UNICODE)[kind];
  return `${paint(SYMBOL_COLOR[kind], symbol, color)} ${text}`;
}

export interface Spinner {
  /** Change the label shown next to the spinner. */
  update(label: string): void;
  /** Stop and print a green ✔ line (defaults to the current label). */
  succeed(text?: string): void;
  /** Stop and print a rose ✗ line (defaults to the current label). */
  fail(text?: string): void;
  /** Stop and print an amber ⚠ line (defaults to the current label). */
  warn(text?: string): void;
  /** Stop and clear the line, printing nothing. */
  stop(): void;
}

const FRAME_MS = 80;

/**
 * Start a progress spinner on `stream` (stdout by default). Animates on any colored
 * TTY (truecolor or 256-color); on a plain/non-color stream it prints nothing until
 * it settles, then emits a single escape-free line.
 */
export function startSpinner(label: string, stream: NodeJS.WriteStream = process.stdout): Spinner {
  const color = detectColorMode(stream);
  const glyph = detectGlyphMode();
  let current = label;

  if (color === 'none') {
    const settle = (kind: StepKind, text?: string): void => {
      stream.write(`${renderStep(kind, text ?? current, color, glyph)}${NL}`);
    };
    return {
      update: (l) => {
        current = l;
      },
      succeed: (t) => settle('done', t),
      fail: (t) => settle('fail', t),
      warn: (t) => settle('warn', t),
      stop: () => {},
    };
  }

  let i = 0;
  stream.write(HIDE_CURSOR);
  const paintFrame = (): void => {
    stream.write(`${CR}${renderSpinnerFrame(i, current, color, glyph)}${CLEAR_EOL}`);
    i += 1;
  };
  paintFrame();
  const timer = setInterval(paintFrame, FRAME_MS);
  timer.unref?.();

  const settle = (kind: StepKind, text?: string): void => {
    clearInterval(timer);
    stream.write(
      `${CR}${renderStep(kind, text ?? current, color, glyph)}${CLEAR_EOL}${SHOW_CURSOR}${NL}`,
    );
  };
  return {
    update: (l) => {
      current = l;
    },
    succeed: (t) => settle('done', t),
    fail: (t) => settle('fail', t),
    warn: (t) => settle('warn', t),
    stop: () => {
      clearInterval(timer);
      stream.write(`${CR}${CLEAR_EOL}${SHOW_CURSOR}`);
    },
  };
}

/** Print a standalone settled step line (no spinner), TTY/terminal-aware. */
export function printStep(
  kind: StepKind,
  text: string,
  stream: NodeJS.WriteStream = process.stdout,
): void {
  stream.write(`${renderStep(kind, text, detectColorMode(stream), detectGlyphMode())}${NL}`);
}
