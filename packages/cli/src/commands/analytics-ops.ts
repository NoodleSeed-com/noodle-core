import { homedir } from 'node:os';
import type { ConfigLocation } from '../config.js';
import { resolveControlPlaneToken, serviceJson } from '../control-plane.js';
import { detectColorMode, detectGlyphMode } from '../gradient.js';
import {
  attentionTools,
  type EventRecord,
  type MetricsData,
  renderEventRow,
  renderEventsHeader,
  renderEventsSummary,
  renderLiveFooter,
  renderMetricsReport,
} from '../metrics-render.js';
import {
  EXIT,
  printJsonFailure,
  printJsonOk,
  printJsonStreamEvent,
  printJsonStreamSnapshot,
  printRawJsonForHumanDebug,
} from './output.js';
import type { EnvsListResponse } from './resource-shared.js';
import {
  parseCommandFlags,
  parseTenantCommandArgs,
  printCliFailure,
  resolveTenantTarget,
  serviceFailure,
} from './shared.js';

/**
 * `noodle metrics` + `noodle events` — the tenant analytics read surface (ADR 0121 Stage B). Thin
 * authenticated readers over `GET .../metrics`, `.../events`, and `.../sessions/{id}`; records are
 * tenant-scoped and scalar-only by construction. Branded rendering lands with the analytics renderer;
 * this module owns fetching, flags, and the JSON/plain contract.
 */

interface MetricsResponse {
  readonly ok: true;
  readonly window: { readonly since: string; readonly until?: string };
  readonly metrics: MetricsData;
}

interface EventsResponse {
  readonly ok: true;
  readonly events: readonly EventRecord[];
}

// A Map, not a Record: the key comes from --window, and a Record lookup would walk the prototype
// chain (`--window toString` would resolve to a function instead of undefined).
const WINDOW_LABELS = new Map<string, string>([
  ['24h', 'last 24 hours'],
  ['7d', 'last 7 days'],
  ['30d', 'last 30 days'],
]);
const DEFAULT_TAIL_INTERVAL_MS = 2000;
/** A persistent failure (revoked token, dead service) must stop the tail, not spin it silently. */
const MAX_CONSECUTIVE_TAIL_FAILURES = 5;

/** Render options for the current stdout (plain under pipes/CI/NO_COLOR; callers gate --json). */
function renderOptions(): {
  color: ReturnType<typeof detectColorMode>;
  glyph: ReturnType<typeof detectGlyphMode>;
} {
  return { color: detectColorMode(process.stdout), glyph: detectGlyphMode() };
}

export async function runMetrics(
  rest: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  home: ConfigLocation = homedir(),
): Promise<number> {
  const args = parseTenantCommandArgs(rest);
  const { windowParam, since, until, agentOutput } = parseCommandFlags(rest, {
    values: { '--window': 'windowParam', '--since': 'since', '--until': 'until' },
    booleans: { '--agent-output': 'agentOutput', '--fix-prompt': 'agentOutput' },
  });
  if (windowParam !== undefined && !WINDOW_LABELS.has(windowParam)) {
    return printCliFailure(
      'metrics',
      {
        code: 'invalid_window',
        message: `unsupported --window "${windowParam}"`,
        cause: 'Metrics windows are presets over the analytics stream.',
        fix: 'Use one of 24h, 7d, 30d, or pass --since/--until ISO timestamps.',
        next: 'noodle metrics --window 7d',
        exitCode: 2,
      },
      args.json,
    );
  }

  const resolved = await resolveAnalyticsTarget('metrics', args, env, home, {
    defaultToProduction: true,
  });
  if (typeof resolved === 'number') return resolved;

  const url = new URL(`${resolved.base}/metrics`);
  if (windowParam !== undefined) url.searchParams.set('window', windowParam);
  if (since !== undefined) url.searchParams.set('since', since);
  if (until !== undefined) url.searchParams.set('until', until);

  try {
    const body = await serviceJson<MetricsResponse>(url.toString(), resolved.token);
    const windowLabel =
      since !== undefined
        ? `since ${since}`
        : (WINDOW_LABELS.get(windowParam ?? '7d') ?? 'last 7 days');
    if (args.json) {
      printJsonOk({ ...body, service: resolved.serviceUrl });
      return 0;
    }
    if (agentOutput) {
      printRawJsonForHumanDebug(agentMetricsSummary(body.metrics, windowLabel));
      return 0;
    }
    const context = { org: resolved.org, app: resolved.app, env: resolved.env, windowLabel };
    for (const line of renderMetricsReport(context, body.metrics, renderOptions())) {
      console.log(line);
    }
    return 0;
  } catch (error) {
    return printCliFailure(
      'metrics',
      serviceFailure('metrics', error, 'noodle metrics --org <org> --app <app> [--window 7d]'),
      args.json,
    );
  }
}

export async function runEvents(
  rest: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  home: ConfigLocation = homedir(),
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<number> {
  const args = parseTenantCommandArgs(rest);
  const flags = parseCommandFlags(rest, {
    values: {
      '--status': 'status',
      '--tool': 'tool',
      '--client': 'client',
      '--session': 'session',
      '--limit': 'limit',
      '--interval': 'interval',
      '--max-polls': 'maxPolls',
    },
    booleans: { '--tail': 'tail', '--follow': 'tail' },
  });
  const { status, tool, client, session, limit, tail } = flags;
  let intervalMs = DEFAULT_TAIL_INTERVAL_MS;
  let maxPolls = Number.POSITIVE_INFINITY;
  const seconds = Number(flags.interval);
  if (Number.isFinite(seconds) && seconds > 0) intervalMs = Math.max(500, seconds * 1000);
  if (flags.maxPolls !== undefined) {
    // Unlike --interval (a pacing knob with a safe finite default), a malformed bound would
    // silently invert the caller's intent into an unbounded tail — fail closed instead.
    const parsed = Number(flags.maxPolls);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      if (args.json) {
        return printJsonFailure(
          {
            code: 'invalid_max_polls',
            message: 'events: --max-polls must be a positive number',
            fix: 'Pass a positive numeric poll count.',
            next: 'noodle events --tail --max-polls <count> --json',
          },
          EXIT.USAGE,
        );
      }
      console.error('events: --max-polls must be a positive number');
      return EXIT.USAGE;
    }
    maxPolls = parsed;
  }

  const resolved = await resolveAnalyticsTarget('events', args, env, home, {
    defaultToProduction: true,
  });
  if (typeof resolved === 'number') return resolved;

  const url =
    session !== undefined
      ? new URL(`${resolved.base}/sessions/${encodeURIComponent(session)}`)
      : new URL(`${resolved.base}/events`);
  if (session === undefined) {
    if (status !== undefined) url.searchParams.set('status', status);
    if (tool !== undefined) url.searchParams.set('tool', tool);
    if (client !== undefined) url.searchParams.set('client', client);
    if (limit !== undefined) url.searchParams.set('limit', limit);
  }

  try {
    const opts = renderOptions();
    const body = await serviceJson<EventsResponse>(url.toString(), resolved.token);
    if (args.json) {
      if (tail) {
        printJsonStreamSnapshot({ ...body, service: resolved.serviceUrl });
      } else {
        printJsonOk({ ...body, service: resolved.serviceUrl });
      }
    } else if (body.events.length === 0) {
      console.log('No events yet — traffic appears here as AI clients call this server.');
    } else {
      // The events route returns newest-first; print oldest-first so a terminal reads down.
      const rows = session !== undefined ? body.events : [...body.events].reverse();
      console.log(renderEventsHeader(opts));
      for (const event of rows) console.log(renderEventRow(event, opts));
      const counts = {
        ok: rows.filter((e) => (e.outcome ?? 'ok') === 'ok').length,
        toolErrors: rows.filter((e) => e.outcome === 'tool_error').length,
        mcpErrors: rows.filter((e) => e.outcome === 'mcp_error').length,
      };
      console.log('');
      console.log(renderEventsSummary(counts, opts));
    }
    if (!tail || session !== undefined) return 0;
    if (!args.json) {
      console.log('');
      console.log(renderLiveFooter(`${resolved.org}/${resolved.app} · ${resolved.env}`, opts));
    }

    const seen = new Set(
      body.events.map((e) => e.id).filter((id): id is string => id !== undefined),
    );
    let polls = 0;
    let consecutiveFailures = 0;
    while (polls < maxPolls) {
      polls += 1;
      await sleep(intervalMs);
      let next: EventsResponse;
      try {
        next = await serviceJson<EventsResponse>(url.toString(), resolved.token);
        consecutiveFailures = 0;
      } catch (error) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= MAX_CONSECUTIVE_TAIL_FAILURES) {
          return printCliFailure(
            'events',
            {
              ...serviceFailure('events', error, 'noodle events --json'),
              exitCode: EXIT.FAILURE,
            },
            args.json,
          );
        }
        continue; // a transient poll failure skips one cycle; the tail keeps following
      }
      const fresh = [...next.events].reverse().filter((e) => e.id === undefined || !seen.has(e.id));
      for (const event of fresh) {
        if (event.id !== undefined) seen.add(event.id);
        // Streaming tail: one envelope per line so a consumer can parse each event independently.
        if (args.json) printJsonStreamEvent(event);
        else console.log(renderEventRow(event, opts));
      }
    }
    return 0;
  } catch (error) {
    return printCliFailure(
      'events',
      serviceFailure(
        'events',
        error,
        'noodle events --org <org> --app <app> [--status tool_error|mcp_error] [--tail]',
      ),
      args.json,
    );
  }
}

/**
 * Resolve tenant target + auth token; prints the failure and returns an exit code on error.
 * Exported for the sibling analytics-family commands (`alerts-ops.ts`).
 */
export async function resolveAnalyticsTarget(
  command: string,
  args: ReturnType<typeof parseTenantCommandArgs>,
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
  options: { readonly defaultToProduction?: boolean } = {},
): Promise<
  | number
  | { base: string; token: string; serviceUrl: string; org: string; app: string; env: string }
> {
  const target = resolveTenantTarget(args, home);
  if (!target.ok) return printCliFailure(command, target.error, args.json);
  const resolved = await resolveControlPlaneToken({
    serviceFlag: args.service ?? target.serviceUrl,
    authFlag: args.authToken,
    env,
    home,
  });
  if (resolved.token === undefined) {
    return printCliFailure(
      command,
      {
        code: 'auth_required',
        message: 'No control-plane login token is available.',
        cause: 'Hosted analytics require an authenticated Noodle Seed Cloud identity.',
        fix: 'Sign in to the target service.',
        next: 'noodle login',
        exitCode: 3,
      },
      args.json,
    );
  }
  let analyticsEnv = args.targetEnv ?? (options.defaultToProduction ? undefined : target.env);
  if (analyticsEnv === undefined) {
    try {
      const envsUrl =
        `${resolved.serviceUrl}/v1/orgs/${encodeURIComponent(target.org)}` +
        `/apps/${encodeURIComponent(target.app)}/envs`;
      const body = await serviceJson<EnvsListResponse>(envsUrl, resolved.token);
      analyticsEnv = body.data.envs.find((candidate) => candidate.isProduction)?.envName;
    } catch (error) {
      return printCliFailure(
        command,
        serviceFailure(command, error, `noodle envs list --org ${target.org} --app ${target.app}`),
        args.json,
      );
    }
    if (analyticsEnv === undefined) {
      return printCliFailure(
        command,
        {
          code: 'production_environment_required',
          message: `No production environment is designated for ${target.org}/${target.app}.`,
          cause: 'Analytics defaults require one explicit production environment.',
          fix: 'Choose the environment that represents production for this app.',
          next: `noodle envs set-production <env> --org ${target.org} --app ${target.app}`,
          exitCode: 2,
        },
        args.json,
      );
    }
  }
  const base =
    `${resolved.serviceUrl}/v1/orgs/${encodeURIComponent(target.org)}` +
    `/apps/${encodeURIComponent(target.app)}/envs/${encodeURIComponent(analyticsEnv)}`;
  return {
    base,
    token: resolved.token,
    serviceUrl: resolved.serviceUrl,
    org: target.org,
    app: target.app,
    env: analyticsEnv,
  };
}

/**
 * Distilled `--agent-output` summary: a health verdict, one-line summary, and attention items each
 * carrying the exact next command — so a coding agent branches on `health` instead of re-deriving
 * "what matters" from the full metrics payload. Attention uses the same bar as the report's nudge
 * line ({@link attentionTools}), keeping the human and agent surfaces in agreement.
 */
function agentMetricsSummary(metrics: MetricsData, windowLabel: string): Record<string, unknown> {
  const attention = attentionTools(metrics).map((tool) => ({
    tool: tool.tool,
    errorShare: Number((tool.errors / tool.calls).toFixed(4)),
    issue: `${tool.errors} of ${tool.calls} calls errored`,
    action: `noodle events --tool ${tool.tool} --json`,
  }));
  const { totals, errors, latency, tokens } = metrics;
  return {
    ok: true,
    health: attention.length > 0 ? 'attention' : 'ok',
    window: windowLabel,
    summary:
      `${totals.requests} requests · ${totals.toolCalls} tool calls · ` +
      `${(errors.errorRate * 100).toFixed(1)}% errors · p95 ${Math.round(latency.p95Ms)}ms`,
    attention,
    key: {
      requests: totals.requests,
      toolCalls: totals.toolCalls,
      legacyInitializations: totals.legacyInitializations ?? totals.sessions,
      errorRate: errors.errorRate,
      toolErrorRate: errors.toolErrorRate,
      mcpErrorRate: errors.mcpErrorRate,
      p50Ms: latency.p50Ms,
      p95Ms: latency.p95Ms,
      p99Ms: latency.p99Ms,
      outputTokensAvgPerCall: tokens.avgPerCall,
    },
  };
}
