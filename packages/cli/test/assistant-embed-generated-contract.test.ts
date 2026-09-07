import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { embedScaffoldFiles } from '../src/assistant-embed-scaffold-template.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(import.meta.url);
const vitestRoot = dirname(require.resolve('vitest/package.json'));

describe('customer-side generated contract suite', () => {
  it.each([
    'authenticated',
    'mixed',
  ] as const)('executes the supplied %s tests against the generated route and maintained handler', (surface) => {
    const dir = mkdtempSync(join(tmpdir(), 'noodle-generated-contract-'));
    try {
      for (const [path, content] of Object.entries(embedScaffoldFiles('nextjs', surface))) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), content);
      }
      mkdirSync(join(dir, 'node_modules'));
      symlinkSync(vitestRoot, join(dir, 'node_modules/vitest'), 'dir');
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
      // Owner-layer fixture uses the built public entry; release certification separately packs it.
      writeFileSync(
        join(dir, 'vitest.config.mjs'),
        `export default ${JSON.stringify({
          resolve: {
            alias: {
              '@noodleseed/assistant/server': join(repoRoot, 'packages/assistant/dist/server.js'),
            },
          },
          test: { include: ['test/noodle-assistant.test.ts'], maxWorkers: 1 },
        })};`,
      );
      const result = spawnSync(
        process.execPath,
        [join(vitestRoot, 'vitest.mjs'), 'run', '--reporter=dot'],
        {
          cwd: dir,
          encoding: 'utf8',
          timeout: 30_000,
        },
      );
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain('5 passed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
