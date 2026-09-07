import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveLocalEntrypoint, resolveLocalEntrypointResult } from '../src/project.js';

describe.sequential('source-aware local entrypoint resolution', () => {
  let dir: string;
  let previousEnvironmentEntrypoint: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'noodle-entrypoint-resolution-'));
    previousEnvironmentEntrypoint = process.env.NOODLE_ENTRYPOINT;
    delete process.env.NOODLE_ENTRYPOINT;
  });

  afterEach(() => {
    if (previousEnvironmentEntrypoint === undefined) delete process.env.NOODLE_ENTRYPOINT;
    else process.env.NOODLE_ENTRYPOINT = previousEnvironmentEntrypoint;
    rmSync(dir, { recursive: true, force: true });
  });

  function writeJson(path: string, value: unknown): void {
    writeFileSync(join(dir, path), `${JSON.stringify(value, null, 2)}\n`);
  }

  it('retains a valid noodle.json entrypoint source and authored value', () => {
    mkdirSync(join(dir, 'app'));
    writeFileSync(join(dir, 'app', 'server.ts'), 'export default {};\n');
    writeJson('noodle.json', { entrypoint: 'app/server.ts' });

    expect(resolveLocalEntrypointResult(dir)).toEqual({
      source: 'noodle.json',
      value: 'app/server.ts',
      path: join(dir, 'app', 'server.ts'),
      exists: true,
    });
  });

  it('keeps a stale local link selected and reports a valid lower-precedence recovery', () => {
    mkdirSync(join(dir, '.noodle'));
    mkdirSync(join(dir, 'app'));
    writeFileSync(join(dir, 'app', 'server.ts'), 'export default {};\n');
    writeJson('.noodle/project.json', { entrypoint: 'server.ts' });
    writeJson('noodle.json', { entrypoint: 'app/server.ts' });

    expect(resolveLocalEntrypointResult(dir)).toEqual({
      source: '.noodle/project.json',
      value: 'server.ts',
      path: join(dir, 'server.ts'),
      exists: false,
      recoveryValue: 'app/server.ts',
    });
    expect(resolveLocalEntrypoint(dir)).toBeUndefined();
  });

  it('keeps a stale environment entrypoint selected ahead of valid saved configuration', () => {
    mkdirSync(join(dir, '.noodle'));
    writeFileSync(join(dir, 'local.ts'), 'export default {};\n');
    writeJson('.noodle/project.json', { entrypoint: 'local.ts' });
    writeJson('noodle.json', { entrypoint: 'project.ts' });
    process.env.NOODLE_ENTRYPOINT = 'environment.ts';

    expect(resolveLocalEntrypointResult(dir)).toEqual({
      source: 'NOODLE_ENTRYPOINT',
      value: 'environment.ts',
      path: join(dir, 'environment.ts'),
      exists: false,
      recoveryValue: 'local.ts',
    });
  });

  it('uses conventional discovery only when no configured entrypoint exists', () => {
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'server.ts'), 'export default {};\n');

    expect(resolveLocalEntrypointResult(dir)).toEqual({
      source: 'conventional discovery',
      value: 'src/server.ts',
      path: join(dir, 'src', 'server.ts'),
      exists: true,
    });
  });
});
