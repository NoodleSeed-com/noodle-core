import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(import.meta.dirname, '..', '..', '..');
const escapeScript = join(repoRoot, 'scripts', 'escape-hatch-gate.mjs');
const boundaryScript = join(repoRoot, 'scripts', 'package-boundary-gate.mjs');

function makeTempRepo(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeJson(file: string, value: unknown) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writePackage(root: string, dir: string, pkg: Record<string, unknown> = {}) {
  mkdirSync(join(root, dir, 'src'), { recursive: true });
  writeJson(join(root, dir, 'package.json'), {
    name: dir.replace('packages/', '@noodle-borg/'),
    version: '0.0.0',
    type: 'module',
    ...pkg,
  });
}

describe('code quality gates', () => {
  it('escape-hatch gate rejects explicit any growth beyond budget', () => {
    const root = makeTempRepo('noodle-escape-gate-');
    mkdirSync(join(root, 'packages/demo/src'), { recursive: true });
    writeFileSync(join(root, 'packages/demo/src/index.ts'), `const value = input as ${'any'};\n`);
    writeJson(join(root, 'quality-gates.config.json'), {
      escapeHatches: { budgets: { explicitAny: 0 } },
    });

    const result = spawnSync(process.execPath, [escapeScript, '--root', root], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('explicitAny: 1 found, budget 0');
  });

  it('escape-hatch gate requires same-line reasons for suppressions', () => {
    const root = makeTempRepo('noodle-escape-reason-');
    mkdirSync(join(root, 'packages/demo/src'), { recursive: true });
    writeFileSync(
      join(root, 'packages/demo/src/index.ts'),
      `// ${'biome'}-${'ignore'} lint/suspicious/noExplicitAny\nconst value = input as unknown;\n`,
    );
    writeJson(join(root, 'quality-gates.config.json'), {
      escapeHatches: { budgets: { biomeIgnore: 1 } },
    });

    const result = spawnSync(process.execPath, [escapeScript, '--root', root], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('biomeIgnore must include a same-line reason');
  });

  it('package-boundary gate rejects undeclared workspace imports', () => {
    const root = makeTempRepo('noodle-boundary-deps-');
    writePackage(root, 'packages/a');
    writePackage(root, 'packages/b');
    writeFileSync(join(root, 'packages/a/src/index.ts'), "import { b } from '@noodle-borg/b';\n");
    writeFileSync(join(root, 'packages/b/src/index.ts'), 'export const b = 1;\n');

    const result = spawnSync(process.execPath, [boundaryScript, '--root', root], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'imports @noodle-borg/b but packages/a/package.json does not declare it',
    );
  });

  it('package-boundary gate rejects undeclared external imports from shipped source', () => {
    const root = makeTempRepo('noodle-boundary-external-');
    writePackage(root, 'packages/a');
    // A test runner reachable from shipped source resolves in the workspace but not in a
    // published tarball, where only `dependencies` are installed.
    writeFileSync(
      join(root, 'packages/a/src/conformance.ts'),
      "import { it } from 'vitest';\nexport const suite = it;\n",
    );

    const result = spawnSync(process.execPath, [boundaryScript, '--root', root], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'imports vitest but packages/a/package.json does not declare it',
    );
  });

  it('package-boundary gate accepts declared peer dependencies and root devDependencies', () => {
    const root = makeTempRepo('noodle-boundary-external-ok-');
    writeJson(join(root, 'package.json'), { devDependencies: { vitest: '^4.1.8' } });
    writePackage(root, 'packages/a', {
      license: 'Apache-2.0',
      peerDependencies: { vitest: '>=4' },
    });
    // Declared as a peer: the consumer installs it, so shipped source may import it.
    writeFileSync(join(root, 'packages/a/src/conformance.ts'), "import { it } from 'vitest';\n");
    mkdirSync(join(root, 'packages/a/test'), { recursive: true });
    // Shared tooling lives in the root manifest, so test files may rely on it.
    writeFileSync(join(root, 'packages/a/test/a.test.ts'), "import { expect } from 'vitest';\n");

    const result = spawnSync(process.execPath, [boundaryScript, '--root', root], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
  });

  it('allows an explicitly configured service test dependency without allowing a runtime edge', () => {
    const root = makeTempRepo('noodle-boundary-service-test-');
    writePackage(root, 'packages/service', {
      name: '@noodle-borg/service',
      license: 'Apache-2.0',
    });
    writePackage(root, 'packages/a', {
      license: 'Apache-2.0',
      devDependencies: { '@noodle-borg/service': 'workspace:*' },
    });
    writeJson(join(root, 'quality-gates.config.json'), {
      packageBoundaries: {
        allowServiceDevDependencies: [
          {
            path: 'packages/a',
            reason: 'package-owned integration test boots the real public service host',
          },
        ],
      },
    });

    const devOnly = spawnSync(process.execPath, [boundaryScript, '--root', root], {
      encoding: 'utf8',
    });
    expect(devOnly.status).toBe(0);

    writePackage(root, 'packages/a', {
      license: 'Apache-2.0',
      dependencies: { '@noodle-borg/service': 'workspace:*' },
    });
    const runtime = spawnSync(process.execPath, [boundaryScript, '--root', root], {
      encoding: 'utf8',
    });
    expect(runtime.status).toBe(1);
    expect(runtime.stderr).toContain(
      'only the CLI, cloud-service, and self-host compositions may depend on @noodle-borg/service',
    );
  });

  it.each([
    'optionalDependencies',
    'peerDependencies',
  ] as const)('rejects an allowlisted service dev dependency duplicated in %s', (dependencyClass) => {
    const root = makeTempRepo(`noodle-boundary-service-${dependencyClass}-`);
    writePackage(root, 'packages/service', {
      name: '@noodle-borg/service',
      license: 'Apache-2.0',
    });
    writePackage(root, 'packages/a', {
      license: 'Apache-2.0',
      devDependencies: { '@noodle-borg/service': 'workspace:*' },
      [dependencyClass]: { '@noodle-borg/service': 'workspace:*' },
    });
    writeJson(join(root, 'quality-gates.config.json'), {
      packageBoundaries: {
        allowServiceDevDependencies: [
          {
            path: 'packages/a',
            reason: 'package-owned integration test boots the real public service host',
          },
        ],
      },
    });

    const result = spawnSync(process.execPath, [boundaryScript, '--root', root], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'only the CLI, cloud-service, and self-host compositions may depend on @noodle-borg/service',
    );
  });

  it('package-boundary gate ignores imports written inside scaffold templates', () => {
    const root = makeTempRepo('noodle-boundary-template-');
    writePackage(root, 'packages/a', { license: 'Apache-2.0' });
    // The import belongs to the project this template generates, not to this package.
    writeFileSync(
      join(root, 'packages/a/src/scaffold.ts'),
      'export const template = `\nimport react from "@vitejs/plugin-react";\n`;\n',
    );

    const result = spawnSync(process.execPath, [boundaryScript, '--root', root], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
  });

  it('package-boundary gate rejects cross-package source imports unless allowlisted', () => {
    const root = makeTempRepo('noodle-boundary-src-');
    writePackage(root, 'packages/a');
    writePackage(root, 'packages/b');
    mkdirSync(join(root, 'packages/a/test'), { recursive: true });
    writeFileSync(
      join(root, 'packages/a/test/a.test.ts'),
      "import { b } from '../../b/src/index.js';\n",
    );
    writeFileSync(join(root, 'packages/b/src/index.ts'), 'export const b = 1;\n');

    const result = spawnSync(process.execPath, [boundaryScript, '--root', root], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'cross-package source import packages/b/src/index.ts is not allowed',
    );
  });

  it('package-boundary gate rejects Apache packages that ship proprietary dependencies', () => {
    const root = makeTempRepo('noodle-boundary-license-');
    writePackage(root, 'packages/core', {
      license: 'Apache-2.0',
      dependencies: { '@noodle-borg/commercial': 'workspace:*' },
    });
    writePackage(root, 'packages/commercial', { license: 'UNLICENSED', private: true });

    const result = spawnSync(process.execPath, [boundaryScript, '--root', root], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Apache-2.0 package packages/core must not ship UNLICENSED dependency @noodle-borg/commercial',
    );
  });

  it('keeps every commercial carve-out destination independent of service and CLI', () => {
    const root = makeTempRepo('noodle-boundary-carveout-');
    const destinations = [
      '@noodle-borg/asset-store',
      '@noodle-borg/deploy-github',
      '@noodle-borg/platform-identity',
      '@noodle-borg/module-billing',
    ];
    for (const [index, name] of destinations.entries()) {
      writePackage(root, `packages/destination-${index}`, {
        name,
        license: 'UNLICENSED',
        private: true,
        optionalDependencies: {
          '@noodle-borg/service': 'workspace:*',
        },
        peerDependencies: {
          '@noodleseed/one': 'workspace:*',
        },
      });
    }
    writePackage(root, 'packages/service', {
      name: '@noodle-borg/service',
      license: 'Apache-2.0',
    });
    writePackage(root, 'packages/cli', {
      name: '@noodleseed/one',
      license: 'Apache-2.0',
    });

    const result = spawnSync(process.execPath, [boundaryScript, '--root', root], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    for (const index of destinations.keys()) {
      expect(result.stderr).toContain(
        `commercial carve-out package packages/destination-${index} must not depend on @noodle-borg/service`,
      );
      expect(result.stderr).toContain(
        `commercial carve-out package packages/destination-${index} must not depend on @noodleseed/one`,
      );
    }
  });
});

describe('package scope charter (ADR 0203)', () => {
  function writeSource(root: string, dir: string, lines: number) {
    writeFileSync(join(root, dir, 'src/index.ts'), `${'export const x = 1;\n'.repeat(lines)}`);
  }

  it('accepts a package under the default envelope', () => {
    const root = makeTempRepo('noodle-scope-under-');
    writePackage(root, 'packages/small', { license: 'Apache-2.0' });
    writeSource(root, 'packages/small', 10);
    writeJson(join(root, 'quality-gates.config.json'), {
      packageScopes: { defaultMaxSourceLines: 8000 },
    });

    const result = spawnSync(process.execPath, [boundaryScript, '--root', root], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
  });

  it('rejects a package that grows past the default envelope', () => {
    const root = makeTempRepo('noodle-scope-default-');
    writePackage(root, 'packages/grown', { license: 'Apache-2.0' });
    writeSource(root, 'packages/grown', 40);
    writeJson(join(root, 'quality-gates.config.json'), {
      packageScopes: { defaultMaxSourceLines: 20 },
    });

    const result = spawnSync(process.execPath, [boundaryScript, '--root', root], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('packages/grown: 40 source lines exceeds the budget of 20');
  });

  it('rejects a package that grows past its fixed envelope, and ignores its test lines', () => {
    const root = makeTempRepo('noodle-scope-pin-');
    writePackage(root, 'packages/big', { license: 'Apache-2.0' });
    writeSource(root, 'packages/big', 40);
    mkdirSync(join(root, 'packages/big/test'), { recursive: true });
    writeFileSync(
      join(root, 'packages/big/test/big.test.ts'),
      `${'export const t = 1;\n'.repeat(500)}`,
    );
    writeJson(join(root, 'quality-gates.config.json'), {
      packageScopes: {
        defaultMaxSourceLines: 10,
        envelopes: [
          {
            path: 'packages/big',
            role: 'library',
            maxSourceLines: 30,
            reason: 'cohesive library with a fixed allowance',
          },
        ],
      },
    });

    const result = spawnSync(process.execPath, [boundaryScript, '--root', root], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('packages/big: 40 source lines exceeds the budget of 30');
    expect(result.stderr).toContain('human-approved');
  });

  it('excludes ignored build output from a package envelope', () => {
    const root = makeTempRepo('noodle-scope-tracked-');
    writePackage(root, 'packages/app', { license: 'Apache-2.0' });
    writeSource(root, 'packages/app', 10);
    writeFileSync(join(root, '.gitignore'), 'packages/app/src/generated.ts\n');
    writeFileSync(
      join(root, 'packages/app/src/generated.ts'),
      `${'export const g = 1;\n'.repeat(100)}`,
    );
    writeJson(join(root, 'quality-gates.config.json'), {
      packageScopes: { defaultMaxSourceLines: 20 },
    });
    for (const args of [
      ['init', '-q'],
      ['add', '-A'],
      ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'],
    ]) {
      spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    }

    const result = spawnSync(process.execPath, [boundaryScript, '--root', root], {
      encoding: 'utf8',
    });

    expect(result.stderr).not.toContain('packages/app');
    expect(result.status).toBe(0);
  });

  it('rejects an envelope that carries no reason', () => {
    const root = makeTempRepo('noodle-scope-reason-');
    writePackage(root, 'packages/big', { license: 'Apache-2.0' });
    writeSource(root, 'packages/big', 10);
    writeJson(join(root, 'quality-gates.config.json'), {
      packageScopes: { envelopes: [{ path: 'packages/big', role: 'library', maxSourceLines: 30 }] },
    });

    const result = spawnSync(process.execPath, [boundaryScript, '--root', root], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('package-scope envelope packages/big must include a reason');
  });

  it('rejects a stale envelope whose package no longer exists', () => {
    const root = makeTempRepo('noodle-scope-stale-');
    writePackage(root, 'packages/small', { license: 'Apache-2.0' });
    writeSource(root, 'packages/small', 5);
    writeJson(join(root, 'quality-gates.config.json'), {
      packageScopes: {
        envelopes: [
          {
            path: 'packages/gone',
            role: 'library',
            maxSourceLines: 30,
            reason: 'left over from a split',
          },
        ],
      },
    });

    const result = spawnSync(process.execPath, [boundaryScript, '--root', root], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('package-scope envelope packages/gone matches no package');
  });

  it('rejects an Apache package that depends on a commercial vendor SDK', () => {
    const root = makeTempRepo('noodle-scope-vendor-');
    writePackage(root, 'packages/engine', {
      license: 'Apache-2.0',
      dependencies: { stripe: '^22.3.2' },
    });
    writeSource(root, 'packages/engine', 5);
    writeJson(join(root, 'quality-gates.config.json'), {
      packageScopes: { commercialVendorDependencies: ['stripe', '@workos-inc/*'] },
    });

    const result = spawnSync(process.execPath, [boundaryScript, '--root', root], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Apache-2.0 package packages/engine must not depend on commercial vendor SDK stripe',
    );
  });

  it('ignores vendor exemptions: an Apache-2.0 package must carve the scope out instead', () => {
    const root = makeTempRepo('noodle-scope-vendor-allow-');
    writePackage(root, 'packages/engine', {
      license: 'Apache-2.0',
      dependencies: { stripe: '^22.3.2' },
    });
    writeSource(root, 'packages/engine', 5);
    writeJson(join(root, 'quality-gates.config.json'), {
      packageScopes: {
        commercialVendorDependencies: ['stripe'],
        allowCommercialVendorDependencies: [
          { path: 'packages/engine', dependency: 'stripe', reason: 'leaves in the carve-out' },
        ],
      },
    });

    const result = spawnSync(process.execPath, [boundaryScript, '--root', root], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Apache-2.0 package packages/engine must not depend on commercial vendor SDK stripe',
    );
  });

  it('rejects new engine imports into a pinned carve-out cluster', () => {
    const root = makeTempRepo('noodle-seam-grow-');
    writePackage(root, 'packages/host', { license: 'Apache-2.0' });
    mkdirSync(join(root, 'packages/host/src/commercial'), { recursive: true });
    writeFileSync(join(root, 'packages/host/src/commercial/meter.ts'), 'export const m = 1;\n');
    writeFileSync(
      join(root, 'packages/host/src/serve.ts'),
      "import { m } from './commercial/meter.js';\n",
    );
    writeFileSync(
      join(root, 'packages/host/src/index.ts'),
      "import { m } from './commercial/meter.js';\n",
    );
    writeJson(join(root, 'quality-gates.config.json'), {
      carveOutSeams: [
        {
          name: 'commercial',
          package: 'packages/host',
          cluster: 'packages/host/src/commercial/**',
          maxEdges: 1,
          reason: 'extracted to its own package by the carve-out',
        },
      ],
    });

    const result = spawnSync(process.execPath, [boundaryScript, '--root', root], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'carve-out seam commercial: 2 engine imports exceeds its pin of 1',
    );
    expect(result.stderr).toContain('route it through the module seam');
  });

  it('accepts imports inside the cluster and a seam at or under its pin', () => {
    const root = makeTempRepo('noodle-seam-ok-');
    writePackage(root, 'packages/host', { license: 'Apache-2.0' });
    mkdirSync(join(root, 'packages/host/src/commercial'), { recursive: true });
    writeFileSync(join(root, 'packages/host/src/commercial/meter.ts'), 'export const m = 1;\n');
    // Intra-cluster imports are free: the whole cluster moves together.
    writeFileSync(
      join(root, 'packages/host/src/commercial/charge.ts'),
      "import { m } from './meter.js';\nexport const c = m;\n",
    );
    writeFileSync(
      join(root, 'packages/host/src/serve.ts'),
      "import { m } from './commercial/meter.js';\n",
    );
    writeJson(join(root, 'quality-gates.config.json'), {
      carveOutSeams: [
        {
          name: 'commercial',
          package: 'packages/host',
          cluster: 'packages/host/src/commercial/**',
          maxEdges: 1,
          reason: 'extracted to its own package by the carve-out',
        },
      ],
    });

    const result = spawnSync(process.execPath, [boundaryScript, '--root', root], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
  });

  it('rejects a carve-out seam pin with no reason', () => {
    const root = makeTempRepo('noodle-seam-reason-');
    writePackage(root, 'packages/host', { license: 'Apache-2.0' });
    writeJson(join(root, 'quality-gates.config.json'), {
      carveOutSeams: [
        {
          name: 'commercial',
          package: 'packages/host',
          cluster: 'packages/host/src/x/**',
          maxEdges: 0,
        },
      ],
    });

    const result = spawnSync(process.execPath, [boundaryScript, '--root', root], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('carve-out seam commercial must include a reason');
  });

  it('rejects a package whose UNLICENSED sibling depends on a vendor SDK only when Apache', () => {
    const root = makeTempRepo('noodle-scope-vendor-private-');
    writePackage(root, 'packages/commercial', {
      license: 'UNLICENSED',
      private: true,
      dependencies: { stripe: '^22.3.2' },
    });
    writeSource(root, 'packages/commercial', 5);
    writeJson(join(root, 'quality-gates.config.json'), {
      packageScopes: { commercialVendorDependencies: ['stripe'] },
    });

    const result = spawnSync(process.execPath, [boundaryScript, '--root', root], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
  });
});

// `engines` alone is advisory: a Node-22 shell produced confusing downstream failures instead of a
// clear install error. These pin the declarative enforcement, which lives in pnpm-workspace.yaml
// (verified supported by pnpm 11.5.2) rather than a fourth config file.
describe('workspace install strictness', () => {
  const workspace = readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');

  it('enforces the Node engine at install time', () => {
    expect(workspace).toMatch(/^engineStrict: true$/m);
  });

  it('fails fast on a stale node_modules', () => {
    expect(workspace).toMatch(/^verifyDepsBeforeRun: error$/m);
  });

  it('keeps CI opted out explicitly, so the two do not silently diverge', () => {
    // PNPM_CONFIG_* env overrides the workspace file; CI installs fresh and opts out on purpose.
    for (const file of ['ci.yml', 'deploy-pipeline.yml', 'merge-queue.yml']) {
      const text = readFileSync(join(repoRoot, '.github', 'workflows', file), 'utf8');
      expect(text, `${file} must state its pnpm posture`).toContain(
        'PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN',
      );
    }
  });
});

// A dependency used only through a spawned binary is invisible to import-graph analysis: knip
// reported `@arethetypeswrong/cli` unused because `packages/assistant/test/package-shape.test.ts`
// spawns `node_modules/.bin/attw` by path. Removing it passed every static gate and every local
// suite (the author's node_modules still held the binary), then failed the post-merge pipeline on a
// fresh install and auto-reverted the merge. This gate is the missing proof: a binary a package
// EXECUTES from its own node_modules must come from a dependency that package declares.
describe('spawned-binary gate', () => {
  const gateScript = join(repoRoot, 'scripts', 'spawned-binary-gate.mjs');
  // Interpolated so this file's own source does not read as a spawned-binary site to the gate it
  // exercises: the pattern belongs in the fixtures written below, not in the test that writes them.
  const binDir = '.bin';
  const SPAWNING_SOURCE = [
    `const probe = join(packageRoot, 'node_modules', '${binDir}', 'probe');`,
    "spawnSync(probe, ['--pack']);",
  ].join('\n');
  const ERA_SOURCE = "export const revision = '2026-07-28';\n";

  function writeSpawningPackage(root: string, deps: Record<string, string>, body: string) {
    mkdirSync(join(root, 'packages', 'widget', 'test'), { recursive: true });
    mkdirSync(join(root, 'packages', 'widget', 'node_modules', '@vendor', 'cli'), {
      recursive: true,
    });
    writeJson(join(root, 'packages', 'widget', 'package.json'), {
      name: '@noodle-borg/widget',
      devDependencies: deps,
    });
    writeJson(join(root, 'packages', 'widget', 'node_modules', '@vendor', 'cli', 'package.json'), {
      name: '@vendor/cli',
      bin: { probe: './probe.js' },
    });
    writeFileSync(join(root, 'packages', 'widget', 'test', 'shape.test.ts'), body);
  }

  function runGate(root: string) {
    return spawnSync(process.execPath, [gateScript, '--root', root], {
      encoding: 'utf8',
    });
  }

  it('fails when an executed binary has no declaring dependency', () => {
    const root = makeTempRepo('spawned-binary-missing-');
    writeSpawningPackage(
      root,
      {},
      [
        "import { spawnSync } from 'node:child_process';",
        `const probe = join(packageRoot, 'node_modules', '${binDir}', 'probe');`,
        "spawnSync(probe, ['--pack']);",
      ].join('\n'),
    );

    const result = runGate(root);

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('probe');
  });

  it('passes when the declaring dependency provides that binary', () => {
    const root = makeTempRepo('spawned-binary-declared-');
    writeSpawningPackage(
      root,
      { '@vendor/cli': '1.0.0' },
      [
        "import { spawnSync } from 'node:child_process';",
        `const probe = join(packageRoot, 'node_modules', '${binDir}', 'probe');`,
        "spawnSync(probe, ['--pack']);",
      ].join('\n'),
    );

    const result = runGate(root);

    expect(`${result.stdout}${result.stderr}`).not.toContain('probe');
    expect(result.status).toBe(0);
  });

  it('ignores a .bin path that is only built as a fixture, never executed', () => {
    // `packages/cli` writes fake `.bin` entries inside temp projects; those are fixture data, not a
    // toolchain dependency, and an allowlist would rot. Execution is the discriminator.
    const root = makeTempRepo('spawned-binary-fixture-');
    writeSpawningPackage(
      root,
      {},
      [
        "import { mkdirSync, symlinkSync } from 'node:fs';",
        `mkdirSync(join(project, 'node_modules', '${binDir}'), { recursive: true });`,
        `symlinkSync(target, join(project, 'node_modules', '${binDir}', 'vitest'));`,
        "spawnSync('npm', ['test'], { cwd: project });",
      ].join('\n'),
    );

    const result = runGate(root);

    expect(result.status).toBe(0);
  });

  it('ignores a spawned .bin path that is not inside a node_modules tree', () => {
    // CodeRabbit's case: a fixture tool executed out of some other directory's `.bin` is not this
    // package's declared toolchain, so requiring a dependency for it would be a false report.
    const root = makeTempRepo('spawned-binary-foreign-');
    writeSpawningPackage(
      root,
      {},
      [
        `const tool = join(tempRoot, '${binDir}', 'fixture-tool');`,
        "spawnSync(tool, ['--run']);",
      ].join('\n'),
    );

    const result = runGate(root);

    expect(`${result.stdout}${result.stderr}`).not.toContain('fixture-tool');
    expect(result.status).toBe(0);
  });

  // A gate that cannot run is worse than one that fails: it reports success having checked nothing.
  // Entrypoint guards must compare canonical filesystem paths: Node preserves an invoked symlink in
  // `process.argv[1]`, URL pathnames percent-encode spaces, and macOS aliases `/var` as `/private/var`.
  // A lexical mismatch silently skips main(), so both gates run through an explicit spaced alias.
  it.each([
    [
      'spawned-binary-gate.mjs',
      [] as string[],
      'packages/widget/test/a.test.ts',
      SPAWNING_SOURCE,
      'probe',
    ],
    [
      'protocol-era-gate.mjs',
      ['lib/source-text.mjs'],
      'packages/widget/src/a.ts',
      ERA_SOURCE,
      'packages/widget/src/a.ts',
    ],
  ])('runs through a filesystem alias whose path contains spaces: %s', (script, extras, fixture, source, diagnostic) => {
    const canonicalScripts = join(makeTempRepo('gate-entrypoint-target-'), 'scripts');
    mkdirSync(join(canonicalScripts, 'lib'), { recursive: true });
    for (const relative of [script, ...extras]) {
      copyFileSync(join(repoRoot, 'scripts', relative), join(canonicalScripts, relative));
    }
    const aliasedScripts = join(makeTempRepo('gate-entrypoint-alias-'), 'gate scripts with space');
    symlinkSync(
      canonicalScripts,
      aliasedScripts,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const invokedScript = join(aliasedScripts, script);
    expect(invokedScript).not.toBe(realpathSync(invokedScript));

    const root = makeTempRepo('spaced-gate-subject-');
    mkdirSync(join(root, dirname(fixture)), { recursive: true });
    writeJson(join(root, 'packages', 'widget', 'package.json'), { name: '@noodle-borg/widget' });
    writeFileSync(join(root, fixture), source);

    const result = spawnSync(process.execPath, [invokedScript, '--root', root], {
      encoding: 'utf8',
    });

    // Naming the offender is what separates "the gate ran and found the fixture" from "the gate
    // crashed": a startup failure also writes to stderr and also exits non-zero.
    expect(result.error).toBeUndefined();
    expect(
      `${result.stdout}${result.stderr}`,
      'the gate must report its finding, not merely fail',
    ).toContain(diagnostic);
    expect(result.status).toBe(1);
  });

  it.each([
    'spawned-binary-gate.mjs',
    'protocol-era-gate.mjs',
  ])('fails closed when its entrypoint path cannot be resolved: %s', (script) => {
    const missingEntrypoint = join(
      makeTempRepo('missing-gate-entrypoint-'),
      'missing gate script.mjs',
    );
    const moduleUrl = pathToFileURL(join(repoRoot, 'scripts', script)).href;
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `process.argv[1] = ${JSON.stringify(missingEntrypoint)}; await import(${JSON.stringify(moduleUrl)});`,
      ],
      { encoding: 'utf8' },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ENOENT');
    expect(result.stderr).toContain(missingEntrypoint);
  });

  it('holds on this repository, where the attw removal would have failed it', () => {
    const result = runGate(repoRoot);
    expect(`${result.stdout}${result.stderr}`).not.toContain('undeclared');
    expect(result.status).toBe(0);
  });
});
