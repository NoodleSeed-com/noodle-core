import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const LEGACY_PROTOCOL_FILES = new Set([
  'packages/protocol/src/confirmation-elicitation.ts',
  'packages/protocol/src/handlers/prompts.ts',
  'packages/protocol/src/handlers/resources.ts',
  'packages/protocol/src/handlers/tools.ts',
  'packages/protocol/src/sdk-server.ts',
  'packages/protocol/src/stateless.ts',
  'packages/protocol/src/tool-interaction.ts',
  'packages/protocol/src/tool-results.ts',
]);

describe('MCP SDK v1 import boundary', () => {
  it('keeps production imports inside OAuth helpers and the temporary rollback seam', async () => {
    const files = [
      ...(await sourceFiles(resolve(ROOT, 'packages'))),
      ...(await sourceFiles(resolve(ROOT, 'apps'))),
    ];
    const offenders: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (!/(?:from\s+|import\s*)['"]@modelcontextprotocol\/sdk(?:\/|['"])/u.test(source)) {
        continue;
      }
      const path = relative(ROOT, file);
      const allowed =
        path.startsWith('packages/oauth-client-registry/src/') ||
        path.startsWith('packages/service/src/oauth/') ||
        LEGACY_PROTOCOL_FILES.has(path);
      if (!allowed) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });

  it('ignores hidden transient package directories created by concurrent tests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sdk-import-boundary-'));
    try {
      const transient = join(root, '.public-package-contract-fixture');
      await mkdir(transient);
      await writeFile(
        join(transient, 'consumer.ts'),
        "import '@modelcontextprotocol/sdk/client/index.js';\n",
      );
      expect(await sourceFiles(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function sourceFiles(root: string): Promise<string[]> {
  // The public open-source projection ships packages/ without apps/; scan what exists.
  const entries = await readdir(root, { withFileTypes: true }).catch(() => null);
  if (entries === null) return [];
  const files: string[] = [];
  for (const entry of entries) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name.startsWith('.') ||
        entry.name === 'node_modules' ||
        entry.name === 'dist' ||
        entry.name === 'test' ||
        entry.name === 'tests'
      ) {
        continue;
      }
      files.push(...(await sourceFiles(path)));
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      files.push(path);
    }
  }
  return files;
}
