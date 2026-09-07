import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type BinaryProbeDeps,
  inspectNoodleBinary,
  realBinaryProbeDeps,
} from '../src/update-binary.js';

/**
 * Part 4 of the robust-update work (#242): classify the existing global `noodle`
 * binary as SAFE to repair (provably ours or a dangling link) or UNSAFE (anything
 * ambiguous). Every case runs against a throwaway temp prefix + injected deps —
 * never the real global prefix.
 */
describe('noodle binary ownership resolver', () => {
  const tmps: string[] = [];

  afterEach(() => {
    for (const t of tmps.splice(0)) rmSync(t, { recursive: true, force: true });
  });

  /** Create a fake node prefix: `<root>/bin/node` + empty bin dir. */
  function scaffold(): { root: string; binDir: string; execPath: string; binPath: string } {
    const root = mkdtempSync(join(tmpdir(), 'noodle-bin-'));
    tmps.push(root);
    const binDir = join(root, 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'node'), '#!/bin/sh\n');
    return { root, binDir, execPath: join(binDir, 'node'), binPath: join(binDir, 'noodle') };
  }

  /** Materialize `<root>/lib/node_modules/<pkg>/dist/bin.js` and return its path. */
  function pkgFile(root: string, pkg: string): string {
    const file = join(root, 'lib', 'node_modules', pkg, 'dist', 'bin.js');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '#!/usr/bin/env node\n');
    return file;
  }

  const inspect = (execPath: string) => inspectNoodleBinary(realBinaryProbeDeps({ execPath }));

  it('reports the expected bin dir and bin path derived from the running node prefix', () => {
    const { binDir, execPath, binPath } = scaffold();
    const result = inspect(execPath);
    expect(result.expectedBinDir).toBe(binDir);
    expect(result.binPath).toBe(binPath);
  });

  it('reports none when no binary exists at the expected global bin path', () => {
    const { execPath } = scaffold();
    expect(inspect(execPath).status).toEqual({ kind: 'none' });
  });

  it('classifies a healthy symlink into the same-prefix @noodleseed/one package as the active install', () => {
    const { root, execPath, binPath } = scaffold();
    const target = pkgFile(root, '@noodleseed/one');
    symlinkSync(target, binPath);
    expect(inspect(execPath).status.kind).toBe('active-install');
  });

  it('classifies a relative healthy symlink into the same-prefix package as the active install', () => {
    const { root, execPath, binPath } = scaffold();
    pkgFile(root, '@noodleseed/one');
    symlinkSync(join('..', 'lib', 'node_modules', '@noodleseed', 'one', 'dist', 'bin.js'), binPath);
    expect(inspect(execPath).status.kind).toBe('active-install');
  });

  it('classifies a symlink into an @noodleseed/one package under another prefix as safe to repair', () => {
    const { execPath, binPath } = scaffold();
    const other = mkdtempSync(join(tmpdir(), 'noodle-old-prefix-'));
    tmps.push(other);
    const target = pkgFile(other, '@noodleseed/one');
    symlinkSync(target, binPath);
    const status = inspect(execPath).status;
    expect(status.kind).toBe('safe-repair');
    expect(status.kind === 'safe-repair' && status.reason.length > 0).toBe(true);
  });

  it('classifies a broken symlink as safe to repair', () => {
    const { root, execPath, binPath } = scaffold();
    symlinkSync(join(root, 'lib', 'node_modules', 'gone', 'bin.js'), binPath);
    expect(inspect(execPath).status.kind).toBe('safe-repair');
  });

  it('classifies a symlink into the legacy noodleseed-cli package as safe to repair', () => {
    const { root, execPath, binPath } = scaffold();
    const target = pkgFile(root, 'noodleseed-cli');
    symlinkSync(target, binPath);
    expect(inspect(execPath).status.kind).toBe('safe-repair');
  });

  it('classifies a symlink into another package as unsafe', () => {
    const { root, execPath, binPath } = scaffold();
    const target = pkgFile(root, 'other-cli');
    symlinkSync(target, binPath);
    expect(inspect(execPath).status.kind).toBe('unsafe');
  });

  it('classifies a working symlink to a non-package file as unsafe', () => {
    const { root, execPath, binPath } = scaffold();
    const target = join(root, 'somewhere-else');
    writeFileSync(target, '#!/bin/sh\n');
    symlinkSync(target, binPath);
    expect(inspect(execPath).status.kind).toBe('unsafe');
  });

  it('classifies a real file with unknown content as unsafe', () => {
    const { execPath, binPath } = scaffold();
    writeFileSync(binPath, '#!/bin/sh\necho hi\n');
    expect(inspect(execPath).status.kind).toBe('unsafe');
  });

  it('classifies a real launcher file that references @noodleseed/one as safe to repair', () => {
    const { execPath, binPath } = scaffold();
    writeFileSync(
      binPath,
      '#!/bin/sh\nexec node "$(dirname "$0")/../lib/node_modules/@noodleseed/one/dist/bin.js" "$@"\n',
    );
    expect(inspect(execPath).status.kind).toBe('safe-repair');
  });

  it('treats probe failures as unsafe (ambiguous is never safe)', () => {
    const deps: BinaryProbeDeps = {
      execPath: '/prefix/bin/node',
      lstatKind: () => 'error',
      readlink: () => undefined,
      realpath: () => undefined,
      readFileHead: () => undefined,
    };
    expect(inspectNoodleBinary(deps).status.kind).toBe('unsafe');
  });

  it('treats a directory (or other non-file) at the bin path as unsafe', () => {
    const deps: BinaryProbeDeps = {
      execPath: '/prefix/bin/node',
      lstatKind: () => 'dir',
      readlink: () => undefined,
      realpath: () => undefined,
      readFileHead: () => undefined,
    };
    expect(inspectNoodleBinary(deps).status.kind).toBe('unsafe');
  });

  it('treats an unreadable symlink as unsafe', () => {
    const deps: BinaryProbeDeps = {
      execPath: '/prefix/bin/node',
      lstatKind: (path) => (path.endsWith('/noodle') ? 'symlink' : 'missing'),
      readlink: () => undefined,
      realpath: () => undefined,
      readFileHead: () => undefined,
    };
    expect(inspectNoodleBinary(deps).status.kind).toBe('unsafe');
  });
});
