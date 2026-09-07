#!/usr/bin/env node
/**
 * gen-agent-kit-examples.mjs — Vendor the canonical flagship examples into the agent-kit skill
 * as generated reference material, so a `noodle init`'d project ships the real, readable example
 * sources under `.<agent>/skills/noodle-seed/examples/<name>/` instead of only naming them.
 *
 * Source of truth: the real runnable examples in `examples/<name>` (git-tracked files only, so
 * untracked local junk never leaks into the published skill). A strict include-list keeps the
 * bundle to authoring surfaces; binary assets and oversize files are refused.
 *
 * Output: packages/agent-kit/src/generated/example-files.ts (committed; the pure agent-kit imports
 * it — the package itself never touches node:fs). Drift-gated by
 * packages/agent-kit/test/skill-drift-gate.test.ts.
 *
 * Usage:
 *   node scripts/gen-agent-kit-examples.mjs          # write the generated module
 *   node scripts/gen-agent-kit-examples.mjs --check   # exit 1 if the committed module is stale
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT_FILE = join(ROOT, 'packages/agent-kit/src/generated/example-files.ts');

/**
 * The flagship examples bundled into the skill. Design-first + starter set: enough for an agent to
 * read a working pattern for each core capability without shipping the entire examples corpus.
 * Keep in sync with the bundled-vs-repo-only split in references/examples.md (the renderer imports
 * BUNDLED_EXAMPLE_NAMES from the generated module, so this list is the single source).
 */
export const BUNDLED_EXAMPLE_NAMES = [
  'hello',
  'weather',
  'food-ordering',
  'acme-discovery',
  'acme-tasks',
  'acme-bistro',
  'customer-auth',
  'stateful-draft',
  'gmail-multi-account',
  'google-bigquery',
];

/** Examples whose whole point is the design-first `design/` set — required to contribute one. */
const REQUIRE_DESIGN = ['acme-discovery', 'acme-tasks', 'acme-bistro'];

/** Root files bundled verbatim (exact relative paths). */
const ROOT_FILES = new Set(['README.md', 'noodle.json', 'package.json', 'vitest.config.ts']);

/**
 * Directories whose tracked files are bundled (authoring + design surfaces). `site/` is the host page
 * an embedded-assistant example mounts on — the customer's own markup, not app authoring, and the
 * only place the skill shows what the pasted snippet actually sits in.
 */
const INCLUDE_DIRS = ['src/', 'test/', 'design/', 'site/'];

/** Binary / asset extensions are never bundled — the skill teaches authoring, not runnable assets. */
const BINARY_EXT =
  /\.(jpg|jpeg|png|gif|webp|svg|ico|woff2?|ttf|otf|eot|mp4|mov|webm|mp3|wav|pdf|zip|gz|tgz|wasm)$/i;

/** Per-file cap (bytes). The largest legitimate authoring file today is a ~54 KB wireframe. */
const PER_FILE_MAX_BYTES = 96_000;

/** Total-bundle cap (bytes). Guards against the corpus quietly bloating the CLI binary + tarball. */
const TOTAL_MAX_BYTES = 600_000;

/**
 * Real client/competitor/secret leakage that must never reach the public skill surface. Tuned for
 * real app code, not prose: secret patterns are anchored to actual key shapes (a bare `sk-` would
 * match `task-list`), and prose-policy terms like "caller-key" are intentionally absent — examples
 * legitimately mention them in negative security disclaimers ("does not use caller-key mechanisms").
 */
const FORBIDDEN_TOKENS =
  /layla|jettly|hub71|heymate|sol-?ark|todoist|name\.com|skybridge|alpic|apps-sdk|NOODLE_AUTH_TOKEN|oauthRefreshToken|refreshToken|nbk_[A-Za-z0-9]|sk-[a-z0-9]{16,}|stakeholder|commission split|deal cadence/i;

/** Is `rel` (path relative to the example root) inside the strict include-list? */
function isIncluded(rel) {
  if (ROOT_FILES.has(rel)) return true;
  return INCLUDE_DIRS.some((dir) => rel.startsWith(dir));
}

/** Git-tracked files under a path, in deterministic (git) order. */
function gitTrackedFiles(pathspec) {
  const result = spawnSync('git', ['ls-files', '-z', pathspec], { cwd: ROOT, encoding: 'utf-8' });
  if (result.status !== 0) throw new Error(`git ls-files failed for ${pathspec}: ${result.stderr}`);
  return result.stdout.split('\0').filter((line) => line.length > 0);
}

/**
 * Read the bundled example files from the canonical `examples/` tree, enforcing the allowlist,
 * binary/size caps, required design sets, and the forbidden-token scan. Pure (no output) so the
 * drift-gate test can call it in-process.
 * @returns {{ files: {relPath: string, content: string}[], names: string[] }}
 */
export function extractExamples() {
  const files = [];
  let totalBytes = 0;

  for (const name of BUNDLED_EXAMPLE_NAMES) {
    const tracked = gitTrackedFiles(`examples/${name}`);
    if (tracked.length === 0) throw new Error(`No git-tracked files found for examples/${name}.`);

    let bundledForName = 0;
    let hasServer = false;
    let hasDesign = false;

    for (const path of tracked) {
      const rel = path.slice(`examples/${name}/`.length);
      if (!isIncluded(rel)) continue;
      if (BINARY_EXT.test(rel)) continue; // assets are intentionally omitted from the read-reference

      const abs = join(ROOT, path);
      const buffer = readFileSync(abs);
      if (buffer.includes(0)) continue; // defensive: skip anything that is actually binary
      if (buffer.byteLength > PER_FILE_MAX_BYTES) {
        throw new Error(
          `${path} is ${buffer.byteLength} bytes, over the ${PER_FILE_MAX_BYTES}-byte per-file cap. ` +
            'Trim it or exclude it from the bundled example include-list.',
        );
      }
      const content = buffer.toString('utf-8');
      if (FORBIDDEN_TOKENS.test(content)) {
        throw new Error(`${path} contains a forbidden token (client/competitor/secret leakage).`);
      }

      files.push({ relPath: `examples/${name}/${rel}`, content });
      totalBytes += buffer.byteLength;
      bundledForName += 1;
      if (rel === 'src/server.ts') hasServer = true;
      if (rel.startsWith('design/')) hasDesign = true;
    }

    if (bundledForName === 0) throw new Error(`examples/${name} bundled zero files.`);
    if (!hasServer) throw new Error(`examples/${name} is missing src/server.ts.`);
    if (REQUIRE_DESIGN.includes(name) && !hasDesign) {
      throw new Error(`examples/${name} is a design-first flagship but bundled no design/ file.`);
    }
  }

  if (totalBytes > TOTAL_MAX_BYTES) {
    throw new Error(
      `Bundled examples total ${totalBytes} bytes, over the ${TOTAL_MAX_BYTES}-byte cap. ` +
        'Trim an example or drop one from BUNDLED_EXAMPLE_NAMES.',
    );
  }

  // Deterministic order: by relPath, so the generated module is stable regardless of git output.
  files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return { files, names: [...BUNDLED_EXAMPLE_NAMES] };
}

/** Render the committed example-files.ts data module (content JSON-encoded for safe embedding). */
export function renderExamplesModule({ files, names }) {
  const nameLines = names.map((name) => `  ${JSON.stringify(name)},`).join('\n');
  const fileLines = files
    .map(
      (file) =>
        `  { relPath: ${JSON.stringify(file.relPath)}, content: ${JSON.stringify(file.content)} },`,
    )
    .join('\n');
  return `// GENERATED by scripts/gen-agent-kit-examples.mjs — do not edit by hand.
// Run \`pnpm skills:examples:gen\` to regenerate from the canonical examples/ tree.
// The drift gate (packages/agent-kit/test/skill-drift-gate.test.ts) fails CI when this is stale.

/** One bundled example file; relPath is relative to the installed \`noodle-seed\` skill directory. */
export interface BundledExampleFile {
  readonly relPath: string;
  readonly content: string;
}

/** Flagship examples bundled into the skill (bundled-vs-repo-only split in references/examples.md). */
export const BUNDLED_EXAMPLE_NAMES: readonly string[] = [
${nameLines}
];

/** Real example sources vendored from \`examples/<name>\`, written under \`examples/\` in the skill tree. */
export const BUNDLED_EXAMPLE_FILES: readonly BundledExampleFile[] = [
${fileLines}
];
`;
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const extracted = extractExamples();
  const next = renderExamplesModule(extracted);

  if (checkOnly) {
    const existing = existsSync(OUT_FILE) ? readFileSync(OUT_FILE, 'utf-8') : '';
    if (existing !== next) {
      console.error(
        `${OUT_FILE} is stale. Run "pnpm skills:examples:gen" to update the bundled examples.`,
      );
      process.exit(1);
    }
    console.log(
      `agent-kit bundled examples up to date (${extracted.names.length} examples, ${extracted.files.length} files).`,
    );
    return;
  }

  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, next, 'utf-8');
  console.log(
    `Generated ${OUT_FILE} (${extracted.names.length} examples, ${extracted.files.length} files).`,
  );
}

// Only run when invoked directly (not when imported by the drift-gate test).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
