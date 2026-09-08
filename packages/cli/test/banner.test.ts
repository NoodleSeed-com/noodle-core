import { afterEach, describe, expect, it, vi } from 'vitest';
import { printBanner, renderBanner } from '../src/banner.js';

const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
const setTty = (value: boolean): void => {
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value });
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (ttyDescriptor) Object.defineProperty(process.stdout, 'isTTY', ttyDescriptor);
  else Reflect.deleteProperty(process.stdout, 'isTTY');
});

describe('onboarding wordmark', () => {
  it('restores the original block letters with a static warm gradient', () => {
    const plain = renderBanner('none', 'unicode', 100);
    expect(plain).toContain('███╗   ██╗ ██████╗');
    expect(plain).toContain('Welcome to Noodle Seed!');
    for (const mode of ['truecolor', 'ansi256'] as const) {
      const colored = renderBanner(mode, 'unicode', 100);
      const colorCodes = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
      expect(colored.replace(colorCodes, '')).toBe(plain);
    }
  });

  it('fits narrow terminals and uses plain letters when Unicode is unavailable', () => {
    for (const [glyph, width] of [
      ['unicode', 40],
      ['ascii', 100],
    ] as const) {
      const text = renderBanner('none', glyph, width);
      expect(text).toContain('NOODLE SEED');
      expect(text).not.toContain('█');
      expect(text).not.toContain('\u001b');
      expect(Math.max(...text.split('\n').map((line) => [...line].length))).toBeLessThanOrEqual(
        width,
      );
    }
  });

  it('prints once on a TTY, without escapes under NO_COLOR', () => {
    vi.stubEnv('CI', undefined);
    vi.stubEnv('NO_COLOR', '1');
    setTty(true);
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    printBanner();
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0]?.[0]).toContain('Welcome to Noodle Seed!');
    expect(write.mock.calls[0]?.[0]).not.toContain('\u001b');
  });

  it('does not write for pipes, CI, or JSON even on a TTY', () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    setTty(false);
    printBanner();
    setTty(true);
    vi.stubEnv('CI', 'true');
    printBanner();
    vi.stubEnv('CI', undefined);
    printBanner({ json: true });
    expect(write).not.toHaveBeenCalled();
  });
});
