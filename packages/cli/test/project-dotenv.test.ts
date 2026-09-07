import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readProjectDotenv } from '../src/project-dotenv.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'noodle-project-dotenv-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe('project .env', () => {
  it('parses ordinary dotenv syntax without expanding values', () => {
    const root = tempDir();
    writeFileSync(
      join(root, '.env'),
      [
        '# local app configuration',
        'API_TOKEN=secret-token',
        'export API_BASE_URL="https://api.example.com/v1"',
        "REGION='us west'",
        'LITERAL=$HOME',
        '',
      ].join('\n'),
    );

    expect(readProjectDotenv(root)).toEqual({
      path: join(root, '.env'),
      values: {
        API_TOKEN: 'secret-token',
        API_BASE_URL: 'https://api.example.com/v1',
        REGION: 'us west',
        LITERAL: '$HOME',
      },
    });
  });

  it('reads only the requested project root and never searches parent directories', () => {
    const parent = tempDir();
    const project = join(parent, 'project');
    mkdirSync(project);
    writeFileSync(join(parent, '.env'), 'PARENT_SECRET=must-not-load\n');

    expect(readProjectDotenv(project)).toBeUndefined();
  });

  it('rejects malformed input without disclosing its contents', () => {
    const root = tempDir();
    const disclosureMarker = 'CONFIDENTIAL_DOTENV_MARKER';
    writeFileSync(join(root, '.env'), `API_TOKEN=value\n${disclosureMarker}\n`);

    expect(() => readProjectDotenv(root)).toThrow('invalid .env syntax at line 2 (value redacted)');
    try {
      readProjectDotenv(root);
    } catch (error) {
      expect(String(error)).not.toContain(disclosureMarker);
    }
  });
});
