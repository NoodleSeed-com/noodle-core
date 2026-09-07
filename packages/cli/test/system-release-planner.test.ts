import {
  chmodSync,
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
import {
  applyVersionOverlay,
  canonicalDirectoryHash,
  highestBump,
  incrementVersion,
  materializeStagedVersion,
  planPackageRelease,
  validatePackageBaseline,
} from '../../../scripts/system-release-planner.mjs';

const roots: string[] = [];

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), 'noodle-release-planner-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('system release package planner', () => {
  it('hashes canonical package contents rather than directory enumeration order', () => {
    const left = temporaryRoot();
    const right = temporaryRoot();
    mkdirSync(join(left, 'nested'));
    mkdirSync(join(right, 'nested'));
    writeFileSync(join(left, 'nested', 'b.js'), 'export const b = 2;\n');
    writeFileSync(join(left, 'a.js'), 'export const a = 1;\n');
    writeFileSync(join(right, 'a.js'), 'export const a = 1;\n');
    writeFileSync(join(right, 'nested', 'b.js'), 'export const b = 2;\n');

    expect(canonicalDirectoryHash(left)).toBe(canonicalDirectoryHash(right));
    writeFileSync(join(right, 'nested', 'b.js'), 'export const b = 3;\n');
    expect(canonicalDirectoryHash(left)).not.toBe(canonicalDirectoryHash(right));
  });

  it('includes executable mode and refuses symlinks in the canonical package tree', () => {
    const left = temporaryRoot();
    const right = temporaryRoot();
    writeFileSync(join(left, 'bin.js'), '#!/usr/bin/env node\n');
    writeFileSync(join(right, 'bin.js'), '#!/usr/bin/env node\n');
    chmodSync(join(left, 'bin.js'), 0o755);
    chmodSync(join(right, 'bin.js'), 0o644);
    expect(canonicalDirectoryHash(left)).not.toBe(canonicalDirectoryHash(right));

    symlinkSync('bin.js', join(left, 'alias.js'));
    expect(() => canonicalDirectoryHash(left)).toThrow(/symlink/i);
  });

  it('uses the highest conventional severity and defaults changed output to patch', () => {
    expect(highestBump(['docs: explain release', 'fix: correct output'])).toBe('patch');
    expect(highestBump(['fix: correct output', 'feat: add command'])).toBe('minor');
    expect(highestBump(['feat!: replace contract', 'fix: follow-up'])).toBe('major');
    expect(highestBump(['feat: change\n\nBREAKING CHANGE: incompatible'])).toBe('major');
    expect(incrementVersion('0.35.0', 'patch')).toBe('0.35.1');
    expect(incrementVersion('0.35.0', 'minor')).toBe('0.36.0');
    expect(incrementVersion('0.35.0', 'major')).toBe('1.0.0');
  });

  it('reuses identical package output and versions only changed output', () => {
    const previous = {
      version: '0.35.0',
      tag: 'v0.35.0',
      sourceSha: 'a'.repeat(40),
      integrity: `sha512-${'A'.repeat(86)}==`,
      treeHash: `sha256:${'b'.repeat(64)}`,
    };
    expect(
      planPackageRelease({
        previous,
        candidateSha: 'c'.repeat(40),
        candidateTreeHash: previous.treeHash,
        commitMessages: ['feat: unrelated hosted change'],
        tagPrefix: 'v',
      }),
    ).toEqual({ changed: false, bump: null, package: previous });

    expect(
      planPackageRelease({
        previous,
        candidateSha: 'c'.repeat(40),
        candidateTreeHash: `sha256:${'d'.repeat(64)}`,
        commitMessages: ['fix: correction', 'feat: add command'],
        tagPrefix: 'v',
      }),
    ).toEqual({
      changed: true,
      bump: 'minor',
      package: {
        version: '0.36.0',
        tag: 'v0.36.0',
        sourceSha: 'c'.repeat(40),
        integrity: null,
        treeHash: `sha256:${'d'.repeat(64)}`,
      },
    });

    expect(() =>
      planPackageRelease({
        previous,
        candidateSha: previous.sourceSha,
        candidateTreeHash: `sha256:${'e'.repeat(64)}`,
        commitMessages: [],
        tagPrefix: 'v',
      }),
    ).toThrow(/same source/i);
  });

  it('fails closed unless the finalized manifest, npm, and source tag agree', () => {
    const baseline = {
      version: '1.2.0',
      tag: 'assistant-v1.2.0',
      sourceSha: 'a'.repeat(40),
      integrity: `sha512-${'A'.repeat(86)}==`,
      treeHash: `sha256:${'b'.repeat(64)}`,
    };
    const npm = { version: '1.2.0', latest: '1.2.0', integrity: baseline.integrity };
    expect(() =>
      validatePackageBaseline('@noodleseed/assistant', baseline, npm, baseline.sourceSha),
    ).not.toThrow();
    expect(() =>
      validatePackageBaseline('@noodleseed/assistant', baseline, npm, 'c'.repeat(40)),
    ).toThrow(/source tag/i);
    expect(() =>
      validatePackageBaseline(
        '@noodleseed/assistant',
        baseline,
        { ...npm, integrity: `sha512-${'B'.repeat(86)}==` },
        baseline.sourceSha,
      ),
    ).toThrow(/integrity/i);
  });

  it('marks registry-only baseline drift as retryable while source-tag drift stays fatal', () => {
    const baseline = {
      version: '1.2.0',
      tag: 'assistant-v1.2.0',
      sourceSha: 'a'.repeat(40),
      integrity: `sha512-${'A'.repeat(86)}==`,
      treeHash: `sha256:${'b'.repeat(64)}`,
    };
    const npm = { version: '1.2.0', latest: '1.2.0', integrity: baseline.integrity };

    let versionDrift: unknown;
    try {
      validatePackageBaseline(
        '@noodleseed/assistant',
        baseline,
        { ...npm, latest: '1.3.0' },
        baseline.sourceSha,
      );
    } catch (error) {
      versionDrift = error;
    }
    expect((versionDrift as { exitCode?: number })?.exitCode).toBe(4);

    let integrityDrift: unknown;
    try {
      validatePackageBaseline(
        '@noodleseed/assistant',
        baseline,
        { ...npm, integrity: `sha512-${'B'.repeat(86)}==` },
        baseline.sourceSha,
      );
    } catch (error) {
      integrityDrift = error;
    }
    expect((integrityDrift as { exitCode?: number })?.exitCode).toBe(4);

    let tagDrift: unknown;
    try {
      validatePackageBaseline('@noodleseed/assistant', baseline, npm, 'c'.repeat(40));
    } catch (error) {
      tagDrift = error;
    }
    expect((tagDrift as { exitCode?: number })?.exitCode).toBeUndefined();
  });

  it('accepts an adopted baseline whose tags were never created, npm state permitting', () => {
    // A predecessor that published npm but failed before finalize has no component tags; the
    // adopted-baseline path passes tagSha null while every registry check still holds.
    const baseline = {
      version: '1.2.0',
      tag: 'assistant-v1.2.0',
      sourceSha: 'a'.repeat(40),
      integrity: `sha512-${'A'.repeat(86)}==`,
      treeHash: `sha256:${'b'.repeat(64)}`,
    };
    const npm = { version: '1.2.0', latest: '1.2.0', integrity: baseline.integrity };
    expect(() =>
      validatePackageBaseline('@noodleseed/assistant', baseline, npm, null),
    ).not.toThrow();
    expect(() =>
      validatePackageBaseline('@noodleseed/assistant', baseline, { ...npm, latest: '1.1.0' }, null),
    ).toThrow(/npm latest/i);
  });

  it('overlays all released package identities without committing version files', () => {
    const root = temporaryRoot();
    for (const path of [
      'packages/cli',
      'packages/agent-kit',
      'packages/agent-kit/publish',
      'packages/assistant',
    ]) {
      mkdirSync(join(root, path), { recursive: true });
      writeFileSync(
        join(root, path, 'package.json'),
        '{"name":"fixture","version":"0.0.0-development"}\n',
      );
    }

    applyVersionOverlay(root, {
      cli: '0.36.0',
      'agent-kit': '0.23.0',
      assistant: '1.3.0',
    });

    const version = (path: string) =>
      JSON.parse(readFileSync(join(root, path, 'package.json'), 'utf8')).version;
    expect(version('packages/cli')).toBe('0.36.0');
    expect(version('packages/agent-kit')).toBe('0.23.0');
    expect(version('packages/agent-kit/publish')).toBe('0.23.0');
    expect(version('packages/assistant')).toBe('1.3.0');
  });

  it('materializes a planned version into a staged publish tree without touching other fields', () => {
    // Every published package resolves its version from package.json at runtime, so the
    // candidate lane repacks the already-built staged tree instead of rebuilding it.
    const root = temporaryRoot();
    writeFileSync(
      join(root, 'package.json'),
      '{"name":"@noodleseed/one","version":"0.35.1","bin":{"noodle":"dist/cli.js"}}\n',
    );
    materializeStagedVersion(root, '0.36.0');
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.version).toBe('0.36.0');
    expect(pkg.name).toBe('@noodleseed/one');
    expect(pkg.bin).toEqual({ noodle: 'dist/cli.js' });

    expect(() => materializeStagedVersion(root, 'not-a-version')).toThrow(
      /invalid release version/,
    );
    expect(() => materializeStagedVersion(join(root, 'missing'), '0.36.0')).toThrow();
  });
});
