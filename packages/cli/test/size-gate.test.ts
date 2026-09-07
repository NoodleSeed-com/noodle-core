import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = join(import.meta.dirname, '..', '..', '..');
const script = join(repoRoot, 'scripts', 'size-gate.mjs');

function makeTempRepo() {
  return mkdtempSync(join(tmpdir(), 'noodle-size-gate-'));
}

function writeLines(file: string, lines: number) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, Array.from({ length: lines }, (_, index) => `line ${index + 1}`).join('\n'));
}

describe('scripts/size-gate.mjs', () => {
  it('fails normal source files that exceed the hard line limit', () => {
    const root = makeTempRepo();
    writeLines(join(root, 'packages/demo/src/big.ts'), 801);

    const result = spawnSync(process.execPath, [script, '--root', root], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('size-gate failed with 1 oversized file(s)');
    expect(result.stderr).toContain('packages/demo/src/big.ts');
    expect(result.stderr).toContain('801 lines');
    expect(result.stderr).toContain('limit 800');
    expect(result.stderr).toContain('Fix: split by responsibility');
  });

  it('ignores generated output and allowlisted generated files with reasons', () => {
    const root = makeTempRepo();
    writeLines(join(root, 'packages/demo/dist/generated.js'), 10_000);
    writeLines(join(root, 'packages/protocol/src/widget/ext-apps-bundle.ts'), 10_000);
    writeFileSync(
      join(root, 'size-gate.config.json'),
      JSON.stringify(
        {
          allow: [
            {
              path: 'packages/protocol/src/widget/ext-apps-bundle.ts',
              reason: 'vendored MCP Apps browser bundle',
            },
          ],
        },
        null,
        2,
      ),
    );

    const output = execFileSync(process.execPath, [script, '--root', root], {
      encoding: 'utf8',
    });

    expect(output).toContain('size-gate ok');
  });

  it('rejects allowlist entries without a durable reason', () => {
    const root = makeTempRepo();
    writeFileSync(
      join(root, 'size-gate.config.json'),
      JSON.stringify({ allow: [{ path: 'packages/demo/src/big.ts' }] }, null, 2),
    );

    const result = spawnSync(process.execPath, [script, '--root', root], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      'allowlist entry packages/demo/src/big.ts must include a reason',
    );
  });
});
