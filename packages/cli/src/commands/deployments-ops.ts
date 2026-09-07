import type { ConfigLocation } from '../config.js';
/**
 * The `deployments` resource commands: `noodle deployments list` / `noodle deployments inspect`.
 * Absorbs the deploy-scoped view previously served by `noodle list` (ADR 0128 D4): the collection
 * route `GET /v1/orgs/{org}/deployments` is long-shipped and unwrapped (`{ok:true,deployments}`,
 * no `data`); the item route `GET /v1/orgs/{org}/deployments/{deploymentId}` (deployment inspect)
 * mirrors the `apps`/`envs` item routes (`{ok:true,data:DeploymentSummary}`). When no org/token is
 * resolvable — the common no-login case — `list` falls back to the local `~/.noodle/servers.json`
 * cache, preserving `noodle list`'s legacy local-runtime behavior unchanged. The wire types, target
 * resolution, failure builders, and branded table styling live in `resource-shared.ts`.
 */
import { readServers } from '../config.js';
import { resolveControlPlaneToken, ServiceRequestError, serviceJson } from '../control-plane.js';
import { relativeTime } from '../relative-time.js';
import { type Column, renderTable, type TableOptions } from '../table.js';
import { parseWatchFlags, runWatch, type WatchFrame, watchJsonConflictFailure } from '../watch.js';
import { runDeploymentLockUpdate } from './deployment-lock-ops.js';
import { runDeploymentPackage } from './deployment-package.js';
import { EXIT, printJsonOk } from './output.js';
import {
  ACCESS_CHIP_COLORS,
  ACTIVE_GREEN,
  ARCHIVED_AMBER,
  authRequired,
  type DeploymentResponse,
  type DeploymentSummary,
  type DeploymentsListResponse,
  DIM_GRAY,
  notFoundDeployment,
  resolveOrgTarget,
  stdoutTableOptions,
} from './resource-shared.js';
import {
  parseCommandFlags,
  printCliFailure,
  printCommandUsageFailure,
  serviceFailure,
  usage,
} from './shared.js';
import { pickOrgInteractively } from './target-picker.js';

export async function runDeployments(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const [subcommand, ...tail] = rest;
  if (subcommand === 'list') return runDeploymentsList(tail, env, home);
  if (subcommand === 'inspect') return runDeploymentsInspect(tail, env, home);
  if (subcommand === 'package') return runDeploymentPackage(tail, env, home);
  if (subcommand === 'lock' || subcommand === 'unlock') {
    return runDeploymentLockUpdate(subcommand, tail, env, home);
  }
  usage();
  return EXIT.USAGE;
}

// --- shared arg parsing --------------------------------------------------------

interface CommonDeploymentsArgs {
  readonly org?: string;
  readonly app?: string;
  readonly targetEnv?: string;
  readonly service?: string;
  readonly authToken?: string;
  readonly json: boolean;
  /** `--archived`: opt archived deployments into the list (only `list` reads it). */
  readonly archived: boolean;
}

function parseCommonDeploymentsArgs(rest: readonly string[]): {
  readonly common: CommonDeploymentsArgs;
  readonly positional: string[];
} {
  const { positional, ...common } = parseCommandFlags(rest, {
    values: {
      '--org': 'org',
      '--app': 'app',
      '--env': 'targetEnv',
      '--service': 'service',
      '--auth-token': 'authToken',
    },
    booleans: { '--json': 'json', '--archived': 'archived' },
  });
  return { common, positional: [...positional] };
}

// --- list ------------------------------------------------------------------------

/**
 * Fetch + render the `deployments list` view (hosted table, or the local saved-servers-cache
 * fallback when no org+token resolves) — shared by the one-shot print and `--watch`. Never
 * fails in the local-fallback branch (a plain file read), only the hosted fetch can. Exported so
 * tests can exercise the exact function `--watch` polls without driving the live loop itself.
 */
export async function deploymentsListFrame(
  org: string | undefined,
  resolved: { serviceUrl: string; token?: string },
  common: CommonDeploymentsArgs,
  home: ConfigLocation,
): Promise<WatchFrame> {
  if (org !== undefined && resolved.token !== undefined) {
    try {
      const url = new URL(`${resolved.serviceUrl}/v1/orgs/${encodeURIComponent(org)}/deployments`);
      if (common.app !== undefined) url.searchParams.set('app', common.app);
      if (common.targetEnv !== undefined) url.searchParams.set('env', common.targetEnv);
      if (common.archived) url.searchParams.set('archived', 'true');
      const body = await serviceJson<DeploymentsListResponse>(url.toString(), resolved.token);
      const table = renderDeploymentsTable(body.deployments, stdoutTableOptions());
      return {
        ok: true,
        frame: `${table}\n\n${body.deployments.length} deployment(s) from ${resolved.serviceUrl}.`,
      };
    } catch (error) {
      return { ok: false, error: serviceFailure('deployments', error, 'noodle doctor') };
    }
  }
  const servers = readServers(home);
  if (servers.length === 0) {
    return {
      ok: true,
      frame:
        'No saved servers. Deploy a linked project with `noodle deploy` to remember one locally.',
    };
  }
  const lines = servers.map((s) => `${s.deploymentId}\t${s.url}\t${s.createdAt}`);
  return {
    ok: true,
    frame: `${lines.join('\n')}\n\n${servers.length} server(s) cached in ~/.noodle/servers.json.`,
  };
}

async function runDeploymentsList(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const { common } = parseCommonDeploymentsArgs(rest);
  const { watch, intervalMs } = parseWatchFlags(rest);
  if (watch && common.json) {
    return printCliFailure(
      'deployments',
      watchJsonConflictFailure('noodle deployments list --json'),
      true,
    );
  }

  const target = resolveOrgTarget(common.org, home);
  const resolved = await resolveControlPlaneToken({
    serviceFlag: common.service ?? (target.ok ? target.serviceUrl : undefined),
    authFlag: common.authToken,
    env,
    home,
  });
  let org = target.ok ? target.org : undefined;
  if (org === undefined) {
    const picked = await pickOrgInteractively(
      resolved,
      common.json,
      (o) => `noodle deployments list --org ${o}`,
    );
    if (picked !== undefined) org = picked;
  }

  if (common.json) {
    if (org !== undefined && resolved.token !== undefined) {
      try {
        const url = new URL(
          `${resolved.serviceUrl}/v1/orgs/${encodeURIComponent(org)}/deployments`,
        );
        if (common.app !== undefined) url.searchParams.set('app', common.app);
        if (common.targetEnv !== undefined) url.searchParams.set('env', common.targetEnv);
        if (common.archived) url.searchParams.set('archived', 'true');
        const body = await serviceJson<DeploymentsListResponse>(url.toString(), resolved.token);
        printJsonOk({ deployments: body.deployments });
        return EXIT.OK;
      } catch (error) {
        return printCliFailure(
          'deployments',
          serviceFailure('deployments', error, 'noodle doctor'),
          true,
        );
      }
    }
    // No resolvable org+token (the common no-login case): fall back to the local saved-servers
    // cache, unchanged from the legacy `noodle list` behavior.
    const servers = readServers(home);
    printJsonOk({ target: { runtime: 'local' }, deployments: servers });
    return EXIT.OK;
  }

  if (watch) {
    return runWatch({
      command: 'deployments',
      intervalMs,
      render: () => deploymentsListFrame(org, resolved, common, home),
    });
  }

  const result = await deploymentsListFrame(org, resolved, common, home);
  if (!result.ok) return printCliFailure('deployments', result.error, false);
  console.log(result.frame);
  return EXIT.OK;
}

// --- inspect ---------------------------------------------------------------------

async function runDeploymentsInspect(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const { common, positional } = parseCommonDeploymentsArgs(rest);
  const deploymentId = positional[0];
  if (deploymentId === undefined) {
    return printCommandUsageFailure(
      'deployments',
      'noodle deployments inspect requires a deployment id',
      'noodle deployments inspect <deployment-id> --json',
      common.json,
    );
  }
  const target = resolveOrgTarget(common.org, home);
  if (!target.ok) return printCliFailure('deployments', target.error, common.json);
  const resolved = await resolveControlPlaneToken({
    serviceFlag: common.service ?? target.serviceUrl,
    authFlag: common.authToken,
    env,
    home,
  });
  if (resolved.token === undefined)
    return printCliFailure('deployments', authRequired(), common.json);
  try {
    const url =
      `${resolved.serviceUrl}/v1/orgs/${encodeURIComponent(target.org)}` +
      `/deployments/${encodeURIComponent(deploymentId)}`;
    const body = await serviceJson<DeploymentResponse>(url, resolved.token);
    if (common.json) {
      printJsonOk(body.data);
      return EXIT.OK;
    }
    printDeploymentDetail(target.org, body.data);
    return EXIT.OK;
  } catch (error) {
    if (error instanceof ServiceRequestError && error.status === 404) {
      return printCliFailure(
        'deployments',
        notFoundDeployment(target.org, deploymentId),
        common.json,
      );
    }
    return printCliFailure(
      'deployments',
      serviceFailure('deployments', error, 'noodle deployments list'),
      common.json,
    );
  }
}

function deploymentStatusLine(deployment: DeploymentSummary): string {
  if (deployment.archivedAt !== undefined) return `archived ${deployment.archivedAt}`;
  return deployment.active ? 'active' : 'inactive';
}

function printDeploymentDetail(org: string, deployment: DeploymentSummary): void {
  console.log(`deployment: ${deployment.deploymentId}`);
  console.log(`org:        ${org}`);
  console.log(`app:        ${deployment.appSlug}`);
  console.log(`env:        ${deployment.environment}`);
  console.log(`status:     ${deploymentStatusLine(deployment)}`);
  console.log(`access:     ${deployment.accessMode}`);
  if (deployment.ownerSubject !== undefined) console.log(`owner:      ${deployment.ownerSubject}`);
  console.log(`version:    ${deployment.serverVersion ?? '—'}`);
  console.log(`locked:     ${deployment.deploymentLock === undefined ? 'no' : 'yes'}`);
  if (deployment.deploymentLock?.lockedByEmail !== undefined) {
    console.log(`lockedBy:   ${deployment.deploymentLock.lockedByEmail}`);
  }
  console.log(`server:     ${deployment.serverName}`);
  console.log(`createdBy:  ${deployment.createdByEmail ?? '—'}`);
  console.log(`created:    ${deployment.createdAt}`);
}

// --- table rendering -----------------------------------------------------------

const DEPLOYMENTS_COLUMNS: readonly Column<DeploymentSummary>[] = [
  // Full deploymentId (not a shortened form): it's what users copy verbatim for
  // `noodle rollback <deploymentId>`. A separate APP column is redundant with `--app`/`--env`
  // filters for scoping, so it's dropped here (unlike the `apps`/`envs` tables).
  { header: 'DEPLOYMENT', get: (d) => d.deploymentId },
  { header: 'ENV', get: (d) => d.environment },
  { header: 'VERSION', get: (d) => d.serverVersion ?? '—' },
  {
    header: 'STATUS',
    get: (d) => (d.archivedAt !== undefined ? 'archived' : d.active ? 'active' : 'inactive'),
    color: (d) =>
      d.archivedAt !== undefined ? ARCHIVED_AMBER : d.active ? ACTIVE_GREEN : DIM_GRAY,
  },
  {
    header: 'ACCESS',
    get: (d) => d.accessMode,
    color: (d) => ACCESS_CHIP_COLORS[d.accessMode],
  },
  {
    header: 'LOCK',
    get: (d) => (d.deploymentLock === undefined ? 'unlocked' : 'locked'),
    color: (d) => (d.deploymentLock === undefined ? DIM_GRAY : ARCHIVED_AMBER),
  },
  {
    header: 'CREATED',
    get: (d) => relativeTime(d.createdAt),
    align: 'right',
  },
];

/** Render the `deployments list` table. Exported so tests (and the contract drift gate) can call it directly. */
export function renderDeploymentsTable(
  deployments: readonly DeploymentSummary[],
  opts: TableOptions,
): string {
  return renderTable(DEPLOYMENTS_COLUMNS, deployments, opts);
}
