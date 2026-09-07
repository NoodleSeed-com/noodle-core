import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { initProject } from '../src/project.js';

const cliRoot = fileURLToPath(new URL('..', import.meta.url));
const resolvePackage = createRequire(join(cliRoot, 'package.json'));
const rootRequire = createRequire(new URL('../../../package.json', import.meta.url));
const reactRequire = createRequire(new URL('../../assistant/package.json', import.meta.url));

describe('source-rendered scaffold consumer behavior (not registry qualification)', () => {
  it('adds missing infrastructure while preserving customer source, scripts and bindings', () => {
    const project = mkdtempSync(join(tmpdir(), 'noodle-scaffold-upgrade-'));
    try {
      initProject({ dir: project, template: 'hello', agentTargets: [] });
      const preserved = {
        'src/server.ts': '// customer-owned business logic\n',
        'package.json': JSON.stringify({ name: 'customer', scripts: { test: 'custom-check' } }),
        'AGENTS.md': 'Customer-owned instructions outside generated context.\n',
        '.env.noodle': '# customer-owned private binding\n',
      };
      for (const [path, content] of Object.entries(preserved))
        writeFileSync(join(project, path), content);
      for (const path of ['tsconfig.json', 'vitest.config.ts']) rmSync(join(project, path));
      const result = initProject({ dir: project, agentTargets: [] });
      for (const [path, content] of Object.entries(preserved))
        expect(readFileSync(join(project, path), 'utf8')).toBe(content);
      for (const path of ['tsconfig.json', 'vitest.config.ts']) {
        expect(existsSync(join(project, path))).toBe(true);
        expect(result.files).toContainEqual({ path, action: 'created' });
      }
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it.each([
    'hello',
    'http-api',
    'widget',
    'saas',
  ] as const)('%s runs its unedited behavior suite', (template) => {
    const project = mkdtempSync(join(tmpdir(), 'noodle-scaffold-consumer-'));
    try {
      initProject({ dir: project, template, agentTargets: [] });
      // Supply installed, declared tooling only. Packaged-byte qualification runs separately.
      const dependencies =
        template === 'widget' || template === 'saas'
          ? [
              'vitest',
              'vite',
              'react',
              'react-dom',
              '@types/node',
              '@types/react',
              '@types/react-dom',
            ]
          : ['vitest', '@types/node'];
      for (const name of ['@noodleseed/one', ...dependencies]) {
        const destination = join(project, 'node_modules', name);
        mkdirSync(dirname(destination), { recursive: true });
        let source = cliRoot;
        if (name !== '@noodleseed/one') {
          const resolver = name.startsWith('@types/react')
            ? reactRequire
            : name === 'vitest' || name === '@types/node'
              ? rootRequire
              : resolvePackage;
          source = dirname(resolver.resolve(`${name}/package.json`));
        }
        symlinkSync(source, destination, 'dir');
      }
      const sentinel = '# customer-owned config must remain untouched\n';
      writeFileSync(join(project, '.env.noodle'), sentinel);
      const run = spawnSync(
        process.execPath,
        [
          join(dirname(rootRequire.resolve('vitest/package.json')), 'vitest.mjs'),
          'run',
          '--dir',
          'test',
          '--reporter=dot',
        ],
        {
          cwd: project,
          encoding: 'utf8',
          timeout: 120_000,
          env: { ...process.env, NOODLE_UPDATE_CHECK: 'off', NOODLE_BUILDER_VITE_ROOT: '' },
        },
      );
      expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
      expect(run.stdout).toContain('4 passed');
      expect(readFileSync(join(project, '.env.noodle'), 'utf8')).toBe(sentinel);
      const types = spawnSync(
        process.execPath,
        [rootRequire.resolve('typescript/bin/tsc'), '--noEmit'],
        {
          cwd: project,
          encoding: 'utf8',
          timeout: 30_000,
        },
      );
      expect(types.status, `${types.stdout}\n${types.stderr}`).toBe(0);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  }, 130_000);
});
