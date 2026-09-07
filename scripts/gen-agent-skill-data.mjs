#!/usr/bin/env node
/**
 * gen-agent-skill-data.mjs — Generate the agent-kit skill surface data module
 * from the live SDK/CLI/compiler source, so the installed `noodle-seed` skill's
 * factual sections never drift from the real surface.
 *
 * Sources of truth:
 *   - CLI commands  ← packages/cli/src/cli.ts          (the `switch (command)`)
 *   - SDK exports   ← packages/cli/src/index.ts        (`@noodle-borg/authoring` re-exports = @noodleseed/one)
 *   - Error codes   ← packages/compiler/src/errors.ts  (the `CompileErrorCode` union)
 *   - React hooks   ← packages/authoring/src/react/hooks.ts  (the `GeneratedReactHelpers` contract)
 *
 * Output: packages/agent-kit/src/generated/surface.ts (committed, compiled into the pure agent-kit).
 *
 * Usage:
 *   node scripts/gen-agent-skill-data.mjs          # write the generated module
 *   node scripts/gen-agent-skill-data.mjs --check   # exit 1 if the committed module is stale
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCommands } from './lib/parse-cli-commands.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CLI_SRC = join(ROOT, 'packages/cli/src/cli.ts');
const SDK_INDEX_SRC = join(ROOT, 'packages/cli/src/index.ts');
const ERRORS_SRC = join(ROOT, 'packages/compiler/src/errors.ts');
const REACT_SRC = join(ROOT, 'packages/authoring/src/react/hooks.ts');
const OUT_FILE = join(ROOT, 'packages/agent-kit/src/generated/surface.ts');
const ERROR_FIXES_SRC = join(ROOT, 'packages/agent-kit/src/curated/error-fixes.ts');
const COMMAND_GROUPS_SRC = join(ROOT, 'packages/agent-kit/src/curated/command-groups.ts');
const HOOK_NOTES_SRC = join(ROOT, 'packages/agent-kit/src/curated/hook-notes.ts');

/** Parse identifier or single-quoted top-level keys from a curated data module. */
function parseCuratedKeys(source) {
  return new Set(
    [...source.matchAll(/^ {2}(?:([A-Za-z0-9_]+)|'([^']+)'):/gm)].map(
      (match) => match[1] ?? match[2],
    ),
  );
}

/**
 * Assert that a curated map covers every required name. Returns the list of missing names
 * (empty when current). The drift gate enforces the same parity in TypeScript.
 */
function missingCuratedKeys(srcPath, requiredNames) {
  if (!existsSync(srcPath)) return [];
  const keys = parseCuratedKeys(readFileSync(srcPath, 'utf-8'));
  return requiredNames.filter((name) => !keys.has(name));
}

/**
 * Parse the public `@noodleseed/one` value exports from packages/cli/src/index.ts.
 * Only the first `export { ... } from '@noodle-borg/authoring'` block is the SDK
 * surface. Type-only members (prefixed `type `) are skipped — they are not runtime imports.
 * @param {string} source
 * @returns {string[]}
 */
export function parseSdkExports(source) {
  const match = source.match(/export\s*\{([\s\S]*?)\}\s*from\s*'@noodle-borg\/authoring'/);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && !entry.startsWith('type '))
    .map((entry) => entry.replace(/\s+as\s+\w+$/, '').trim());
}

/**
 * Parse the `CompileErrorCode` string-literal union from packages/compiler/src/errors.ts,
 * preserving source order.
 * @param {string} source
 * @returns {string[]}
 */
export function parseCompileErrorCodes(source) {
  const block = source.match(/export\s+type\s+CompileErrorCode\s*=([\s\S]*?);/);
  if (!block) return [];
  return [...block[1].matchAll(/\|\s*'([a-z0-9_]+)'/g)].map((m) => m[1]);
}

/**
 * Parse the widget React hook names from the `GeneratedReactHelpers` contract in
 * packages/authoring/src/react/hooks.ts — the public `generateHelpers<AppType>()` surface.
 * @param {string} source
 * @returns {string[]}
 */
export function parseReactHooks(source) {
  const block = source.match(/type\s+GeneratedReactHelpers\s*=\s*\{([\s\S]*?)\n\};/);
  if (!block) return [];
  return [...block[1].matchAll(/readonly\s+(use[A-Z]\w*)\s*:/g)].map((m) => m[1]);
}

/** Read each source file and extract the full skill surface. */
export function extractSurface() {
  // cli.ts carries no inline descriptions (those live in usage()); the switch is the
  // canonical command-name list. Descriptions/grouping are curated in agent-kit and
  // parity-gated, so the generated surface holds only the authoritative names.
  const commands = parseCommands(readFileSync(CLI_SRC, 'utf-8')).map((command) => command.name);
  const sdkExports = parseSdkExports(readFileSync(SDK_INDEX_SRC, 'utf-8'));
  const errorCodes = parseCompileErrorCodes(readFileSync(ERRORS_SRC, 'utf-8'));
  const reactHooks = parseReactHooks(readFileSync(REACT_SRC, 'utf-8'));
  return { commands, sdkExports, errorCodes, reactHooks };
}

function jsString(value) {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Render the committed surface.ts data module. */
export function renderSurfaceModule({ commands, sdkExports, errorCodes, reactHooks }) {
  const commandLines = commands.map((name) => `  ${jsString(name)},`).join('\n');
  const exportLines = sdkExports.map((name) => `  ${jsString(name)},`).join('\n');
  const codeLines = errorCodes.map((code) => `  ${jsString(code)},`).join('\n');
  const hookLines = reactHooks.map((name) => `  ${jsString(name)},`).join('\n');
  return `// GENERATED by scripts/gen-agent-skill-data.mjs — do not edit by hand.
// Run \`pnpm skills:gen\` to regenerate from the live SDK/CLI/compiler source.
// The drift gate (packages/agent-kit/test/skill-drift-gate.test.ts) fails CI when this is stale.

/** Every public \`noodle\` command name, in cli.ts source order. Descriptions/grouping are curated. */
export const CLI_COMMANDS: readonly string[] = [
${commandLines}
];

/** Public \`@noodleseed/one\` value exports authors import (from packages/cli/src/index.ts). */
export const SDK_EXPORTS: readonly string[] = [
${exportLines}
];

/** Every compiler \`CompileErrorCode\`, in source order (from packages/compiler/src/errors.ts). */
export const COMPILE_ERROR_CODES: readonly string[] = [
${codeLines}
];

/** Widget React hooks from \`generateHelpers<AppType>()\` (packages/authoring/src/react/hooks.ts). */
export const REACT_HOOKS: readonly string[] = [
${hookLines}
];
`;
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const surface = extractSurface();

  if (surface.commands.length === 0) throw new Error(`No CLI commands parsed from ${CLI_SRC}`);
  if (surface.sdkExports.length === 0)
    throw new Error(`No SDK exports parsed from ${SDK_INDEX_SRC}`);
  if (surface.errorCodes.length === 0) throw new Error(`No error codes parsed from ${ERRORS_SRC}`);
  if (surface.reactHooks.length === 0) throw new Error(`No React hooks parsed from ${REACT_SRC}`);

  const next = renderSurfaceModule(surface);

  // Currency assertions: every generated name must have human-authored guidance, so a new
  // CLI command or compile-error code cannot ship without a skill summary/fix.
  let curatedGap = false;
  const missingFixes = missingCuratedKeys(ERROR_FIXES_SRC, surface.errorCodes);
  if (missingFixes.length > 0) {
    curatedGap = true;
    console.error(
      `error-fixes.ts is missing a curated fix for: ${missingFixes.join(', ')}.\n` +
        'Add a one-line fix for each new CompileErrorCode in packages/agent-kit/src/curated/error-fixes.ts.',
    );
  }
  const missingGroups = missingCuratedKeys(COMMAND_GROUPS_SRC, surface.commands);
  if (missingGroups.length > 0) {
    curatedGap = true;
    console.error(
      `command-groups.ts is missing a curated entry for: ${missingGroups.join(', ')}.\n` +
        'Add a group + one-line summary for each new command in packages/agent-kit/src/curated/command-groups.ts.',
    );
  }
  const missingHookNotes = missingCuratedKeys(HOOK_NOTES_SRC, surface.reactHooks);
  if (missingHookNotes.length > 0) {
    curatedGap = true;
    console.error(
      `hook-notes.ts is missing a curated note for: ${missingHookNotes.join(', ')}.\n` +
        'Add a one-line note for each new widget React hook in packages/agent-kit/src/curated/hook-notes.ts.',
    );
  }
  if (curatedGap && checkOnly) process.exit(1);

  if (checkOnly) {
    const existing = existsSync(OUT_FILE) ? readFileSync(OUT_FILE, 'utf-8') : '';
    if (existing !== next) {
      console.error(
        `${OUT_FILE} is stale. Run "pnpm skills:gen" to update the agent-kit skill surface.`,
      );
      process.exit(1);
    }
    console.log(
      `agent-kit skill surface up to date (${surface.commands.length} commands, ` +
        `${surface.sdkExports.length} SDK exports, ${surface.errorCodes.length} error codes, ` +
        `${surface.reactHooks.length} React hooks).`,
    );
    return;
  }

  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, next, 'utf-8');
  console.log(
    `Generated ${OUT_FILE} (${surface.commands.length} commands, ` +
      `${surface.sdkExports.length} SDK exports, ${surface.errorCodes.length} error codes, ` +
      `${surface.reactHooks.length} React hooks).`,
  );
}

// Only run when invoked directly (not when imported by the drift-gate test).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
