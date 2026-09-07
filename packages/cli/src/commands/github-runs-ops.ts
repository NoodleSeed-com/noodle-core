import type { DeployRun, GithubRunsListResponse } from '@noodle-borg/wire-contracts';
import type { ConfigLocation } from '../config.js';
import { resolveControlPlaneToken, ServiceRequestError, serviceJson } from '../control-plane.js';
import { ORANGE, type RGB } from '../gradient.js';
import { relativeTime } from '../relative-time.js';
import type { Column, TableOptions } from '../table.js';
import { renderTable } from '../table.js';
import { parseWatchFlags, runWatch, type WatchFrame, watchJsonConflictFailure } from '../watch.js';
import {
  authRequired,
  parseGithubArgs,
  resolveGithubTarget,
  serviceErrorFailure,
} from './github-shared.js';
import { EXIT, printJsonOk } from './output.js';
import {
  ACTIVE_GREEN,
  ARCHIVED_AMBER,
  DIM_GRAY,
  notFoundApp,
  stdoutTableOptions,
} from './resource-shared.js';
import { printCliFailure } from './shared.js';

/**
 * `noodle github runs [--org --app --limit N --json --watch]` (GHD-2): the deploy-runs feed behind
 * `GET /v1/orgs/{org}/apps/{app}/github/runs`. Pulled forward from GHD-4.4 so Phase 2 is observable
 * the moment webhook intake lands — a queued/blocked run is visible here (and in the console feed)
 * even though nothing builds it until GHD-3. Split from `github-ops.ts` for the size gate.
 */

export type { DeployRun };

const ROSE_RED: RGB = [244, 63, 94];
const IN_FLIGHT_ORANGE: RGB = ORANGE;

const STATUS_COLORS: Record<DeployRun['status'], RGB | undefined> = {
  queued: ARCHIVED_AMBER,
  building: IN_FLIGHT_ORANGE,
  deploying: IN_FLIGHT_ORANGE,
  deployed: ACTIVE_GREEN,
  failed: ROSE_RED,
  canceled: DIM_GRAY,
  superseded: DIM_GRAY,
};

function statusText(run: DeployRun): string {
  if (run.blockedReason === 'fork_pending_approval') return `${run.status} (fork)`;
  if (run.blockedReason !== undefined) return `${run.status} (blocked)`;
  return run.status;
}

const RUNS_COLUMNS: readonly Column<DeployRun>[] = [
  { header: 'RUN', get: (r) => r.runId, maxWidth: 16 },
  { header: 'EVENT', get: (r) => (r.sourceEvent === 'push' ? 'push' : `PR #${r.prNumber ?? '?'}`) },
  { header: 'COMMIT', get: (r) => r.commitSha.slice(0, 7) },
  { header: 'ENV', get: (r) => r.envName },
  {
    header: 'STATUS',
    get: statusText,
    color: (r) => STATUS_COLORS[r.status],
  },
  {
    header: 'AGE',
    get: (r) => relativeTime(r.createdAt),
    align: 'right',
    color: () => DIM_GRAY,
  },
];

/** Render the `github runs` table. Exported for tests and the contract drift gate. */
export function renderRunsTable(runs: readonly DeployRun[], opts: TableOptions): string {
  return renderTable(RUNS_COLUMNS, runs, opts);
}

function parseLimit(rest: readonly string[]): number | undefined {
  const at = rest.indexOf('--limit');
  if (at === -1) return undefined;
  const value = Number(rest[at + 1]);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function runsUrl(serviceUrl: string, org: string, app: string, limit: number | undefined): string {
  const url = new URL(
    `${serviceUrl}/v1/orgs/${encodeURIComponent(org)}/apps/${encodeURIComponent(app)}/github/runs`,
  );
  if (limit !== undefined) url.searchParams.set('limit', String(limit));
  return url.toString();
}

async function runsListFrame(
  serviceUrl: string,
  token: string,
  org: string,
  app: string,
  limit: number | undefined,
): Promise<WatchFrame> {
  try {
    const body = await serviceJson<GithubRunsListResponse>(
      runsUrl(serviceUrl, org, app, limit),
      token,
    );
    if (body.data.runs.length === 0) {
      return {
        ok: true,
        frame:
          `No deploy runs for ${org}/${app} yet.\n` +
          'Push to the connected repository — or connect one: noodle github connect',
      };
    }
    const table = renderRunsTable(body.data.runs, stdoutTableOptions());
    const truncatedNote = body.data.truncated
      ? '\n(older runs not shown — raise --limit to see more)'
      : '';
    return { ok: true, frame: `${table}${truncatedNote}` };
  } catch (error) {
    if (error instanceof ServiceRequestError && error.status === 404) {
      return { ok: false, error: notFoundApp(org, app) };
    }
    return { ok: false, error: serviceErrorFailure('noodle github runs', error) };
  }
}

export async function runGithubRuns(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const args = parseGithubArgs(rest);
  const json = args.json;
  const { watch, intervalMs } = parseWatchFlags(rest);
  if (watch && json) {
    return printCliFailure('github', watchJsonConflictFailure('noodle github runs --json'), true);
  }
  const limit = parseLimit(rest);

  const resolved = resolveGithubTarget(args, home);
  if (!resolved.ok) return printCliFailure('github', resolved.error, json);
  const { org, app } = resolved.target;

  const tokenResolution = await resolveControlPlaneToken({
    serviceFlag: args.service ?? resolved.target.serviceUrl,
    authFlag: args.authToken,
    env,
    home,
  });
  if (tokenResolution.token === undefined) return printCliFailure('github', authRequired(), json);
  const { serviceUrl, token } = tokenResolution;

  if (json) {
    try {
      const body = await serviceJson<GithubRunsListResponse>(
        runsUrl(serviceUrl, org, app, limit),
        token,
      );
      printJsonOk(body.data);
      return EXIT.OK;
    } catch (error) {
      if (error instanceof ServiceRequestError && error.status === 404) {
        return printCliFailure('github', notFoundApp(org, app), true);
      }
      return printCliFailure('github', serviceErrorFailure('noodle github runs', error), true);
    }
  }

  if (watch) {
    return runWatch({
      command: 'github runs',
      intervalMs,
      render: () => runsListFrame(serviceUrl, token, org, app, limit),
    });
  }

  const result = await runsListFrame(serviceUrl, token, org, app, limit);
  if (!result.ok) return printCliFailure('github', result.error, false);
  console.log(result.frame);
  return EXIT.OK;
}
