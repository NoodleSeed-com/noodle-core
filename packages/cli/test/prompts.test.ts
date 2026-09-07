import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AbortPromptError,
  isInteractive,
  MissingAnswerError,
  renderSelect,
  renderSelectResult,
  renderText,
  renderTextResult,
  resolveAnswer,
  select,
} from '../src/prompts.js';

const ESC = String.fromCharCode(27);

describe('prompt renderers', () => {
  const options = [
    { value: 'a', label: 'Deploy', hint: 'to the cloud' },
    { value: 'b', label: 'Local' },
  ];

  it('renders a select menu with a warm pointer on the active row (truecolor)', () => {
    const lines = renderSelect('Where?', options, 0, 'truecolor');
    expect(lines[0]).toContain('Where?');
    expect(lines[1]).toContain('❯');
    expect(lines[1]).toContain('Deploy');
    expect(lines[1]).toContain('to the cloud');
    expect(lines.join('')).toMatch(/\[38;2;\d+;\d+;\d+m/); // 24-bit
  });

  it('uses 256-color (no 24-bit) on a non-truecolor terminal', () => {
    const lines = renderSelect('Where?', options, 0, 'ansi256');
    expect(lines.join('')).toMatch(/\[38;5;\d+m/);
    expect(lines.join('')).not.toMatch(/\[38;2;/);
  });

  it('degrades to an ASCII pointer with no escapes', () => {
    const lines = renderSelect('Where?', options, 1, 'none', 'ascii');
    expect(lines.join('\n')).not.toContain(ESC);
    expect(lines[2]).toContain('> Local'); // ASCII pointer on the active row
  });

  it('renders settled select/text results (Unicode + ASCII fallback)', () => {
    expect(renderSelectResult('Template', 'hello', 'none')).toBe('✔ Template hello');
    expect(renderSelectResult('Template', 'hello', 'none', 'ascii')).toBe('+ Template hello');
    expect(renderSelectResult('Template', 'hello', 'truecolor')).toContain('✔');
    expect(renderText('Name', 'my-server', 'none')).toBe('? Name › my-server');
    expect(renderText('Name', 'my-server', 'none', 'ascii')).toBe('? Name > my-server');
    expect(renderTextResult('Name', 'my-server', 'none', 'ascii')).toBe('+ Name my-server');
  });
});

describe('isInteractive', () => {
  let prevNoColor: string | undefined;
  let prevCI: string | undefined;
  beforeEach(() => {
    prevNoColor = process.env.NO_COLOR;
    prevCI = process.env.CI;
    delete process.env.NO_COLOR;
    delete process.env.CI;
  });
  afterEach(() => {
    if (prevNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = prevNoColor;
    if (prevCI === undefined) delete process.env.CI;
    else process.env.CI = prevCI;
  });

  it('is true on a TTY input+output, false when either isn’t a TTY', () => {
    expect(isInteractive({ isTTY: true }, { isTTY: true })).toBe(true);
    expect(isInteractive({ isTTY: false }, { isTTY: true })).toBe(false);
    expect(isInteractive({ isTTY: true }, { isTTY: false })).toBe(false);
  });

  it('stays interactive under NO_COLOR (just uncolored), but not under CI', () => {
    process.env.NO_COLOR = '1';
    expect(isInteractive({ isTTY: true }, { isTTY: true })).toBe(true);
    delete process.env.NO_COLOR;
    process.env.CI = 'true';
    expect(isInteractive({ isTTY: true }, { isTTY: true })).toBe(false);
  });
});

describe('resolveAnswer (the interactive/non-interactive seam)', () => {
  it('returns a supplied answer', () => {
    expect(resolveAnswer({ org: 'acme' }, 'org', '--org')).toBe('acme');
  });
  it('falls back to a default when not supplied', () => {
    expect(resolveAnswer({}, 'template', '--template', 'hello')).toBe('hello');
    expect(resolveAnswer(undefined, 'template', '--template', 'hello')).toBe('hello');
  });
  it('throws MissingAnswerError (naming the flag) when neither supplied nor defaulted', () => {
    try {
      resolveAnswer({}, 'org', '--org');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MissingAnswerError);
      expect((err as MissingAnswerError).key).toBe('org');
      expect((err as MissingAnswerError).flag).toBe('--org');
      expect((err as Error).message).toContain('--org');
    }
  });
});

describe('error types', () => {
  it('AbortPromptError is identifiable', () => {
    expect(new AbortPromptError()).toBeInstanceOf(AbortPromptError);
    expect(new AbortPromptError().name).toBe('AbortPromptError');
  });
});

/** A fake TTY input/output pair to drive the stateful keypress handlers directly. */
function fakeTTY(opts: { initiallyPaused?: boolean } = {}) {
  const input = new PassThrough() as unknown as NodeJS.ReadStream & { isRaw: boolean };
  input.isTTY = true;
  input.isRaw = false;
  let pauses = 0;
  let resumes = 0;
  let paused = opts.initiallyPaused ?? true;
  const originalPause = input.pause.bind(input);
  const originalResume = input.resume.bind(input);
  input.isPaused = (() => paused) as NodeJS.ReadStream['isPaused'];
  input.pause = (() => {
    pauses += 1;
    paused = true;
    return originalPause();
  }) as NodeJS.ReadStream['pause'];
  input.resume = (() => {
    resumes += 1;
    paused = false;
    return originalResume();
  }) as NodeJS.ReadStream['resume'];
  input.setRawMode = ((v: boolean) => {
    input.isRaw = v;
    return input;
  }) as NodeJS.ReadStream['setRawMode'];
  const writes: string[] = [];
  const output = {
    isTTY: true,
    columns: 80,
    write: (s: string) => {
      writes.push(s);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return {
    input,
    output,
    out: () => writes.join(''),
    writes,
    pauses: () => pauses,
    resumes: () => resumes,
  };
}

describe('interactive select (keypress handlers)', () => {
  const options = [
    { value: 'a', label: 'A' },
    { value: 'b', label: 'B' },
    { value: 'c', label: 'C' },
  ];

  it('resolves the option navigated to with arrows + Enter, and restores the cursor', async () => {
    const { input, output, out, pauses, resumes, writes } = fakeTTY();
    const p = select('Pick', options, { input, output });
    input.emit('keypress', '', { name: 'down' }); // A -> B
    input.emit('keypress', '', { name: 'down' }); // B -> C
    input.emit('keypress', '', { name: 'up' }); // C -> B
    input.emit('keypress', '', { name: 'return' });
    await expect(p).resolves.toBe('b');
    expect(input.isRaw).toBe(false); // raw mode restored
    expect(out()).toContain(`${String.fromCharCode(27)}[?25h`); // cursor shown again
    expect(resumes()).toBeGreaterThanOrEqual(1);
    expect(pauses()).toBe(1);
    expect(writes.at(-1)).toContain(`${String.fromCharCode(13)}${String.fromCharCode(27)}[K`);
  });

  it('pauses stdin after resolving even when stdin was already flowing', async () => {
    const { input, output, pauses } = fakeTTY({ initiallyPaused: false });
    const p = select('Pick', options, { input, output });
    input.emit('keypress', '', { name: 'return' });
    await expect(p).resolves.toBe('a');
    expect(input.isRaw).toBe(false);
    expect(pauses()).toBe(1);
  });

  it('rejects AbortPromptError on Escape', async () => {
    const { input, output } = fakeTTY();
    const p = select('Pick', options, { input, output });
    input.emit('keypress', '', { name: 'escape' });
    await expect(p).rejects.toBeInstanceOf(AbortPromptError);
  });

  it('rejects a RangeError for an empty option list (before raw mode)', async () => {
    const { input, output } = fakeTTY();
    await expect(select('Pick', [], { input, output })).rejects.toBeInstanceOf(RangeError);
    expect(input.isRaw).toBe(false); // never entered raw mode
  });
});
