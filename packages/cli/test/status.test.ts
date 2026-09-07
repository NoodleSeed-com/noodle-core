import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderSpinnerFrame, renderStep, SYMBOLS, startSpinner } from '../src/status.js';

const ESC = String.fromCharCode(27); // ANSI escape
const LF = String.fromCharCode(10);

function fakeStream(isTTY: boolean) {
  const writes: string[] = [];
  const stream = {
    isTTY,
    columns: 80,
    write: (s: string) => {
      writes.push(s);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return { stream, out: () => writes.join('') };
}

describe('status renderers', () => {
  it('renders a braille spinner frame with a warm truecolor tint', () => {
    const out = renderSpinnerFrame(0, 'Compiling…', 'truecolor');
    expect(out).toContain('⠋');
    expect(out).toContain('Compiling…');
    expect(out).toMatch(/\[38;2;\d+;\d+;\d+m/); // 24-bit tint
  });

  it('uses a 256-color tint on a non-truecolor terminal, and no color for none', () => {
    expect(renderSpinnerFrame(0, 'x', 'ansi256')).toMatch(/\[38;5;\d+m/);
    expect(renderSpinnerFrame(3, 'Working', 'none')).toBe('⠸ Working');
    expect(renderSpinnerFrame(3, 'Working', 'none')).not.toContain(ESC);
  });

  it('falls back to an ASCII spinner + glyphs when Unicode is not safe', () => {
    expect(renderSpinnerFrame(0, 'x', 'none', 'ascii')).toBe('| x');
    expect(renderSpinnerFrame(1, 'x', 'none', 'ascii')).toBe('/ x');
    expect(renderStep('done', 'ok', 'none', 'ascii')).toBe('+ ok');
    expect(renderStep('fail', 'no', 'none', 'ascii')).toBe('x no');
    expect(renderStep('warn', 'hm', 'none', 'ascii')).toBe('! hm');
    expect(renderStep('pending', 'wait', 'none', 'ascii')).toBe('. wait');
  });

  it('wraps the braille frame index over the 10 frames', () => {
    expect(renderSpinnerFrame(0, 'x', 'none')).toBe('⠋ x');
    expect(renderSpinnerFrame(10, 'x', 'none')).toBe('⠋ x');
    expect(renderSpinnerFrame(-1, 'x', 'none')).toBe('⠏ x');
  });

  it('renders step glyphs with semantic colors', () => {
    expect(renderStep('done', 'Compiled', 'none')).toBe('✔ Compiled');
    expect(renderStep('fail', 'Nope', 'none')).toBe('✗ Nope');
    expect(renderStep('pending', 'Live URL', 'none')).toBe('◦ Live URL');
    expect(renderStep('done', 'Compiled', 'truecolor')).toContain(`${ESC}[38;2;34;197;94m`); // green
    expect(renderStep('fail', 'x', 'ansi256')).toMatch(/\[38;5;\d+m/); // 256-color rose
  });

  it('exposes the canonical symbol set', () => {
    expect(SYMBOLS).toEqual({ done: '✔', fail: '✗', warn: '⚠', pending: '◦' });
  });
});

describe('startSpinner', () => {
  const env: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ['NO_COLOR', 'CI', 'COLORTERM', 'NOODLE_ASCII', 'LANG'])
      env[k] = process.env[k];
    delete process.env.NO_COLOR;
    delete process.env.CI;
    delete process.env.NOODLE_ASCII;
    process.env.LANG = 'en_US.UTF-8'; // deterministic Unicode glyphs
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.useRealTimers();
  });

  it('plain (non-TTY) mode animates nothing and prints one escape-free line on succeed', () => {
    const { stream, out } = fakeStream(false);
    const sp = startSpinner('Deploying…', stream);
    expect(out()).toBe('');
    sp.succeed('Deployed');
    expect(out()).toBe(`✔ Deployed${LF}`);
    expect(out()).not.toContain(ESC);
  });

  it('animated TTY mode hides the cursor, paints a colored frame, and settles green', () => {
    process.env.COLORTERM = 'truecolor';
    vi.useFakeTimers();
    const { stream, out } = fakeStream(true);
    const sp = startSpinner('Deploying…', stream);
    expect(out()).toContain(`${ESC}[?25l`); // hide cursor
    expect(out()).toContain('⠋'); // first frame
    sp.succeed('Deployed');
    const all = out();
    expect(all).toContain('✔');
    expect(all).toContain(`${ESC}[38;2;34;197;94m`); // green check
    expect(all).toContain(`${ESC}[?25h`); // show cursor
  });

  it('still animates (256-color) on a non-truecolor terminal', () => {
    delete process.env.COLORTERM; // Terminal.app-style color TTY
    vi.useFakeTimers();
    const { stream, out } = fakeStream(true);
    const sp = startSpinner('Deploying…', stream);
    expect(out()).toContain(`${ESC}[?25l`);
    expect(out()).toMatch(/\[38;5;\d+m/); // 256-color, not 24-bit
    sp.stop();
  });

  it('treats CI as non-interactive even on a TTY', () => {
    process.env.CI = 'true';
    const { stream, out } = fakeStream(true);
    const sp = startSpinner('Deploying…', stream);
    expect(out()).toBe('');
    sp.succeed('Deployed');
    expect(out()).not.toContain(ESC);
  });
});
