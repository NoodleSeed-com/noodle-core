import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readBootstrapState, writeBootstrapState } from '../src/project-bootstrap-state.js';

const directories: string[] = [];
function scratch() {
  const path = mkdtempSync(join(tmpdir(), 'noodle-setup-state-'));
  directories.push(path);
  return path;
}
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const state = {
  schemaVersion: 1 as const,
  cliVersion: '1.2.3',
  packageManager: 'npm' as const,
  managerVersion: '11.12.0',
  completed: ['scaffold'] as const,
};

describe('private resumable bootstrap state', () => {
  it('stores only validated bounded metadata with private permissions', () => {
    const project = scratch();
    expect(readBootstrapState(project)).toBeUndefined();
    writeBootstrapState(project, state);
    expect(readBootstrapState(project)).toEqual(state);
    expect(statSync(join(project, '.noodle/setup.json')).mode & 0o777).toBe(0o600);
    const resumed = { ...state, inProgress: 'install' as const };
    writeBootstrapState(project, resumed);
    expect(readBootstrapState(project)).toEqual(resumed);
  });

  it('refuses malformed and foreign state without overwriting it or reflecting its contents', () => {
    const project = scratch();
    mkdirSync(join(project, '.noodle'));
    const file = join(project, '.noodle/setup.json');
    const privateContent = '{"private":"do-not-reflect",';
    writeFileSync(file, privateContent);
    expect(() => readBootstrapState(project)).toThrow(
      'Bootstrap state is unreadable or not owned by this setup format.',
    );
    expect(() => writeBootstrapState(project, state)).toThrow(/Bootstrap state/);
    expect(readFileSync(file, 'utf8')).toBe(privateContent);
  });

  it('refuses symlinked directories and state files without touching their targets', () => {
    const project = scratch();
    const outside = scratch();
    symlinkSync(outside, join(project, '.noodle'), 'dir');
    expect(() => writeBootstrapState(project, state)).toThrow(/Bootstrap state/);
    expect(existsSync(join(outside, 'setup.json'))).toBe(false);
    rmSync(join(project, '.noodle'));
    mkdirSync(join(project, '.noodle'));
    writeFileSync(join(outside, 'target'), 'customer-owned');
    symlinkSync(join(outside, 'target'), join(project, '.noodle/setup.json'));
    expect(() => readBootstrapState(project)).toThrow(/Bootstrap state/);
    expect(() => writeBootstrapState(project, state)).toThrow(/Bootstrap state/);
    expect(readFileSync(join(outside, 'target'), 'utf8')).toBe('customer-owned');
  });

  it('refuses dangling symlinks instead of mistaking them for missing state', () => {
    const project = scratch();
    symlinkSync(join(project, 'missing'), join(project, '.noodle'));
    expect(() => readBootstrapState(project)).toThrow(/Bootstrap state/);
    expect(() => writeBootstrapState(project, state)).toThrow(/Bootstrap state/);
    expect(existsSync(join(project, 'missing'))).toBe(false);
  });
});
