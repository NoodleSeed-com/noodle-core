import { afterEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/cli.js';
import { platformSupportFailure } from '../src/platform-support.js';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

afterEach(() => {
  vi.restoreAllMocks();
  if (originalPlatform !== undefined) Object.defineProperty(process, 'platform', originalPlatform);
});

describe('native Windows platform policy', () => {
  it.each([
    ['--help'],
    ['-h'],
    ['help'],
    ['--version'],
    ['-v'],
    ['version'],
  ])('allows %s so Windows users can discover the WSL handoff', (...argv) => {
    expect(platformSupportFailure(argv, 'win32')).toBeUndefined();
  });

  it('does not restrict macOS or Linux commands', () => {
    expect(platformSupportFailure(['deploy'], 'darwin')).toBeUndefined();
    expect(platformSupportFailure(['deploy'], 'linux')).toBeUndefined();
  });

  it('returns a stable unsupported_platform failure for native Windows commands', () => {
    expect(platformSupportFailure(['deploy'], 'win32')).toEqual({
      code: 'unsupported_platform',
      message: 'Noodle CLI commands run on macOS or Windows through WSL2.',
      cause: 'Native PowerShell, Command Prompt, and Git Bash are not supported.',
      fix: 'Install WSL2 with Ubuntu and run Noodle from its Bash shell.',
      next: 'wsl --install -d Ubuntu',
    });
  });

  it('stops before command dispatch and prints human recovery guidance', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await run(['deploy'], { NOODLE_UPDATE_MODE: 'off' }, '/unused')).toBe(2);
    expect(log).not.toHaveBeenCalled();
    expect(error.mock.calls.flat().join('\n')).toContain('unsupported_platform');
    expect(error.mock.calls.flat().join('\n')).toContain('wsl --install -d Ubuntu');
  });

  it('emits the standard JSON failure envelope when requested', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await run(['deploy', '--json'], { NOODLE_UPDATE_MODE: 'off' }, '/unused')).toBe(2);
    expect(error).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      ok: false,
      error: {
        code: 'unsupported_platform',
        message: 'Noodle CLI commands run on macOS or Windows through WSL2.',
        cause: 'Native PowerShell, Command Prompt, and Git Bash are not supported.',
        fix: 'Install WSL2 with Ubuntu and run Noodle from its Bash shell.',
        next: 'wsl --install -d Ubuntu',
      },
    });
  });
});
