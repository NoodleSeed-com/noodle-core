import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = join(import.meta.dirname, '../../..');
const script = join(repoRoot, 'scripts/package-boundary-gate.mjs');
const roots: string[] = [];
const envelope = {
  path: 'packages/demo',
  role: 'library',
  maxSourceLines: 20,
  reason: 'One cohesive published customer SDK, with a fixed growth allowance.',
};

function write(root: string, file: string, content: string) {
  mkdirSync(join(root, file, '..'), { recursive: true });
  writeFileSync(join(root, file), content);
}

function config(root: string, overrides: Record<string, unknown> = {}) {
  write(
    root,
    'quality-gates.config.json',
    JSON.stringify({
      packageScopes: {
        defaultMaxSourceLines: 10,
        warningRatio: 0.85,
        envelopes: [envelope],
        ...overrides,
      },
    }),
  );
}

function fixture(lines = 12) {
  const root = mkdtempSync(join(tmpdir(), 'noodle-scope-policy-'));
  roots.push(root);
  write(
    root,
    'packages/demo/package.json',
    JSON.stringify({
      name: '@noodle-borg/demo',
      license: 'Apache-2.0',
    }),
  );
  write(root, 'packages/demo/src/index.ts', '// source\n'.repeat(lines));
  config(root);
  return root;
}

function git(root: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

function commit(root: string) {
  git(root, 'add', '-A');
  git(
    root,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'fixture',
  );
  return git(root, 'rev-parse', 'HEAD');
}

function run(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [script, '--root', root, ...args], { encoding: 'utf8' });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('package-specific growth policy', () => {
  it('allows cohesive growth above the default without a new package', () => {
    const result = run(fixture());
    expect(result.status, result.stderr).toBe(0);
  });

  it('warns before a fixed ceiling and exposes headroom as JSON', () => {
    const result = run(fixture(18), '--json');
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.packages[0]).toMatchObject({
      path: 'packages/demo',
      role: 'library',
      sourceLines: 18,
      maxSourceLines: 20,
      headroom: 2,
      status: 'warning',
    });
    expect(report.warnings.join('\n')).toContain('packages/demo');
  });

  it('counts cumulative growth, not a fresh allowance per change', () => {
    const root = fixture(19);
    git(root, 'init', '-q');
    const base = commit(root);
    write(root, 'packages/demo/src/new.ts', '// new source\n'.repeat(2));
    const result = run(root, '--json', '--base', base);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).packages[0]).toMatchObject({
      sourceLines: 21,
      delta: 2,
      headroom: -1,
      status: 'over-budget',
    });
  });

  it('counts unstaged source but not ignored build output', () => {
    const root = fixture(18);
    write(root, '.gitignore', 'packages/demo/src/generated.ts\n');
    git(root, 'init', '-q');
    commit(root);
    write(root, 'packages/demo/src/generated.ts', '// generated\n'.repeat(100));
    write(root, 'packages/demo/src/new.ts', '// new source\n');
    const result = run(root, '--json');
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).packages[0].sourceLines).toBe(19);
  });

  it('enforces a significant internal module independently of the package total', () => {
    const root = fixture(5);
    write(root, 'packages/demo/src/session/index.ts', '// session\n'.repeat(6));
    config(root, {
      envelopes: [
        {
          ...envelope,
          role: 'composition',
          modules: [
            {
              path: 'src/session',
              maxSourceLines: 5,
              reason: 'Session lifecycle owns this module.',
            },
          ],
        },
      ],
    });
    const result = run(root, '--json');
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).errors.join('\n')).toContain('packages/demo/src/session');
  });

  it('reports new packages, dependency edges, and policy changes against the selected base', () => {
    const root = fixture();
    git(root, 'init', '-q');
    const base = commit(root);
    write(
      root,
      'packages/new/package.json',
      JSON.stringify({
        name: '@noodle-borg/new',
        license: 'Apache-2.0',
        dependencies: { '@noodle-borg/demo': 'workspace:*' },
      }),
    );
    config(root, { envelopes: [{ ...envelope, maxSourceLines: 30 }] });
    const result = run(root, '--json', '--base', base);
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.newPackages).toEqual(['packages/new']);
    expect(report.addedDependencyEdges).toEqual([
      { from: 'packages/new', to: 'packages/demo', kind: 'dependencies' },
    ]);
    expect(report.policyChanged).toBe(true);
    expect(report.warnings.join('\n')).toContain('human');
  });

  it('rejects retiring-surface growth even when it fits the ceiling', () => {
    const root = fixture(12);
    config(root, { envelopes: [{ ...envelope, role: 'retiring' }] });
    git(root, 'init', '-q');
    const base = commit(root);
    write(root, 'packages/demo/src/new.ts', '// growth\n');
    const result = run(root, '--base', base);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('retiring');
  });

  it.each([
    { envelopes: [{ ...envelope, maxSourceLines: -1 }] },
    { envelopes: [{ ...envelope, role: 'anything' }] },
    { envelopes: [{ ...envelope, reason: '' }] },
    { envelopes: [envelope, envelope] },
    { warningRatio: 1.1 },
    { pins: [{ path: 'packages/demo', maxSourceLines: 20, reason: 'old policy' }] },
    {
      envelopes: [
        {
          ...envelope,
          modules: [
            { path: '../outside', maxSourceLines: 5, reason: 'Invalid path escaping the package.' },
          ],
        },
      ],
    },
    {
      envelopes: [
        {
          ...envelope,
          modules: [
            { path: 'src', maxSourceLines: 20, reason: 'The outer source module.' },
            {
              path: 'src/nested',
              maxSourceLines: 10,
              reason: 'An overlapping module is ambiguous.',
            },
          ],
        },
      ],
    },
  ])('fails closed on invalid or obsolete policy: %j', (overrides) => {
    const root = fixture();
    config(root, overrides);
    expect(run(root).status).toBe(2);
  });

  it('rejects stale module budgets instead of silently losing enforcement', () => {
    const root = fixture();
    config(root, {
      envelopes: [
        {
          ...envelope,
          modules: [
            { path: 'src/missing', maxSourceLines: 10, reason: 'A module that has been removed.' },
          ],
        },
      ],
    });
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('matches no source');
  });

  it('fails rather than reporting an invented baseline for an invalid ref', () => {
    const root = fixture();
    git(root, 'init', '-q');
    commit(root);
    expect(run(root, '--base', 'missing-ref').status).toBe(2);
  });
});
