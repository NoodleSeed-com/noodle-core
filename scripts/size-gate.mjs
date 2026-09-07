#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_THRESHOLDS = {
  source: { warnLines: 500, maxLines: 800, maxBytes: 120_000 },
  test: { warnLines: 700, maxLines: 1200, maxBytes: 180_000 },
  docs: { warnLines: 500, maxLines: 1000, maxBytes: 160_000 },
};

const DEFAULT_EXCLUDED_DIRS = new Set([
  '.claude',
  '.git',
  '.next',
  '.noodle',
  '.pnpm-store',
  '.tmp-publish',
  '.turbo',
  '.worktrees',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'noodle-publish',
  'out',
]);

const TRACKED_EXTENSIONS = new Set(['.js', '.mjs', '.ts', '.tsx', '.md', '.mdx']);

function parseArgs(argv) {
  const options = {
    root: process.cwd(),
    config: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      options.root = argv[index + 1];
      index += 1;
    } else if (arg === '--config') {
      options.config = argv[index + 1];
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log('usage: node scripts/size-gate.mjs [--root <dir>] [--config <file>]');
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
    : path.join(root, 'size-gate.config.json');
  if (!existsSync(configFile)) {
    return { thresholds: DEFAULT_THRESHOLDS, allow: [] };
  }
  const parsed = JSON.parse(readFileSync(configFile, 'utf8'));
  const thresholds = {
    source: { ...DEFAULT_THRESHOLDS.source, ...(parsed.thresholds?.source || {}) },
    test: { ...DEFAULT_THRESHOLDS.test, ...(parsed.thresholds?.test || {}) },
    docs: { ...DEFAULT_THRESHOLDS.docs, ...(parsed.thresholds?.docs || {}) },
  };
  return { thresholds, allow: parsed.allow || [] };
}

function validateConfig(config) {
  const errors = [];
  for (const entry of config.allow) {
    if (!entry.path || typeof entry.path !== 'string') {
      errors.push('allowlist entry must include a path');
      continue;
    }
    if (!entry.reason || typeof entry.reason !== 'string' || entry.reason.trim().length < 10) {
      errors.push(`allowlist entry ${entry.path} must include a reason`);
    }
  }
  return errors;
}

function globToRegExp(glob) {
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    const next = glob[index + 1];
    if (char === '*' && next === '*') {
      source += '.*';
      index += 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

function isAllowed(rel, allow) {
  return allow.some((entry) => globToRegExp(entry.path).test(rel));
}

function collectFiles(root, dir = root, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (DEFAULT_EXCLUDED_DIRS.has(entry)) continue;
      collectFiles(root, full, files);
      continue;
    }
    if (!stat.isFile()) continue;
    if (!TRACKED_EXTENSIONS.has(path.extname(entry))) continue;
    files.push(full);
  }
  return files;
}

function classify(rel) {
  if (rel.endsWith('.md') || rel.endsWith('.mdx')) return 'docs';
  if (
    rel.includes('/test/') ||
    rel.includes('/tests/') ||
    /(?:^|[.-])(test|spec)\.[cm]?[jt]sx?$/.test(path.basename(rel))
  ) {
    return 'test';
  }
  return 'source';
}

function lineCount(text) {
  if (!text) return 0;
  return text.split(/\r?\n/).length;
}

function run() {
  const options = parseArgs(process.argv.slice(2));
  const root = path.resolve(options.root);
  const config = loadConfig(root, options.config);
  const configErrors = validateConfig(config);
  if (configErrors.length) {
    console.error('size-gate config failed:');
    for (const error of configErrors) console.error(`- ${error}`);
    process.exit(2);
  }

  const failures = [];
  const warnings = [];
  let checked = 0;
  let skipped = 0;

  for (const file of collectFiles(root)) {
    const rel = normalizeRel(path.relative(root, file));
    if (isAllowed(rel, config.allow)) {
      skipped += 1;
      continue;
    }
    const kind = classify(rel);
    const limits = config.thresholds[kind];
    const text = readFileSync(file, 'utf8');
    const lines = lineCount(text);
    const bytes = Buffer.byteLength(text, 'utf8');
    checked += 1;

    if (lines > limits.maxLines || bytes > limits.maxBytes) {
      failures.push({ rel, kind, lines, bytes, limits });
    } else if (lines > limits.warnLines) {
      warnings.push({ rel, kind, lines, bytes, limits });
    }
  }

  if (warnings.length) {
    console.log(`size-gate warnings (${warnings.length} file(s) near the limit):`);
    for (const warning of warnings) {
      console.log(
        `- ${warning.rel}: ${warning.lines} lines (${warning.kind}, warn ${warning.limits.warnLines}, limit ${warning.limits.maxLines})`,
      );
    }
  }

  if (failures.length) {
    console.error(`size-gate failed with ${failures.length} oversized file(s):`);
    for (const failure of failures) {
      console.error(
        `- ${failure.rel}: ${failure.lines} lines, ${failure.bytes} bytes (${failure.kind}, limit ${failure.limits.maxLines} lines / ${failure.limits.maxBytes} bytes)`,
      );
    }
    console.error(
      'Fix: split by responsibility, move append-only history into history docs, or add an allowlist entry only for generated/vendored/intentionally archival files.',
    );
    process.exit(1);
  }

  console.log(`size-gate ok (${checked} checked, ${skipped} allowlisted)`);
}

try {
  run();
} catch (error) {
  console.error(`size-gate failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
