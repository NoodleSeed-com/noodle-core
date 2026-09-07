/**
 * Shared warm brand gradient + ANSI control codes for the CLI's branded output
 * (the `noodle init` splash and the progress `status` module). Keeping the palette
 * in one place means the wordmark and the spinner read as the same Noodle Seed warmth.
 */
export type RGB = [number, number, number];

export const ORANGE: RGB = [249, 115, 22]; // #f97316
export const AMBER: RGB = [245, 158, 11]; // #f59e0b
export const ROSE: RGB = [244, 63, 94]; // #f43f5e

const RESET = '\u001b[0m';
export const HIDE_CURSOR = '\u001b[?25l';
export const SHOW_CURSOR = '\u001b[?25h';
export const CLEAR_EOL = '\u001b[K';

const lerp = (a: number, b: number, t: number): number => Math.round(a + (b - a) * t);

export const mix = (a: RGB, b: RGB, t: number): RGB => [
  lerp(a[0], b[0], t),
  lerp(a[1], b[1], t),
  lerp(a[2], b[2], t),
];

/** Move the cursor up `n` rows, for in-place redraws (e.g. the splash animation). */
export const cursorUp = (n: number): string => `${String.fromCharCode(27)}[${n}A`;

/** Seamless cyclic warm palette over u in [0,1): orange -> amber -> rose -> amber -> orange. */
export function cyclic(u: number): RGB {
  const p = ((u % 1) + 1) % 1;
  if (p < 0.25) return mix(ORANGE, AMBER, p / 0.25);
  if (p < 0.5) return mix(AMBER, ROSE, (p - 0.25) / 0.25);
  if (p < 0.75) return mix(ROSE, AMBER, (p - 0.5) / 0.25);
  return mix(AMBER, ORANGE, (p - 0.75) / 0.25);
}

// --- terminal capability detection -----------------------------------------

/** How much color the target stream/terminal can render. */
export type ColorMode = 'truecolor' | 'ansi256' | 'none';
/** Whether the terminal can be trusted to render the branded Unicode glyphs. */
export type GlyphMode = 'unicode' | 'ascii';

const ESC = String.fromCharCode(27);

/** Nearest xterm-256 index for an RGB triple (6×6×6 color cube + grayscale ramp). */
export function rgbTo256([r, g, b]: RGB): number {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return 232 + Math.round(((r - 8) / 247) * 24);
  }
  const q = (v: number): number => Math.round((v / 255) * 5);
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

/** Foreground SGR for an RGB triple in the given color mode ('' when none). */
export function sgr(rgb: RGB, mode: ColorMode): string {
  if (mode === 'none') return '';
  if (mode === 'ansi256') return `${ESC}[38;5;${rgbTo256(rgb)}m`;
  return `${ESC}[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}

/** Wrap `s` in the RGB color for the mode (returns `s` unchanged when none). */
export function paint(rgb: RGB, s: string, mode: ColorMode): string {
  return mode === 'none' ? s : `${sgr(rgb, mode)}${s}${RESET}`;
}

/**
 * Color mode for a stream: none (not a TTY / NO_COLOR / CI); truecolor when
 * COLORTERM advertises 24-bit (iTerm2, VS Code, Windows Terminal, most Linux);
 * else ansi256 — a 256-color fallback so macOS Terminal.app and bare xterm stay
 * warm instead of rendering raw 24-bit sequences wrong.
 */
export function detectColorMode(stream: { isTTY?: boolean }): ColorMode {
  if (stream.isTTY !== true || process.env.NO_COLOR !== undefined || process.env.CI !== undefined) {
    return 'none';
  }
  const ct = process.env.COLORTERM;
  if (ct === 'truecolor' || ct === '24bit') return 'truecolor';
  return 'ansi256';
}

/**
 * Unicode vs ASCII glyphs. Forced to ascii by `NOODLE_ASCII`; trusted for known-good
 * terminals (VS Code, iTerm2, Terminal.app, Windows Terminal); otherwise gated on a
 * UTF-8 locale so a `C`/minimal environment never renders tofu.
 */
export function detectGlyphMode(): GlyphMode {
  if (process.env.NOODLE_ASCII !== undefined) return 'ascii';
  const program = process.env.TERM_PROGRAM;
  if (
    process.env.WT_SESSION !== undefined ||
    program === 'vscode' ||
    program === 'iTerm.app' ||
    program === 'Apple_Terminal'
  ) {
    return 'unicode';
  }
  const locale = process.env.LC_ALL ?? process.env.LC_CTYPE ?? process.env.LANG ?? '';
  return /utf-?8/i.test(locale) ? 'unicode' : 'ascii';
}
