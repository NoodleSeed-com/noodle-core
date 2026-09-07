import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectColorMode, detectGlyphMode, ORANGE, paint, rgbTo256, sgr } from '../src/gradient.js';

const ESC = String.fromCharCode(27);

describe('detectColorMode', () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {
      NO_COLOR: process.env.NO_COLOR,
      CI: process.env.CI,
      COLORTERM: process.env.COLORTERM,
    };
    delete process.env.NO_COLOR;
    delete process.env.CI;
    delete process.env.COLORTERM;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('is none when not a TTY, or NO_COLOR / CI set', () => {
    expect(detectColorMode({ isTTY: false })).toBe('none');
    process.env.NO_COLOR = '';
    expect(detectColorMode({ isTTY: true })).toBe('none');
    delete process.env.NO_COLOR;
    process.env.CI = 'true';
    expect(detectColorMode({ isTTY: true })).toBe('none');
  });

  it('is truecolor only when COLORTERM advertises 24-bit', () => {
    process.env.COLORTERM = 'truecolor';
    expect(detectColorMode({ isTTY: true })).toBe('truecolor');
    process.env.COLORTERM = '24bit';
    expect(detectColorMode({ isTTY: true })).toBe('truecolor');
  });

  it('falls back to ansi256 on a color TTY without truecolor (e.g. macOS Terminal.app)', () => {
    // Terminal.app: a color TTY that does NOT set COLORTERM=truecolor.
    expect(detectColorMode({ isTTY: true })).toBe('ansi256');
  });
});

describe('detectGlyphMode', () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {
      NOODLE_ASCII: process.env.NOODLE_ASCII,
      TERM_PROGRAM: process.env.TERM_PROGRAM,
      WT_SESSION: process.env.WT_SESSION,
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
      LC_CTYPE: process.env.LC_CTYPE,
    };
    for (const k of Object.keys(saved)) delete process.env[k];
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('is forced to ascii by NOODLE_ASCII', () => {
    process.env.NOODLE_ASCII = '1';
    process.env.LANG = 'en_US.UTF-8';
    expect(detectGlyphMode()).toBe('ascii');
  });

  it('trusts known-good terminals regardless of locale', () => {
    process.env.TERM_PROGRAM = 'Apple_Terminal';
    expect(detectGlyphMode()).toBe('unicode');
    delete process.env.TERM_PROGRAM;
    process.env.WT_SESSION = 'x';
    expect(detectGlyphMode()).toBe('unicode');
  });

  it('gates on a UTF-8 locale otherwise', () => {
    process.env.LANG = 'en_US.UTF-8';
    expect(detectGlyphMode()).toBe('unicode');
    process.env.LANG = 'C';
    expect(detectGlyphMode()).toBe('ascii');
    process.env.LANG = 'POSIX';
    expect(detectGlyphMode()).toBe('ascii');
  });
});

describe('sgr / paint / rgbTo256', () => {
  it('emits 24-bit for truecolor, 256 for ansi256, nothing for none', () => {
    expect(sgr(ORANGE, 'truecolor')).toBe(`${ESC}[38;2;249;115;22m`);
    expect(sgr(ORANGE, 'ansi256')).toBe(`${ESC}[38;5;${rgbTo256(ORANGE)}m`);
    expect(sgr(ORANGE, 'none')).toBe('');
  });

  it('rgbTo256 maps orange into the 6x6x6 color cube and greys onto the ramp', () => {
    const n = rgbTo256(ORANGE);
    expect(n).toBeGreaterThanOrEqual(16);
    expect(n).toBeLessThanOrEqual(231); // color cube, not greyscale
    expect(rgbTo256([0, 0, 0])).toBe(16);
    expect(rgbTo256([255, 255, 255])).toBe(231);
    expect(rgbTo256([128, 128, 128])).toBeGreaterThanOrEqual(232); // greyscale ramp
  });

  it('paint wraps with a reset in color modes and leaves text untouched in none', () => {
    expect(paint(ORANGE, 'x', 'truecolor')).toBe(`${ESC}[38;2;249;115;22mx${ESC}[0m`);
    expect(paint(ORANGE, 'x', 'ansi256')).toContain(`${ESC}[38;5;`);
    expect(paint(ORANGE, 'x', 'none')).toBe('x');
  });
});
