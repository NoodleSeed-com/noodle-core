import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isExactPlatformAccountResetTargetMode,
  readPlatformAccountResetTargetFile,
} from '../src/commands/platform-account-reset-files.js';

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'noodle-account-reset-files-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('platform account-reset target files', () => {
  it('reads exactly three non-email principal IDs from a 0600 regular file', async () => {
    const file = writeTarget({
      schemaVersion: 1,
      principalIds: ['principal-one', 'principal-two', 'principal-three'],
    });

    await expect(readPlatformAccountResetTargetFile(file)).resolves.toEqual({
      schemaVersion: 1,
      principalIds: ['principal-one', 'principal-two', 'principal-three'],
    });
  });

  it('accepts a target file exactly 16 KiB long', async () => {
    const contents = JSON.stringify({ schemaVersion: 1, principalIds: ['one', 'two', 'three'] });
    const file = join(directory, 'exact-limit.json');
    writeFileSync(file, `${contents}${' '.repeat(16 * 1024 - Buffer.byteLength(contents))}`, {
      mode: 0o600,
    });
    chmodSync(file, 0o600);

    await expect(readPlatformAccountResetTargetFile(file)).resolves.toEqual({
      schemaVersion: 1,
      principalIds: ['one', 'two', 'three'],
    });
  });

  it('rejects symlinks without following them', async () => {
    const target = writeTarget({ schemaVersion: 1, principalIds: ['one', 'two', 'three'] });
    const link = join(directory, 'target-link.json');
    symlinkSync(target, link);

    await expect(readPlatformAccountResetTargetFile(link)).rejects.toThrow('target file');
  });

  it('rejects directories and file modes other than 0600', async () => {
    const target = writeTarget({ schemaVersion: 1, principalIds: ['one', 'two', 'three'] });
    const nested = join(directory, 'targets');
    mkdirSync(nested, { mode: 0o700 });
    chmodSync(target, 0o640);

    await expect(readPlatformAccountResetTargetFile(nested)).rejects.toThrow('target file');
    await expect(readPlatformAccountResetTargetFile(target)).rejects.toThrow('target file');
  });

  it.each([0o4600, 0o2600, 0o1600])('rejects a descriptor mode with special bits %#o', (mode) => {
    expect(isExactPlatformAccountResetTargetMode(mode)).toBe(false);
  });

  it('rejects files larger than 16 KiB', async () => {
    const file = join(directory, 'oversized.json');
    writeFileSync(file, `${' '.repeat(16 * 1024)}{}`, { mode: 0o600 });
    chmodSync(file, 0o600);

    await expect(readPlatformAccountResetTargetFile(file)).rejects.toThrow('target file');
  });

  it.each([
    ['malformed JSON', '{'],
    [
      'unknown keys',
      JSON.stringify({ schemaVersion: 1, principalIds: ['one', 'two', 'three'], email: 'x@y.z' }),
    ],
    [
      'email principal IDs',
      JSON.stringify({ schemaVersion: 1, principalIds: ['one@example.test', 'two', 'three'] }),
    ],
    [
      'duplicate principal IDs',
      JSON.stringify({ schemaVersion: 1, principalIds: ['one', 'one', 'three'] }),
    ],
    [
      'fewer than three targets',
      JSON.stringify({ schemaVersion: 1, principalIds: ['one', 'two'] }),
    ],
    [
      'more than three targets',
      JSON.stringify({ schemaVersion: 1, principalIds: ['one', 'two', 'three', 'four'] }),
    ],
  ])('rejects %s', async (_caseName, contents) => {
    const file = join(directory, 'invalid.json');
    writeFileSync(file, contents, { mode: 0o600 });
    chmodSync(file, 0o600);

    await expect(readPlatformAccountResetTargetFile(file)).rejects.toThrow('target file');
  });
});

function writeTarget(value: unknown): string {
  const file = join(directory, 'targets.json');
  writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}
