/**
 * Operator-only knowledge surface (ADR 0202, amendment 2026-08-18): `noodle knowledge list`,
 * `noodle knowledge status <name>`, and `noodle knowledge refresh <name>` (on-demand crawl) —
 * no init, no sync, no publish; ordinary `noodle deploy` is the only publication path. Output
 * distinguishes "versioned documents" from "crawled sites" so operators see which lifecycle
 * rolls back, and renders the crawl state that owns site freshness.
 */
import type {
  KnowledgeCrawlState,
  KnowledgeListResponse,
  KnowledgeRefreshResponse,
  KnowledgeStatusResponse,
} from '@noodle-borg/wire-contracts';
import type { ConfigLocation } from '../config.js';
import { resolveControlPlaneToken, ServiceRequestError, serviceJson } from '../control-plane.js';
import { renderTable } from '../table.js';
import { EXIT, printJsonOk } from './output.js';
import { stdoutTableOptions } from './resource-shared.js';
import {
  type CliFailure,
  parseTenantCommandArgs,
  printCliFailure,
  resolveTenantTarget,
} from './shared.js';

export interface KnowledgeCommandOptions {
  /** Test seam; production uses global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Test seams; production polls every 5s within a 5-minute budget. */
  readonly refreshPollIntervalMs?: number;
  readonly refreshPollBudgetMs?: number;
}

/**
 * The refresh route crawls synchronously (on request-billed Cloud Run the held request is what
 * keeps the crawl at full CPU), so the client allows a crawl-sized window instead of the default
 * request timeout; the service's own request cap still governs.
 */
const REFRESH_TIMEOUT_MS = 6 * 60 * 1000;
const REFRESH_POLL_INTERVAL_MS = 5_000;
const REFRESH_POLL_BUDGET_MS = 5 * 60 * 1000;

function usageFailure(message: string): CliFailure {
  return {
    code: 'usage',
    message,
    cause: 'The knowledge surface has three verbs: list, status, and refresh.',
    fix: 'Use noodle knowledge list, status <name>, or refresh <name>.',
    next: 'noodle knowledge list',
    exitCode: EXIT.USAGE,
  };
}

function serviceFailure(
  error: unknown,
  target: { org: string; app: string; env: string },
): CliFailure {
  if (error instanceof ServiceRequestError) {
    const gated = error.code === 'knowledge_not_enabled';
    const enable =
      `noodle variables set NOODLE_KNOWLEDGE_ENABLED --value true --runtime cloud ` +
      `--scope env --org ${target.org} --app ${target.app} --env ${target.env}`;
    return {
      code: error.code ?? 'service_error',
      message: error.message,
      cause: `The service responded with HTTP ${error.status}.`,
      fix: gated ? enable : 'Check the target org/app/env and your access.',
      next: gated ? enable : 'noodle knowledge list',
      exitCode: error.status === 403 ? EXIT.FAILURE : EXIT.UNREACHABLE,
    };
  }
  return {
    code: 'service_unreachable',
    message: (error as Error).message,
    cause: 'The knowledge route could not be reached.',
    fix: 'Verify the service URL and connectivity.',
    next: 'noodle doctor',
    exitCode: EXIT.UNREACHABLE,
  };
}

type Row = KnowledgeListResponse['components'][number];

/** Poll the status route until the crawl is terminal; undefined when the budget expires first. */
async function pollCrawlState(
  statusUrl: string,
  token: string,
  fetchImpl: typeof fetch,
  intervalMs: number,
  budgetMs: number,
): Promise<KnowledgeCrawlState | undefined> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    let body: KnowledgeStatusResponse;
    try {
      body = await serviceJson<KnowledgeStatusResponse>(statusUrl, token, {}, fetchImpl);
    } catch {
      continue; // transient status failure — keep polling within the budget
    }
    const crawl = body.crawl;
    if (crawl !== undefined && crawl.status !== 'in_progress') return crawl;
  }
  return undefined;
}

function printCrawl(crawl: KnowledgeCrawlState): void {
  const completed =
    crawl.lastCompletedAt === undefined ? 'never' : new Date(crawl.lastCompletedAt).toISOString();
  const next =
    crawl.nextRefreshAt === undefined ? '-' : new Date(crawl.nextRefreshAt).toISOString();
  console.log(
    `  crawl: ${crawl.status}, ${crawl.pagesIndexed} pages, last completed ${completed}, next ${next}`,
  );
  if (crawl.lastError !== undefined) console.log(`  crawl error: ${crawl.lastError}`);
}

export async function runKnowledge(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
  options: KnowledgeCommandOptions = {},
): Promise<number> {
  const [action, ...remaining] = rest;
  const wantsComponent = action === 'status' || action === 'refresh';
  const componentName =
    wantsComponent && remaining[0] !== undefined && !remaining[0].startsWith('--')
      ? remaining[0]
      : undefined;
  const flagArgs = wantsComponent && componentName !== undefined ? remaining.slice(1) : remaining;
  const args = parseTenantCommandArgs(flagArgs);
  if (action !== 'list' && action !== 'status' && action !== 'refresh') {
    return printCliFailure(
      'knowledge',
      usageFailure(`unknown knowledge action "${action ?? ''}"`),
      args.json,
    );
  }
  if (wantsComponent && componentName === undefined) {
    return printCliFailure(
      'knowledge',
      usageFailure(`${action} requires a component name`),
      args.json,
    );
  }
  const target = resolveTenantTarget(args, home);
  if (!target.ok) return printCliFailure('knowledge', target.error, args.json);
  const resolved = await resolveControlPlaneToken({
    serviceFlag: args.service ?? target.serviceUrl,
    authFlag: args.authToken,
    env,
    home,
  });
  if (resolved.token === undefined) {
    return printCliFailure(
      'knowledge',
      {
        code: 'auth_required',
        message: 'No control-plane login token is available.',
        cause: 'The knowledge surface requires an authenticated operator.',
        fix: 'Sign in to the target service.',
        next: 'noodle login',
        exitCode: EXIT.AUTH,
      },
      args.json,
    );
  }
  const base =
    `${resolved.serviceUrl}/v1/orgs/${encodeURIComponent(target.org)}` +
    `/apps/${encodeURIComponent(target.app)}/envs/${encodeURIComponent(target.env)}/knowledge`;
  const fetchImpl = options.fetchImpl ?? fetch;

  try {
    if (action === 'list') {
      const body = await serviceJson<KnowledgeListResponse>(base, resolved.token, {}, fetchImpl);
      if (args.json) {
        printJsonOk(body);
        return 0;
      }
      console.log(`knowledge components for ${target.org}/${target.app}/${target.env}:`);
      console.log(
        renderTable(
          [
            { header: 'name', get: (row: Row) => row.name },
            {
              header: 'documents',
              get: (row: Row) => String(row.sources.documents),
              align: 'right' as const,
            },
            {
              header: 'sites',
              get: (row: Row) => String(row.sources.sites),
              align: 'right' as const,
            },
            { header: 'state', get: (row: Row) => row.state },
            { header: 'active revision', get: (row: Row) => row.activeRevisionId ?? '-' },
          ],
          [...body.components],
          stdoutTableOptions(),
        ),
      );
      return 0;
    }
    if (action === 'refresh') {
      let crawl: KnowledgeCrawlState;
      try {
        const body = await serviceJson<KnowledgeRefreshResponse>(
          `${base}/${encodeURIComponent(componentName ?? '')}/refresh`,
          resolved.token,
          { method: 'POST' },
          fetchImpl,
          { timeoutMs: REFRESH_TIMEOUT_MS },
        );
        crawl = body.crawl;
      } catch (error) {
        // A dropped connection is not a crawl outcome: the server-side crawl keeps running, so
        // fall back to polling status until it reaches a terminal state within the budget.
        if (!(error instanceof ServiceRequestError) || error.status !== 0) throw error;
        const polled = await pollCrawlState(
          `${base}/${encodeURIComponent(componentName ?? '')}/status`,
          resolved.token,
          fetchImpl,
          options.refreshPollIntervalMs ?? REFRESH_POLL_INTERVAL_MS,
          options.refreshPollBudgetMs ?? REFRESH_POLL_BUDGET_MS,
        );
        if (polled === undefined) {
          return printCliFailure(
            'knowledge',
            {
              code: 'crawl_still_running',
              message: `the crawl for "${componentName}" is still running`,
              cause: 'The crawl outlived the client wait window; it continues on the service.',
              fix: 'Check the crawl state until it reports completed or failed.',
              next: `noodle knowledge status ${componentName}`,
              exitCode: EXIT.FAILURE,
            },
            args.json,
          );
        }
        crawl = polled;
      }
      if (args.json) {
        printJsonOk({ ok: true, crawl });
        return crawl.status === 'completed' ? 0 : EXIT.FAILURE;
      }
      printCrawl(crawl);
      return crawl.status === 'completed' ? 0 : EXIT.FAILURE;
    }
    const body = await serviceJson<KnowledgeStatusResponse>(
      `${base}/${encodeURIComponent(componentName ?? '')}/status`,
      resolved.token,
      {},
      fetchImpl,
    );
    if (args.json) {
      printJsonOk(body);
      return 0;
    }
    const component = body.component;
    console.log(
      `knowledge component ${component.name} (${target.org}/${target.app}/${target.env})`,
    );
    console.log(`  state: ${component.state}`);
    console.log(
      `  versioned documents: ${component.sources.documents} (roll back with the deployment)`,
    );
    console.log(
      `  live sites: ${component.sources.sites} (provider-owned freshness; never rolls back)`,
    );
    console.log(`  active revision: ${component.activeRevisionId ?? '-'}`);
    console.log(`  declaring deployment: ${component.activeDeploymentId ?? '-'}`);
    if (body.siteProvisioning !== undefined) {
      console.log(`  site provisioning: ${body.siteProvisioning}`);
    }
    if (body.crawl !== undefined) printCrawl(body.crawl);
    if (body.budget !== undefined) {
      console.log(
        `  crawl budget: org ${body.budget.orgConsumed}/${body.budget.orgCeiling} pages, ` +
          `app ${body.budget.appConsumed}/${body.budget.appCeiling}` +
          (body.budget.blocked ? ' (blocked)' : ''),
      );
    }
    for (const error of body.errors) {
      console.log(`  error [${error.layer}]: ${error.message}`);
    }
    return 0;
  } catch (error) {
    return printCliFailure('knowledge', serviceFailure(error, target), args.json);
  }
}
