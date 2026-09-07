/**
 * Shared update-system core (#242, ADR 0124): package identity, installed-version
 * lookup, registry `latest` fetch, and version comparison.
 *
 * The update system is split along its natural seams:
 * - `update.ts` (this file) — shared constants + helpers.
 * - `update-binary.ts` — global `noodle` binary ownership resolver (safe vs unsafe repair).
 * - `commands/update-ops.ts` — the `noodle update` command (--check/--yes/--repair/--json).
 * - `update-check.ts` — the passive post-command check (default prompt, modes, snooze).
 */
import { readFileSync } from 'node:fs';

export const CLI_PACKAGE_NAME = '@noodleseed/one';
export const GLOBAL_UPDATE_COMMAND = `npm install -g ${CLI_PACKAGE_NAME}@latest`;

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REGISTRY_LATEST_URL = `https://registry.npmjs.org/${encodeURIComponent(CLI_PACKAGE_NAME)}/latest`;

let versionCache: string | undefined;

export function currentCliVersion(): string {
  if (versionCache !== undefined) return versionCache;
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version?: unknown;
  };
  versionCache = typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  return versionCache;
}

/** True for set env toggles, honoring the `0`/`false` opt-outs. */
export function truthyEnv(value: string | undefined): boolean {
  if (value === undefined || value === '') return false;
  return value !== '0' && value.toLowerCase() !== 'false';
}

/**
 * Fetch the registry `latest` dist-tag version of the CLI package. Throws on
 * failure so callers choose their own inconclusive-network handling. The passive
 * check uses the default ~1s budget; the explicit `noodle update` command passes
 * a longer one.
 */
export async function fetchLatestVersion(
  fetchImpl: typeof fetch,
  timeoutMs = 1000,
): Promise<string | undefined> {
  const res = await fetchImpl(REGISTRY_LATEST_URL, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return undefined;
  const body = (await res.json()) as { version?: unknown };
  return typeof body.version === 'string' ? body.version : undefined;
}

export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l > r) return 1;
    if (l < r) return -1;
  }
  return 0;
}

function parseVersion(version: string): number[] {
  return version
    .replace(/^v/, '')
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => {
      const value = Number.parseInt(part, 10);
      return Number.isFinite(value) ? value : 0;
    });
}
