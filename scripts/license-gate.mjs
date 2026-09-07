#!/usr/bin/env node
/**
 * CI license gate (AGENTS.md standing safeguard / build-vs-adopt.md). Fails the build if any installed
 * dependency carries a license outside the **permissive, commercial-safe** allowlist — so a copyleft
 * (GPL/AGPL/LGPL/SSPL/BSL/source-available) package can never silently enter the runtime.
 *
 *   node scripts/license-gate.mjs        # exits 1 with the offenders on any violation
 *
 * Read-only: it shells out to `pnpm licenses list --json` over the installed tree. `MPL-2.0` is allowed
 * **only** for the known dev-only `lightningcss*` pair (weak, file-level copyleft, never shipped — see
 * build-vs-adopt.md); the public website has a narrow build/static-export exception for Next.js transitive
 * data/native-image packages. Any other non-allowlisted package fails.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const CANONICAL_APACHE_2_SHA256 =
  'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30';
const COPYRIGHT_NOTICE = 'Copyright 2026 TheNoodleSeed Corporation';

/** Permissive, commercial-safe SPDX ids — no copyleft obligation on our code. */
const PERMISSIVE = new Set([
  'MIT',
  'MIT-0',
  'ISC',
  '0BSD',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BSD', // deprecated bare SPDX id (BSD-2/3-Clause), still permissive — e.g. `url-template`
  'Apache-2.0',
  'Unlicense',
  'CC0-1.0',
  'BlueOak-1.0.0',
  'Python-2.0',
]);

/** Allowed only for these dev-only packages (MPL-2.0 is weak file-level copyleft; never shipped). */
const MPL_DEV_ONLY = /^lightningcss/;

/**
 * Allowed only for the static-export public website build. These are not runtime/service dependencies and
 * must not be used by Noodle Borg runtime packages.
 */
const WEBSITE_BUILD_ONLY = new Map([
  ['CC-BY-4.0', /^caniuse-lite$/],
  ['LGPL-3.0-or-later', /^@img\/sharp-libvips-/],
]);

/**
 * Website-only visual dependency exception (founder-authorized; see ADR 0104 and build-vs-adopt.md).
 * `@paper-design/shaders*` ships under PolyForm Shield 1.0.0 - source-available, NOT OSI-permissive, so
 * `pnpm licenses list` reports it as `Unknown`. It powers ONLY the marketing hero + "developer tools"
 * card WebGL shaders in `apps/website` and must never be imported by any runtime/service/CLI package.
 * PolyForm Shield restricts only *competing* use (a product that competes with the licensor's shader
 * tooling); an MCP app platform does not, so this specific use is permitted. Matched by package name
 * (not license id) because the two license-reading paths report it inconsistently (`Unknown` vs the raw
 * `SEE LICENSE IN ...` string).
 */
const WEBSITE_ONLY_SOURCE_AVAILABLE = /^@paper-design\/shaders/;

/**
 * The paper-design shaders report a non-SPDX license: `Unknown` (via `pnpm licenses list`) or the raw
 * `SEE LICENSE IN ...` / PolyForm string (installed-tree path). Only those are exempted - a real SPDX
 * license on a future `@paper-design/shaders*` package must still be judged by the normal allowlist.
 */
function isExpectedSourceAvailable(license) {
  return license === 'Unknown' || /polyform|see license in/i.test(license);
}

/**
 * Docs-only diagram dependency exception (mermaid -> khroma; see build-vs-adopt.md).
 * `khroma` (mermaid's color parser) ships an MIT `license` FILE but omits the SPDX
 * `license` FIELD in its package.json, so `pnpm licenses list` reports it as `Unknown`.
 * It is genuinely MIT (verified: the package's `license` file reads "The MIT License
 * (MIT)"), permissive and commercial-safe, and reaches only `apps/docs` via mermaid.
 */
const DOCS_ONLY_MIT_NO_SPDX = /^khroma$/;

/**
 * Website-only `react-share` transitive dependency. `jsonp@0.2.1` omits a package.json license field,
 * but its distributed Readme has an explicit MIT license section. Keep this name-exact and Unknown-only.
 */
const WEBSITE_ONLY_MIT_NO_SPDX = /^jsonp$/;

/** Evaluate an SPDX expression: `A OR B` is permissive if **any** side is; `A AND B` if **all** are. */
function isPermissive(expr) {
  const clean = expr
    .trim()
    .replace(/^\(|\)$/g, '')
    .trim();
  if (/\sOR\s/i.test(clean)) return clean.split(/\sOR\s/i).some(isPermissive);
  if (/\sAND\s/i.test(clean)) return clean.split(/\sAND\s/i).every(isPermissive);
  return PERMISSIVE.has(clean);
}

function main() {
  const root = process.cwd();
  const policyErrors = repositoryLicensePolicyErrors({
    license: readFileSync(join(root, 'LICENSE'), 'utf8'),
    cliLicense: readFileSync(join(root, 'packages', 'cli', 'LICENSE'), 'utf8'),
    notice: readFileSync(join(root, 'NOTICE'), 'utf8'),
    rootManifest: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')),
  });
  if (policyErrors.length > 0) {
    console.error('license-gate: FIRST-PARTY LICENSE POLICY FAILED:');
    for (const error of policyErrors) console.error(`  - ${error}`);
    process.exit(1);
  }

  const byLicense = loadLicenses();

  const violations = [];
  for (const [license, packages] of Object.entries(byLicense)) {
    const names = (packages ?? []).map((p) => p.name);
    if (isPermissive(license)) continue;
    // First-party workspace packages are covered by the repo's own license, not
    // third-party compliance. They can surface on either license-loading path
    // (notably under `--config.inject-workspace-packages=true`, as CI uses) with
    // no SPDX `license` field; skip them here so neither path flags an internal
    // package (they ship inside the Apache-2.0 CLI).
    const bad = names.filter((n) => !isAllowedException(license, n) && !isFirstPartyPackage(n));
    if (bad.length > 0) violations.push({ license, packages: bad });
  }

  const total = Object.values(byLicense).reduce((n, ps) => n + (ps?.length ?? 0), 0);
  if (violations.length === 0) {
    console.log(
      `license-gate: OK — ${total} packages, all permissive or documented build-only exceptions.`,
    );
    process.exit(0);
  }
  console.error('license-gate: DISALLOWED licenses found (not in the permissive allowlist):');
  for (const v of violations) {
    console.error(`  ${v.license}: ${v.packages.join(', ')}`);
  }
  console.error(
    '\nAllowlist:',
    [...PERMISSIVE].join(', '),
    '(+ documented dev/build-only exceptions).',
  );
  console.error('See docs/references/build-vs-adopt.md. Copyleft must never enter the runtime.');
  process.exit(1);
}

export function repositoryLicensePolicyErrors({ license, cliLicense, notice, rootManifest }) {
  const errors = [];
  const digest = createHash('sha256').update(license).digest('hex');
  if (digest !== CANONICAL_APACHE_2_SHA256) {
    errors.push('root LICENSE must be the canonical Apache-2.0 text from apache.org');
  }
  if (cliLicense !== license) {
    errors.push('packages/cli/LICENSE must match the root LICENSE exactly');
  }
  if (!notice.split(/\r?\n/).includes(COPYRIGHT_NOTICE)) {
    errors.push(`NOTICE must contain the exact holder line: ${COPYRIGHT_NOTICE}`);
  }
  if (rootManifest?.name === 'noodle-core' && rootManifest.license !== 'Apache-2.0') {
    errors.push('the public noodle-core package manifest must declare Apache-2.0');
  }
  return errors;
}

export function isAllowedException(license, packageName) {
  if (license === 'MPL-2.0' && MPL_DEV_ONLY.test(packageName)) return true;
  if (license === 'Unknown' && DOCS_ONLY_MIT_NO_SPDX.test(packageName)) return true;
  if (license === 'Unknown' && WEBSITE_ONLY_MIT_NO_SPDX.test(packageName)) return true;
  if (WEBSITE_ONLY_SOURCE_AVAILABLE.test(packageName) && isExpectedSourceAvailable(license)) {
    return true;
  }
  const pattern = WEBSITE_BUILD_ONLY.get(license);
  return pattern?.test(packageName) ?? false;
}

function loadLicenses() {
  if (process.env.NOODLE_LICENSE_GATE_INSTALLED_TREE === '1') {
    console.log('license-gate: using installed package metadata.');
    return loadLicensesFromInstalledTree();
  }
  try {
    const raw = execFileSync('pnpm', ['licenses', 'list', '--json'], {
      encoding: 'utf8',
      maxBuffer: 64 << 20,
    });
    return JSON.parse(raw);
  } catch (error) {
    console.error(
      'license-gate: `pnpm licenses list --json` failed; falling back to installed package metadata:',
      error.message,
    );
    return loadLicensesFromInstalledTree();
  }
}

/** First-party scopes authored in this repo (see the first-party skip in `main`). */
const FIRST_PARTY_SCOPES = ['@noodle-borg/', '@noodleseed/', '@noodleseed-com/'];
export function isFirstPartyPackage(name) {
  return FIRST_PARTY_SCOPES.some((scope) => name.startsWith(scope));
}

function loadLicensesFromInstalledTree() {
  const root = join(process.cwd(), 'node_modules', '.pnpm');
  const byLicense = {};
  const seen = new Set();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'node_modules') continue;
    const modulesDir = join(root, entry.name, 'node_modules');
    for (const pkgJson of packageJsonFiles(modulesDir)) {
      let pkg;
      try {
        pkg = JSON.parse(readFileSync(pkgJson, 'utf8'));
      } catch {
        continue;
      }
      if (typeof pkg.name !== 'string') continue;
      const key = `${pkg.name}@${pkg.version ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const license = licenseOf(pkg);
      byLicense[license] ??= [];
      byLicense[license].push({ name: pkg.name, version: pkg.version ?? '' });
    }
  }
  return byLicense;
}

function packageJsonFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name === 'package.json') out.push(path);
    if ((entry.isDirectory() || entry.isSymbolicLink()) && entry.name.startsWith('@')) {
      for (const scoped of readdirSync(path, { withFileTypes: true })) {
        const scopedPath = join(path, scoped.name, 'package.json');
        if (scoped.isDirectory() || scoped.isSymbolicLink()) out.push(scopedPath);
      }
    } else if (entry.isDirectory() || entry.isSymbolicLink()) {
      out.push(join(path, 'package.json'));
    }
  }
  return out;
}

export function licenseOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license && typeof pkg.license.type === 'string') return pkg.license.type;
  if (Array.isArray(pkg.licenses) && pkg.licenses[0]?.type) return pkg.licenses[0].type;
  // Match `pnpm licenses list --json`'s casing for missing license metadata so
  // isAllowedException's `license === 'Unknown'` check applies consistently across both
  // license-loading paths (see loadLicenses' installed-tree fallback).
  return 'Unknown';
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
