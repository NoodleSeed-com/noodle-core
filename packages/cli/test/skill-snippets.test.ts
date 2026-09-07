import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// B6 + A10 gate: run `scripts/verify-skill-snippets.mjs`, which scaffolds a throwaway project with the
// *built* CLI, validates every full-server recipe in the shipped skill references through the real
// compiler, and drives the cold-agent validate→repair→validate→test loop. Spawning the built CLI is
// too heavy to inline here, so we run the script as a subprocess and assert its structured summary.
//
// The gate needs `packages/cli/dist/bin.js`. The enforced paths always build first — `pnpm dev:ready`
// (build + typecheck + suite) locally and `deploy-pipeline.yml` (`pnpm build` then `pnpm test`)
// post-merge — so it actively runs there. A bare `pnpm test` without a build skips loudly rather than
// failing on stale dist state.
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'verify-skill-snippets.mjs');
const CLI_BIN = join(ROOT, 'packages', 'cli', 'dist', 'bin.js');
const DIST_BUILT = existsSync(CLI_BIN);

if (!DIST_BUILT) {
  console.warn(
    '[skill-snippets] SKIP: CLI dist not built (packages/cli/dist/bin.js). ' +
      'Run `pnpm --filter "@noodleseed/one..." build` — this gate runs after build in the pipeline.',
  );
}

describe('skill snippet-compile gate + cold-agent loop (B6 + A10)', () => {
  it.skipIf(!DIST_BUILT)(
    'validates every full-server skill recipe and drives the cold-agent loop',
    () => {
      const result = spawnSync(process.execPath, [SCRIPT, '--json'], {
        encoding: 'utf8',
        timeout: 120_000,
      });
      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
      expect(result.status, `verify-skill-snippets failed:\n${output}`).toBe(0);

      const summaryLine = (result.stdout ?? '')
        .split('\n')
        .map((line) => line.trim())
        .reverse()
        .find((line) => line.startsWith('SUMMARY:'));
      expect(summaryLine, `no SUMMARY line in output:\n${output}`).toBeDefined();

      const summary = JSON.parse((summaryLine as string).replace(/^SUMMARY:\s*/, ''));
      // Four shipped full-server recipes: authoring-workflow, examples, sdk-surface, widgets-and-apps.
      expect(summary.validated).toBeGreaterThanOrEqual(4);
      expect(summary.coldAgentLoop).toBe('ok');
      // The resource read-back gate proves the double-wrap defect is caught: the shipped recipe teaches
      // the bare shape, a bare return reads back clean, and the `{ contents: [...] }` wrapper fails loudly.
      expect(summary.resourceReadBack).toBe('ok');
      // The connector secret-scope gate proves the "secret set at the wrong local scope" trap: a
      // connector `secret('X')` unset (or set at a mismatched scope) boots the loopback endpoint into an
      // opaque `-32600 "not found"` while `noodle validate` stays green, and only an org-scope secret that
      // the local runtime resolves lets the server boot + serve `tools/list`.
      expect(summary.connectorSecretScope).toBe('ok');
    },
    120_000,
  );
});
