import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  resolveConventionalEntrypoint,
  resolveLocalEntrypoint,
  writeProjectLink,
} from '../src/index.js';

describe('local entrypoint resolution', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'noodle-entrypoint-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  it('returns undefined when no conventional entrypoint exists', () => {
    expect(resolveConventionalEntrypoint(dir)).toBeUndefined();
    expect(resolveLocalEntrypoint(dir)).toBeUndefined();
  });
  it('finds a conventional server.ts with no project link', () => {
    writeFileSync(join(dir, 'server.ts'), 'export default {};\n');
    expect(resolveConventionalEntrypoint(dir)).toBe(join(dir, 'server.ts'));
    expect(resolveLocalEntrypoint(dir)).toBe(join(dir, 'server.ts'));
  });
  it('prefers src/server.ts over legacy root entrypoints', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'index.ts'), 'export default {};\n');
    writeFileSync(join(dir, 'manifest.ts'), 'export default {};\n');
    writeFileSync(join(dir, 'server.ts'), 'export default {};\n');
    writeFileSync(join(dir, 'src', 'server.ts'), 'export default {};\n');
    expect(resolveConventionalEntrypoint(dir)).toBe(join(dir, 'src', 'server.ts'));
  });
  it('prefers a linked entrypoint over the conventional default', () => {
    writeFileSync(join(dir, 'server.ts'), 'export default {};\n');
    writeFileSync(join(dir, 'app.ts'), 'export default {};\n');
    writeProjectLink({
      org: 'acme',
      app: 'demo',
      entrypoint: 'app.ts',
      cwd: dir,
    });
    expect(resolveLocalEntrypoint(dir)).toBe(join(dir, 'app.ts'));
  });
});
