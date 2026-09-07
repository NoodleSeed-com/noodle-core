#!/usr/bin/env node
/**
 * Spawned-binary gate: a dependency reached only through `node_modules/.bin/<name>` is invisible to
 * import-graph analysis, so `knip` reports it unused and a cleanup deletes it. Nothing fails until a
 * FRESH install, because the binary lingers in an older `node_modules` — which is why this class of
 * removal clears every static gate and every local suite, then breaks the post-merge pipeline
 * (2026-09-02: `@arethetypeswrong/cli` removed from `packages/assistant`, auto-reverting #1422).
 *
 * The rule: a binary a package EXECUTES out of its own `node_modules/.bin` must be provided by a
 * dependency that package DECLARES. Execution is the discriminator, not an allowlist — tests that
 * build fake `.bin` entries inside temp fixtures write and link those paths, they never spawn them,
 * so they are not toolchain dependencies and this gate leaves them alone.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKSPACE_GROUPS = ['packages', 'apps'];
const ROOT_SCAN_DIRS = ['scripts'];
const EXCLUDED_DIRS = new Set(['.next', 'dist', 'node_modules', 'coverage', '.turbo']);
const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
/**
 * `join(x, 'node_modules', '.bin', 'attw')` and the flat `'node_modules/.bin/attw'` spelling.
 * `node_modules` is required in the sequence: a bare `.bin` segment belongs to some other tree —
 * a temp fixture, say — and its contents are not this package's declared toolchain.
 */
const JOINED_BIN = /['"]node_modules['"]\s*,\s*['"]\.bin['"]\s*,\s*['"]([A-Za-z0-9._-]+)['"]/g;
const PATH_BIN = /node_modules\/\.bin\/([A-Za-z0-9._-]+)/g;
const SPAWN_CALL = /\b(?:spawnSync|spawn|execFileSync|execFile)\s*\(/;
const BINDING = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=[^=]*$/;

function parseArgs(argv) {
  const options = { root: process.cwd() };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      options.root = argv[index + 1];
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log('usage: node scripts/spawned-binary-gate.mjs [--root <dir>]');
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function normalizeRel(file) {
  return file.split(path.sep).join('/');
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) yield* walk(path.join(dir, entry.name));
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      yield path.join(dir, entry.name);
    }
  }
}

/** Every workspace package directory, plus the root, each paired with the dirs to scan under it. */
function scanTargets(root) {
  const targets = [{ dir: root, scan: ROOT_SCAN_DIRS.map((sub) => path.join(root, sub)) }];
  for (const group of WORKSPACE_GROUPS) {
    let members;
    try {
      members = readdirSync(path.join(root, group));
    } catch {
      continue;
    }
    for (const member of members) {
      const dir = path.join(root, group, member);
      if (!existsSync(path.join(dir, 'package.json'))) continue;
      if (!statSync(dir).isDirectory()) continue;
      targets.push({ dir, scan: [dir] });
    }
  }
  return targets;
}

/**
 * The statement a match sits in: everything back to the previous statement or block boundary. A
 * `join(...)` broken across lines stays intact, so multi-line calls read the same as single-line.
 */
function enclosingStatement(text, index) {
  const start = Math.max(
    text.lastIndexOf(';', index),
    text.lastIndexOf('{', index),
    text.lastIndexOf('}', index),
  );
  return text.slice(start + 1, index);
}

/** Binaries this file hands to a process-spawning call, directly or through one binding. */
export function executedBinaries(text) {
  const found = new Set();
  for (const pattern of [JOINED_BIN, PATH_BIN]) {
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match !== null) {
      const binary = match[1];
      const statement = enclosingStatement(text, match.index);
      if (SPAWN_CALL.test(statement)) {
        found.add(binary);
      } else {
        const binding = BINDING.exec(statement);
        if (binding) {
          const used = new RegExp(
            `\\b(?:spawnSync|spawn|execFileSync|execFile)\\s*\\(\\s*${binding[1]}\\b`,
          );
          if (used.test(text)) found.add(binary);
        }
      }
      match = pattern.exec(text);
    }
  }
  return [...found];
}

/** Binary names a declared dependency installs, read from the dependency's own manifest. */
function providedBinaries(packageDir, dependency) {
  const manifest = readJson(path.join(packageDir, 'node_modules', dependency, 'package.json'));
  if (!manifest) return undefined;
  const { bin } = manifest;
  if (typeof bin === 'string') return [dependency.split('/').pop()];
  if (bin && typeof bin === 'object') return Object.keys(bin);
  return [];
}

export function findUndeclaredBinaries(root) {
  const offenders = [];
  for (const { dir, scan } of scanTargets(root)) {
    const manifest = readJson(path.join(dir, 'package.json'));
    if (!manifest) continue;
    const declared = Object.keys({
      ...(manifest.dependencies ?? {}),
      ...(manifest.devDependencies ?? {}),
    });
    for (const scanDir of scan) {
      for (const file of walk(scanDir)) {
        const rel = normalizeRel(path.relative(root, file));
        for (const binary of executedBinaries(readFileSync(file, 'utf8'))) {
          const provider = declared.find((dependency) =>
            (providedBinaries(dir, dependency) ?? []).includes(binary),
          );
          if (!provider) offenders.push({ file: rel, binary });
        }
      }
    }
  }
  return offenders;
}

function main() {
  const { root } = parseArgs(process.argv.slice(2));
  const offenders = findUndeclaredBinaries(path.resolve(root));
  if (offenders.length === 0) {
    console.log('spawned-binary-gate: every executed binary is declared by its own package');
    return;
  }
  console.error(
    `spawned-binary-gate: ${offenders.length} undeclared spawned binary(s). Add the dependency that ` +
      'provides each one to that package, and never delete it on a knip report alone: knip reads ' +
      'imports, and a binary spawned by path has none.',
  );
  for (const offender of offenders) {
    console.error(`  ${offender.file}: spawns '${offender.binary}', declared by no dependency`);
  }
  process.exit(1);
}

if (
  process.argv[1] &&
  realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
) {
  main();
}
