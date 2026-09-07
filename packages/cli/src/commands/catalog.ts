/**
 * The CLI's declarative command catalog: the single source of truth `usage()`, per-command
 * `--help`, `noodle commands --json`, and did-you-mean suggestions all render from. Data lives in
 * `catalog-data-core.ts` (CLI meta-verbs), `catalog-data-bootstrap-authoring.ts`
 * (bootstrap and local authoring),
 * `catalog-data-platform-auth.ts` (restricted WorkOS operator), the hosted/tenant/account modules,
 * and `catalog-data-config.ts` (deploy-target + managed config);
 * this module merges them and adds the small amount of lookup logic every renderer needs.
 *
 * `test/catalog.test.ts` asserts every `case` in `cli.ts`'s dispatch switch has a matching entry
 * here (and vice versa) — the anti-drift lock referenced in AGENTS.md.
 */
import { CATALOG_ACCOUNT } from './catalog-data-account.js';
import { ASSISTANT_COMMAND } from './catalog-data-assistant.js';
import { CATALOG_AUTH_DISCOVERY } from './catalog-data-auth-discovery.js';
import { CATALOG_BOOTSTRAP_AUTHORING } from './catalog-data-bootstrap-authoring.js';
import { CATALOG_BOOTSTRAP_PRE_AUTH } from './catalog-data-bootstrap-pre-auth.js';
import { CATALOG_CONFIG } from './catalog-data-config.js';
import { CATALOG_CORE } from './catalog-data-core.js';
import { CATALOG_DISTRIBUTIONS } from './catalog-data-distributions.js';
import { CATALOG_HOSTED_DEPLOYMENT } from './catalog-data-hosted-deployment.js';
import { BILLING_COMMAND, POLICY_COMMAND } from './catalog-data-hosted-governance.js';
import { CATALOG_HOSTED_OBSERVABILITY } from './catalog-data-hosted-observability.js';
import { CATALOG_LOCAL_AUTHORING } from './catalog-data-local-authoring.js';
import { CATALOG_PLATFORM_AUTH } from './catalog-data-platform-auth.js';
import { CATALOG_TENANT_ADMIN } from './catalog-data-tenant-admin.js';
import { CATALOG_TENANT_RESOURCES } from './catalog-data-tenant-resources.js';
import type { CommandSpec } from './catalog-types.js';

export type {
  ArgumentSpec,
  CommandSpec,
  FlagSpec,
  SubcommandSpec,
} from './catalog-types.js';

/** The full command catalog, in a stable, curated order (not alphabetical — grouped by workflow). */
export const CATALOG: readonly CommandSpec[] = [
  ...CATALOG_CORE,
  ...CATALOG_BOOTSTRAP_PRE_AUTH,
  ...CATALOG_AUTH_DISCOVERY,
  ...CATALOG_BOOTSTRAP_AUTHORING,
  ...CATALOG_LOCAL_AUTHORING,
  ...CATALOG_PLATFORM_AUTH,
  BILLING_COMMAND,
  ASSISTANT_COMMAND,
  ...CATALOG_HOSTED_OBSERVABILITY,
  POLICY_COMMAND,
  ...CATALOG_HOSTED_DEPLOYMENT,
  ...CATALOG_TENANT_RESOURCES,
  CATALOG_DISTRIBUTIONS,
  ...CATALOG_ACCOUNT,
  ...CATALOG_TENANT_ADMIN,
  ...CATALOG_CONFIG,
];

/**
 * The standard CLI exit-code taxonomy (ADR 0129), described for `commands --json` consumers.
 * Mirrors `EXIT` in `commands/output.ts`; kept as a separate literal here so this module has no
 * runtime dependency on it (see the "no cross-file runtime imports" rule in `catalog-data-core.ts`
 * — `output.ts` is never imported by the raw-source doc/skill generators, but `catalog.ts` itself
 * only needs the numbers/descriptions, not the `EXIT` binding).
 */
export const STANDARD_EXIT_CODES: Readonly<Record<number, string>> = {
  0: 'success',
  1: 'domain/runtime failure (the request ran but did not succeed)',
  2: 'usage error, missing target, or headless missing-answer',
  3: 'authentication/authorization failure (HTTP 401/403)',
  4: 'service unreachable (network error)',
  5: 'MCP/tool-call smoke failure',
};

/** Command names that dispatch to at least one subcommand and error on a missing/unknown one —
 * the set eligible for centralized bare-noun help and subcommand did-you-mean in `cli.ts`. Kept
 * as an explicit allowlist (not "every catalog entry with `subcommands`") because a few commands
 * with subcommand-shaped data (e.g. `connect`, `tools`) either treat a bare invocation as
 * meaningful on their own or resolve state before checking the subcommand token. */
export const SUBCOMMAND_DISPATCHERS: ReadonlySet<string> = new Set([
  'auth',
  'apps',
  'envs',
  'deployments',
  'distributions',
  'orgs',
  'members',
  'github',
  'target',
  'secrets',
  'variables',
  'agents',
  'audit',
  'billing',
  'policy',
  'platform-auth',
  'service',
  'solutions',
  'docs',
  'import',
  'export',
  'connect',
  'access',
]);

/** Names to exclude from did-you-mean suggestions: removed verbs. Never point a typo at a dead end. */
function activeCatalogNames(): readonly string[] {
  return CATALOG.filter((entry) => entry.removed === undefined).map((entry) => entry.name);
}

export function findCommand(name: string | undefined): CommandSpec | undefined {
  if (name === undefined) return undefined;
  return CATALOG.find((entry) => entry.name === name);
}

/** Levenshtein edit distance, iterative DP with an O(min(a,b)) row buffer. */
function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current.push(
        Math.min(
          (current[j - 1] ?? 0) + 1, // insertion
          (previous[j] ?? 0) + 1, // deletion
          (previous[j - 1] ?? 0) + cost, // substitution
        ),
      );
    }
    previous = current;
  }
  return previous[b.length] ?? Math.max(a.length, b.length);
}

/** Nearest catalog names to `input` within `maxDistance`, closest first, capped at `maxResults`. */
function closestNames(
  input: string,
  pool: readonly string[],
  maxDistance = 2,
  maxResults = 3,
): readonly string[] {
  return pool
    .map((name) => ({ name, distance: levenshteinDistance(input, name) }))
    .filter((entry) => entry.distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
    .slice(0, maxResults)
    .map((entry) => entry.name);
}

/** Nearest *active* (non-removed) top-level command names to an unknown verb. */
export function closestCommands(input: string, maxDistance = 2, maxResults = 3): readonly string[] {
  return closestNames(input, activeCatalogNames(), maxDistance, maxResults);
}

/** Nearest subcommand names for a catalog entry that has subcommands. */
export function closestSubcommands(
  entry: CommandSpec,
  input: string,
  maxDistance = 2,
  maxResults = 3,
): readonly string[] {
  const pool = (entry.subcommands ?? []).map((sub) => sub.name);
  return closestNames(input, pool, maxDistance, maxResults);
}
