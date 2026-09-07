import { homedir } from 'node:os';
import type { ConfigLocation } from '../config.js';
import { serviceJson } from '../control-plane.js';
import { relativeTime } from '../relative-time.js';
import { type Column, renderTable } from '../table.js';
import { resolveAnalyticsTarget } from './analytics-ops.js';
import { EXIT, printJsonOk, printRawJsonForHumanDebug } from './output.js';
import { ACTIVE_GREEN, ARCHIVED_AMBER, DIM_GRAY, stdoutTableOptions } from './resource-shared.js';
import { parseTenantCommandArgs, printCliFailure, serviceFailure, usage } from './shared.js';

/**
 * `noodle alerts add|list|remove|test` — analytics alert rules with a webhook channel (E2,
 * ADR 0130). Thin authenticated operations over the tenant `.../alerts` routes, following the
 * `analytics-ops.ts` structure and the ADR 0129 output contract (JSON envelope, EXIT taxonomy,
 * branded table). The webhook URL is sensitive: it is sent once on `add` and the service only
 * ever returns the redacted origin — no output path here may print the full URL after that.
 */

const METRICS = new Set(['error_share', 'error_count', 'calls', 'p95_ms']);
const WINDOWS = new Set(['5', '15', '60']);

interface AlertRuleView {
  readonly id: string;
  readonly name?: string;
  readonly metric: string;
  readonly threshold: number;
  readonly windowMinutes: number;
  readonly comparison: string;
  readonly webhook: string;
  readonly enabled: boolean;
  readonly cooldownMinutes: number;
  readonly breaching: boolean;
  readonly lastObserved?: number;
  readonly lastFiredAt?: string;
  readonly createdAt: string;
}

interface AlertRuleResponse {
  readonly ok: true;
  readonly data: AlertRuleView;
}

interface AlertRulesListResponse {
  readonly ok: true;
  readonly data: { readonly rules: readonly AlertRuleView[] };
}

interface AlertTestResponse {
  readonly ok: true;
  readonly data: {
    readonly delivery: {
      readonly delivered: boolean;
      readonly status?: number;
      readonly reason?: string;
    };
  };
}

export async function runAlerts(
  rest: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  home: ConfigLocation = homedir(),
): Promise<number> {
  const [subcommand, ...tail] = rest;
  if (subcommand === 'add') return runAlertsAdd(tail, env, home);
  if (subcommand === 'list') return runAlertsList(tail, env, home);
  if (subcommand === 'remove') return runAlertsRemove(tail, env, home);
  if (subcommand === 'test') return runAlertsTest(tail, env, home);
  usage();
  return EXIT.USAGE;
}

function usageFailure(code: string, message: string, next: string, json: boolean): number {
  return printCliFailure(
    'alerts',
    {
      code,
      message,
      cause: 'Alert rules fire a webhook when an analytics metric crosses a threshold.',
      fix: 'Adjust the flags and retry.',
      next,
      exitCode: EXIT.USAGE,
    },
    json,
  );
}

async function runAlertsAdd(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const args = parseTenantCommandArgs(rest);
  let metric: string | undefined;
  let threshold: string | undefined;
  let window: string | undefined;
  let webhook: string | undefined;
  let name: string | undefined;
  let cooldown: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--metric') metric = rest[++i];
    else if (arg === '--threshold') threshold = rest[++i];
    else if (arg === '--window') window = rest[++i];
    else if (arg === '--webhook') webhook = rest[++i];
    else if (arg === '--name') name = rest[++i];
    else if (arg === '--cooldown') cooldown = rest[++i];
  }
  const next =
    'noodle alerts add --metric error_share --threshold 0.2 --window 15 --webhook <https-url>';
  if (metric === undefined || !METRICS.has(metric)) {
    return usageFailure(
      'invalid_metric',
      '--metric must be one of error_share, error_count, calls, p95_ms',
      next,
      args.json,
    );
  }
  const thresholdValue = threshold === undefined ? Number.NaN : Number(threshold);
  if (!Number.isFinite(thresholdValue) || thresholdValue < 0) {
    return usageFailure('invalid_threshold', '--threshold must be a number >= 0', next, args.json);
  }
  if (window === undefined || !WINDOWS.has(window)) {
    return usageFailure(
      'invalid_window',
      '--window must be 5, 15, or 60 (minutes)',
      next,
      args.json,
    );
  }
  if (webhook === undefined || webhook.length === 0) {
    return usageFailure('missing_webhook', '--webhook <https-url> is required', next, args.json);
  }
  const cooldownValue = cooldown === undefined ? undefined : Number(cooldown);
  if (cooldownValue !== undefined && (!Number.isInteger(cooldownValue) || cooldownValue < 1)) {
    return usageFailure(
      'invalid_cooldown',
      '--cooldown must be a positive integer number of minutes',
      next,
      args.json,
    );
  }

  const resolved = await resolveAnalyticsTarget('alerts', args, env, home);
  if (typeof resolved === 'number') return resolved;
  try {
    const body = await serviceJson<AlertRuleResponse>(`${resolved.base}/alerts`, resolved.token, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        metric,
        threshold: thresholdValue,
        windowMinutes: Number(window),
        webhookUrl: webhook,
        ...(name !== undefined ? { name } : {}),
        ...(cooldownValue !== undefined ? { cooldownMinutes: cooldownValue } : {}),
      }),
    });
    if (args.json) {
      printJsonOk(body.data);
      return EXIT.OK;
    }
    const rule = body.data;
    console.log(`Alert rule created: ${rule.id}`);
    console.log(
      `  ${rule.metric} >= ${rule.threshold} over ${rule.windowMinutes}m -> ${rule.webhook}`,
    );
    console.log(`  cooldown ${rule.cooldownMinutes}m - test it: noodle alerts test ${rule.id}`);
    return EXIT.OK;
  } catch (error) {
    return printCliFailure('alerts', serviceFailure('alerts', error, next), args.json);
  }
}

async function runAlertsList(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const args = parseTenantCommandArgs(rest);
  const agentOutput = rest.includes('--agent-output') || rest.includes('--fix-prompt');
  const resolved = await resolveAnalyticsTarget('alerts', args, env, home);
  if (typeof resolved === 'number') return resolved;
  try {
    const body = await serviceJson<AlertRulesListResponse>(
      `${resolved.base}/alerts`,
      resolved.token,
    );
    if (args.json) {
      printJsonOk(body.data);
      return EXIT.OK;
    }
    if (agentOutput) {
      printRawJsonForHumanDebug(agentAlertsSummary(body.data.rules));
      return EXIT.OK;
    }
    if (body.data.rules.length === 0) {
      console.log('No alert rules. Add one with `noodle alerts add`.');
      return EXIT.OK;
    }
    console.log(renderAlertsTable(body.data.rules));
    return EXIT.OK;
  } catch (error) {
    return printCliFailure(
      'alerts',
      serviceFailure('alerts', error, 'noodle alerts list --org <org> --app <app>'),
      args.json,
    );
  }
}

async function runAlertsRemove(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const args = parseTenantCommandArgs(rest);
  const id = positionalId(rest);
  if (id === undefined) {
    return usageFailure(
      'missing_id',
      'a rule id is required',
      'noodle alerts remove <id>',
      args.json,
    );
  }
  const resolved = await resolveAnalyticsTarget('alerts', args, env, home);
  if (typeof resolved === 'number') return resolved;
  try {
    const body = await serviceJson<{ ok: true; data: { deleted: boolean } }>(
      `${resolved.base}/alerts/${encodeURIComponent(id)}`,
      resolved.token,
      { method: 'DELETE' },
    );
    if (args.json) {
      printJsonOk(body.data);
      return EXIT.OK;
    }
    console.log('Alert rule removed.');
    return EXIT.OK;
  } catch (error) {
    return printCliFailure(
      'alerts',
      serviceFailure('alerts', error, 'noodle alerts list --org <org> --app <app>'),
      args.json,
    );
  }
}

async function runAlertsTest(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const args = parseTenantCommandArgs(rest);
  const id = positionalId(rest);
  if (id === undefined) {
    return usageFailure(
      'missing_id',
      'a rule id is required',
      'noodle alerts test <id>',
      args.json,
    );
  }
  const resolved = await resolveAnalyticsTarget('alerts', args, env, home);
  if (typeof resolved === 'number') return resolved;
  try {
    const body = await serviceJson<AlertTestResponse>(
      `${resolved.base}/alerts/${encodeURIComponent(id)}/test`,
      resolved.token,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    );
    const delivery = body.data.delivery;
    if (args.json) {
      printJsonOk(body.data);
      return delivery.delivered ? EXIT.OK : EXIT.FAILURE;
    }
    if (delivery.delivered) {
      console.log(`Test alert delivered (HTTP ${delivery.status ?? '?'}).`);
      return EXIT.OK;
    }
    console.log(
      `Test alert delivery failed (${delivery.reason ?? 'unknown'}${
        delivery.status !== undefined ? `, HTTP ${delivery.status}` : ''
      }).`,
    );
    return EXIT.FAILURE;
  } catch (error) {
    return printCliFailure(
      'alerts',
      serviceFailure('alerts', error, 'noodle alerts list --org <org> --app <app>'),
      args.json,
    );
  }
}

/** First non-flag token that is not a value of a known value-carrying flag. */
function positionalId(rest: readonly string[]): string | undefined {
  const valueFlags = new Set(['--org', '--app', '--env', '--service', '--auth-token', '--version']);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (valueFlags.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith('--')) continue;
    return arg;
  }
  return undefined;
}

const ALERT_COLUMNS: readonly Column<AlertRuleView>[] = [
  {
    header: 'RULE',
    get: (rule) => rule.name ?? rule.id.slice(0, 8),
    maxWidth: 24,
  },
  { header: 'METRIC', get: (rule) => rule.metric },
  { header: 'THRESHOLD', get: (rule) => String(rule.threshold), align: 'right' },
  { header: 'WINDOW', get: (rule) => `${rule.windowMinutes}m`, align: 'right' },
  {
    header: 'STATE',
    get: (rule) => (rule.enabled ? (rule.breaching ? 'breaching' : 'ok') : 'off'),
    color: (rule) => (rule.enabled ? (rule.breaching ? ARCHIVED_AMBER : ACTIVE_GREEN) : DIM_GRAY),
  },
  {
    header: 'LAST FIRED',
    get: (rule) => (rule.lastFiredAt !== undefined ? relativeTime(rule.lastFiredAt) : '—'),
    align: 'right',
  },
  { header: 'WEBHOOK', get: (rule) => rule.webhook, maxWidth: 32 },
];

function renderAlertsTable(rules: readonly AlertRuleView[]): string {
  return renderTable(ALERT_COLUMNS, rules, stdoutTableOptions());
}

/**
 * Distilled `--agent-output` verdict (mirrors `noodle metrics --agent-output`): a coding agent
 * branches on `health` and gets the exact breaching rules with their observations.
 */
function agentAlertsSummary(rules: readonly AlertRuleView[]): Record<string, unknown> {
  const breaching = rules
    .filter((rule) => rule.enabled && rule.breaching)
    .map((rule) => ({
      id: rule.id,
      ...(rule.name !== undefined ? { name: rule.name } : {}),
      metric: rule.metric,
      threshold: rule.threshold,
      ...(rule.lastObserved !== undefined ? { lastObserved: rule.lastObserved } : {}),
      ...(rule.lastFiredAt !== undefined ? { lastFiredAt: rule.lastFiredAt } : {}),
    }));
  return {
    ok: true,
    health: breaching.length > 0 ? 'attention' : 'ok',
    rules: rules.length,
    breaching,
  };
}
