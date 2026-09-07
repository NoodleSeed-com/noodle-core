#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { withoutTemplateLiterals } from './lib/source-text.mjs';

const DEFAULT_BUDGETS = {
  explicitAny: 0,
  tsExpectError: 0,
  tsIgnore: 0,
  biomeIgnore: 0,
  eslintDisable: 0,
};

const EXCLUDED_DIRS = new Set([
  '.git',
  '.next',
  '.pnpm-store',
  'coverage',
  'dist',
  'node_modules',
  'noodle-publish',
  'out',
]);

const INCLUDED_ROOTS = ['packages', 'apps', 'examples', 'scripts'];
const INCLUDED_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
const EXCLUDED_FILES = new Set(['packages/protocol/src/widget/ext-apps-bundle.ts']);
const TS_EXPECT_ERROR = '@ts-' + 'expect-error';
const TS_IGNORE = '@ts-' + 'ignore';
const BIOME_IGNORE = 'biome-' + 'ignore';
const ESLINT_DISABLE = 'eslint-' + 'disable';

function parseArgs(argv) {
  const options = { root: process.cwd(), config: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      options.root = argv[index + 1];
      index += 1;
    } else if (arg === '--config') {
      options.config = argv[index + 1];
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log('usage: node scripts/escape-hatch-gate.mjs [--root <dir>] [--config <file>]');
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

function loadConfig(root, explicitConfig) {
  const configFile = explicitConfig
    ? path.resolve(root, explicitConfig)
    : path.join(root, 'quality-gates.config.json');
  if (!existsSync(configFile)) return { budgets: DEFAULT_BUDGETS };
  const parsed = JSON.parse(readFileSync(configFile, 'utf8'));
  return {
    budgets: { ...DEFAULT_BUDGETS, ...(parsed.escapeHatches?.budgets ?? {}) },
  };
}

function collectFiles(root, dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry)) continue;
      collectFiles(root, full, files);
      continue;
    }
    if (!stat.isFile() || !INCLUDED_EXTENSIONS.has(path.extname(entry))) continue;
    const rel = normalizeRel(path.relative(root, full));
    if (EXCLUDED_FILES.has(rel)) continue;
    files.push(full);
  }
  return files;
}

function collectRootFiles(root) {
  const files = [];
  for (const entry of INCLUDED_ROOTS) {
    const full = path.join(root, entry);
    if (existsSync(full)) collectFiles(root, full, files);
  }
  return files;
}

function pushMatches(results, kind, rel, lines, pattern, shouldSkip = () => false) {
  lines.forEach((line, index) => {
    if (shouldSkip(line)) return;
    if (pattern.test(line)) results.push({ kind, rel, line: index + 1, text: line.trim() });
  });
}

function isCommentOnly(line) {
  return /^\s*(?:\/\/|\/\*|\*|#)/.test(line);
}

function hasReason(line, token) {
  const index = line.indexOf(token);
  if (index === -1) return true;
  const suffix = line.slice(index + token.length).trim();
  return /(?:[:—-]\s*)\S.{9,}/.test(suffix);
}

function scanFile(root, file) {
  const rel = normalizeRel(path.relative(root, file));
  const text = readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  // `any` inside a template literal is fixture or scaffold text, not a type annotation.
  const codeLines = withoutTemplateLiterals(text).split(/\r?\n/);
  const matches = [];
  pushMatches(
    matches,
    'explicitAny',
    rel,
    codeLines,
    /\bas\s+any\b|:\s*any\b|<\s*any\s*>/,
    isCommentOnly,
  );
  pushMatches(matches, 'tsExpectError', rel, lines, new RegExp(`${TS_EXPECT_ERROR}\\b`));
  pushMatches(matches, 'tsIgnore', rel, lines, new RegExp(`${TS_IGNORE}\\b`));
  pushMatches(matches, 'biomeIgnore', rel, lines, new RegExp(`${BIOME_IGNORE}\\b`));
  pushMatches(matches, 'eslintDisable', rel, lines, new RegExp(`${ESLINT_DISABLE}\\b`));
  return matches;
}

function validateReasons(matches) {
  return matches.filter((match) => {
    if (match.kind === 'tsExpectError') return !hasReason(match.text, TS_EXPECT_ERROR);
    if (match.kind === 'tsIgnore') return !hasReason(match.text, TS_IGNORE);
    if (match.kind === 'biomeIgnore') return !hasReason(match.text, BIOME_IGNORE);
    if (match.kind === 'eslintDisable') return !hasReason(match.text, ESLINT_DISABLE);
    return false;
  });
}

function run() {
  const options = parseArgs(process.argv.slice(2));
  const root = path.resolve(options.root);
  const config = loadConfig(root, options.config);
  const matches = collectRootFiles(root).flatMap((file) => scanFile(root, file));
  const counts = Object.fromEntries(Object.keys(DEFAULT_BUDGETS).map((key) => [key, 0]));
  for (const match of matches) counts[match.kind] += 1;

  const failures = [];
  for (const [kind, budget] of Object.entries(config.budgets)) {
    if ((counts[kind] ?? 0) > budget) {
      failures.push(`${kind}: ${counts[kind]} found, budget ${budget}`);
    }
  }
  for (const match of validateReasons(matches)) {
    failures.push(`${match.rel}:${match.line}: ${match.kind} must include a same-line reason`);
  }

  if (failures.length) {
    console.error(`escape-hatch-gate failed with ${failures.length} issue(s):`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log(
    `escape-hatch-gate ok (${Object.entries(counts)
      .map(([kind, count]) => `${kind}=${count}/${config.budgets[kind]}`)
      .join(', ')})`,
  );
}

try {
  run();
} catch (error) {
  console.error(
    `escape-hatch-gate failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(2);
}
