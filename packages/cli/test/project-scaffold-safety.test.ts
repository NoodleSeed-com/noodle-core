import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initProject } from '../src/project.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe('scaffold-owned write containment', () => {
  it.each([
    'directory',
    'file',
    'dangling-file',
  ] as const)('rejects a %s symlink before any scaffold writes, even with force', (kind) => {
    const root = mkdtempSync(join(tmpdir(), 'noodle-scaffold-safety-'));
    roots.push(root);
    const project = join(root, 'project');
    const outside = join(root, 'outside');
    mkdirSync(project);
    mkdirSync(outside);
    writeFileSync(join(project, 'noodle.json'), '{}\n');
    writeFileSync(join(outside, 'server.ts'), 'customer-owned');
    if (kind === 'directory') symlinkSync(outside, join(project, 'src'));
    else {
      mkdirSync(join(project, 'src'));
      symlinkSync(
        join(outside, kind === 'file' ? 'server.ts' : 'missing.ts'),
        join(project, 'src/server.ts'),
      );
    }
    expect(() => initProject({ dir: project, template: 'hello', force: true })).toThrow(
      /symbolic link/,
    );
    expect(readFileSync(join(outside, 'server.ts'), 'utf8')).toBe('customer-owned');
    expect(existsSync(join(outside, 'missing.ts'))).toBe(false);
    expect(existsSync(join(project, 'package.json'))).toBe(false);
  });
});
