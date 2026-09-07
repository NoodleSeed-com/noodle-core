import { describe, expect, it, vi } from 'vitest';
import { presentUrl } from '../src/browser.js';

describe('presentUrl', () => {
  it('always prints the URL and skips opening in headless mode', async () => {
    const events: string[] = [];
    const open = vi.fn(async () => {
      events.push('open');
    });

    expect(
      await presentUrl('https://example.test/setup', {
        shouldOpen: false,
        open,
        print: (url) => events.push(`print:${url}`),
      }),
    ).toBe(false);
    expect(events).toEqual(['print:https://example.test/setup']);
    expect(open).not.toHaveBeenCalled();
  });

  it('prints before asking the shared opener to launch the browser', async () => {
    const events: string[] = [];

    expect(
      await presentUrl('https://example.test/setup', {
        shouldOpen: true,
        open: async (url) => {
          events.push(`open:${url}`);
        },
        print: (url) => events.push(`print:${url}`),
      }),
    ).toBe(true);
    expect(events).toEqual(['print:https://example.test/setup', 'open:https://example.test/setup']);
  });

  it('keeps the printed fallback usable when browser launch fails', async () => {
    const printed: string[] = [];
    const warned: string[] = [];

    expect(
      await presentUrl('https://example.test/setup', {
        shouldOpen: true,
        open: async () => {
          throw new Error('launcher missing');
        },
        print: (url) => printed.push(url),
        warn: (message) => warned.push(message),
      }),
    ).toBe(false);
    expect(printed).toEqual(['https://example.test/setup']);
    expect(warned.join('\n')).toContain('Could not open a browser');
    expect(warned.join('\n')).toContain('launcher missing');
  });
});
