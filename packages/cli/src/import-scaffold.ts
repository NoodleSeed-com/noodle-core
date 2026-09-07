import type { InitProjectOptions, InitProjectResult } from './project.js';
import { writeProjectScaffold } from './project.js';
import { commonFiles } from './project-scaffold-templates.js';

/** Imported contracts use the same pinned toolchain and safe writer as built-in starters. */
export function importedProjectFiles(name: string, source: string): Record<string, string> {
  return {
    ...commonFiles(name, 'http-api', ['codex', 'claude-code'], source, []),
    '.env.example':
      '# Declare local managed variable/secret values here; never commit real credentials.\n',
    'test/server.test.ts': `import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// Contract smoke only: no tool calls, backend requests, account or credential reads.
// Add a reviewed sandbox-operation fixture before claiming working business behavior.
const project = fileURLToPath(new URL('..', import.meta.url));
it('compiles the offline imported contract at the project entrypoint', () => {
  const isolatedHome = mkdtempSync(join(tmpdir(), 'noodle-import-test-'));
  try {
    const output = execFileSync(process.execPath, ['--input-type=module', '--eval',
      "import { run } from '@noodleseed/one'; process.exitCode = await run(['validate', '--json'], {}, process.argv[1]);",
      isolatedHome,
    ], { cwd: project, timeout: 25_000, maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH, NOODLE_UPDATE_CHECK: 'off' }, encoding: 'utf8' });
    expect(JSON.parse(output)).toMatchObject({ ok: true });
  } finally {
    rmSync(isolatedHome, { recursive: true, force: true });
  }
}, 30_000);
`,
  };
}

export function writeImportedProject(
  options: Pick<InitProjectOptions, 'dir' | 'force'>,
  files: Readonly<Record<string, string>>,
): InitProjectResult {
  const preview = writeProjectScaffold({ ...options, dryRun: true }, files);
  if (preview.files.some((file) => file.action === 'skipped')) {
    throw new Error(
      'import: refusing to overwrite modified project files; choose a new output directory or explicitly review --force.',
    );
  }
  return writeProjectScaffold(options, files);
}
