import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadDevtoolsEnv, parseDotenv } from '../src/devtools-env.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'noodle-devenv-'));
  dirs.push(d);
  return d;
}

describe('devtools env — parseDotenv', () => {
  it('parses KEY=VALUE, tolerating comments, blanks, quotes, and an export prefix', () => {
    const parsed = parseDotenv(
      ['# a comment', '', 'OPENAI_API_KEY=sk-plain', 'export OPENAI_MODEL="gpt-5.5"', "X='q'"].join(
        '\n',
      ),
    );
    expect(parsed).toEqual({ OPENAI_API_KEY: 'sk-plain', OPENAI_MODEL: 'gpt-5.5', X: 'q' });
  });

  it('ignores malformed lines without a valid key', () => {
    expect(parseDotenv('no-equals-here\n=novalue\n123BAD=x\nOK_KEY=1')).toEqual({ OK_KEY: '1' });
  });
});

describe('devtools env — loadDevtoolsEnv', () => {
  it('loads only OPENAI_* vars into the environment, skipping unrelated keys', () => {
    const dir = tempDir();
    writeFileSync(join(dir, '.env.local'), 'OPENAI_API_KEY=sk-file\nPATH=/evil\nOPENAI_MODEL=m1\n');
    const env: Record<string, string | undefined> = {};
    const result = loadDevtoolsEnv(dir, { env });
    expect(env.OPENAI_API_KEY).toBe('sk-file');
    expect(env.OPENAI_MODEL).toBe('m1');
    // A non-OPENAI key must never be pulled in from the file.
    expect(env.PATH).toBeUndefined();
    expect(result.file).toContain('.env.local');
    expect(result.keys).toEqual(['OPENAI_API_KEY', 'OPENAI_MODEL']);
  });

  it('never overrides a value already present in the environment', () => {
    const dir = tempDir();
    writeFileSync(join(dir, '.env.local'), 'OPENAI_API_KEY=sk-file\n');
    const env: Record<string, string | undefined> = { OPENAI_API_KEY: 'sk-shell' };
    const result = loadDevtoolsEnv(dir, { env });
    expect(env.OPENAI_API_KEY).toBe('sk-shell');
    expect(result.keys).toEqual([]);
  });

  it('prefers .env.local over .env when both define the same key', () => {
    const dir = tempDir();
    writeFileSync(join(dir, '.env.local'), 'OPENAI_API_KEY=from-local\n');
    writeFileSync(join(dir, '.env'), 'OPENAI_API_KEY=from-env\n');
    const env: Record<string, string | undefined> = {};
    loadDevtoolsEnv(dir, { env });
    expect(env.OPENAI_API_KEY).toBe('from-local');
  });

  it('returns an empty result when no env file exists', () => {
    const result = loadDevtoolsEnv(tempDir(), { env: {} });
    expect(result.keys).toEqual([]);
    expect(result.file).toBeUndefined();
  });
});
