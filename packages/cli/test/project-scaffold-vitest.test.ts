import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { helloFiles } from '../src/project-scaffold-templates.js';

describe('generated project Vitest discovery', () => {
  const projects: string[] = [];

  afterEach(() => {
    for (const project of projects) rmSync(project, { recursive: true, force: true });
    projects.length = 0;
  });

  it('runs only project-owned tests when generated agent examples contain test files', () => {
    const project = mkdtempSync(join(tmpdir(), 'noodle-scaffold-vitest-'));
    projects.push(project);
    for (const [path, content] of Object.entries(
      helloFiles('vitest-boundary', ['codex', 'claude-code']),
    )) {
      const destination = join(project, path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, content);
    }

    writeFileSync(
      join(project, 'test', 'server.test.ts'),
      "import { writeFileSync } from 'node:fs';\nimport { it } from 'vitest';\nit('runs the project test', () => {\n  writeFileSync(new URL('../.project-test-ran', import.meta.url), 'ok');\n});\n",
    );
    for (const agentRoot of ['.agents', '.claude']) {
      const generatedTestDir = join(
        project,
        agentRoot,
        'skills',
        'noodle-seed',
        'examples',
        'reference',
        'test',
      );
      mkdirSync(generatedTestDir, { recursive: true });
      writeFileSync(
        join(generatedTestDir, 'must-not-run.test.ts'),
        "throw new Error('generated agent example test was collected');\n",
      );
    }

    const vitestPackage = dirname(fileURLToPath(import.meta.resolve('vitest/package.json')));
    mkdirSync(join(project, 'node_modules', '.bin'), { recursive: true });
    symlinkSync(vitestPackage, join(project, 'node_modules', 'vitest'), 'dir');
    symlinkSync(join(vitestPackage, 'vitest.mjs'), join(project, 'node_modules', '.bin', 'vitest'));

    const result = spawnSync('npm', ['test'], { cwd: project, encoding: 'utf8' });
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status, output).toBe(0);
    expect(existsSync(join(project, '.project-test-ran'))).toBe(true);
    expect(output).not.toContain('generated agent example test was collected');
  });
});
