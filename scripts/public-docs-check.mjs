#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

const root = process.cwd();
const routedDocs = [
  'docs/README.md',
  'docs/architecture.md',
  'docs/backup-and-restore.md',
  'docs/compatibility-and-upgrades.md',
  'docs/configuration.md',
  'docs/connector-contributions.md',
  'docs/governance.md',
  'docs/security.md',
  'docs/self-hosting.md',
];
const communityDocs = [
  'CODE_OF_CONDUCT.md',
  'CONTRIBUTING.md',
  'LICENSE-SCOPE.md',
  'README.md',
  'SECURITY.md',
  'SUPPORT.md',
  'TRADEMARKS.md',
];
const scannedDocs = [...communityDocs, ...routedDocs];
const requiredFiles = [...scannedDocs, 'LICENSE', 'NOTICE'];
const findings = [];

function markdownFilesUnder(relativeDirectory) {
  const pending = [relativeDirectory];
  const files = [];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const relative = `${directory}/${entry.name}`;
      if (entry.isDirectory()) pending.push(relative);
      else if (entry.isFile() && entry.name.endsWith('.md')) files.push(relative);
    }
  }
  return files.sort();
}

for (const relative of requiredFiles) {
  if (!existsSync(join(root, relative))) findings.push(`missing public document: ${relative}`);
}

const actualRoutedDocs = existsSync(join(root, 'docs')) ? markdownFilesUnder('docs') : [];
if (JSON.stringify(actualRoutedDocs) !== JSON.stringify(routedDocs)) {
  findings.push(
    `public docs inventory mismatch: expected ${routedDocs.join(', ')}, received ${actualRoutedDocs.join(', ')}`,
  );
}

for (const relative of scannedDocs) {
  const absolute = join(root, relative);
  if (!existsSync(absolute)) continue;
  const contents = readFileSync(absolute, 'utf8');
  if (/docs\/decisions|docs\/runbooks|docs\/STATUS|private ADR/i.test(contents)) {
    findings.push(`${relative}: references private-only documentation`);
  }
  for (const match of contents.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].split('#', 1)[0];
    if (target.length === 0 || /^(?:https?:|mailto:)/.test(target)) continue;
    const resolved = normalize(join(root, dirname(relative), target));
    if (!resolved.startsWith(`${root}/`) || !existsSync(resolved)) {
      findings.push(`${relative}: broken relative link ${match[1]}`);
    }
  }
}

for (const relative of [...routedDocs, 'SECURITY.md', 'SUPPORT.md']) {
  const selfHost = join(root, relative);
  if (!existsSync(selfHost)) continue;
  const contents = readFileSync(selfHost, 'utf8');
  for (const header of [
    '**Owns:**',
    '**Read when:**',
    '**Do not put here:**',
    '**Update when:**',
  ]) {
    if (!contents.includes(header)) findings.push(`${relative}: missing ${header}`);
  }
}

if (findings.length > 0) {
  for (const finding of findings) console.error(`public-docs-check: ${finding}`);
  process.exitCode = 1;
} else {
  console.log(`public-docs-check ok (${routedDocs.length} routed documents)`);
}
