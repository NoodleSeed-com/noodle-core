import { homedir } from 'node:os';
import type { ConfigLocation } from '../config.js';
import { resolveControlPlaneToken, serviceJson } from '../control-plane.js';
import { printJsonOk, printJsonStreamEvent, printJsonStreamSnapshot } from './output.js';
import {
  parseCommandFlags,
  parseTenantCommandArgs,
  printCliFailure,
  resolveTenantTarget,
  serviceFailure,
} from './shared.js';

interface LogEvent {
  readonly id?: string;
  readonly createdAt?: string;
  readonly level?: string;
  readonly message?: string;
  readonly app?: string;
  readonly env?: string;
  readonly deploymentId?: string;
  readonly truncated?: boolean;
  readonly details?: Record<string, string | number | boolean>;
}

interface LogsResponse {
  readonly ok: true;
  readonly events: readonly LogEvent[];
}

const DEFAULT_INTERVAL_MS = 2000;

/**
 * `noodle logs` — read the tenant-safe developer log surface (M3, ADR 0101). One-shot by default; `--follow`
 * (alias `--tail`) polls the same endpoint and prints new records. Records are tenant-scoped and structurally
 * redacted by the service; the CLI is a thin reader over `GET .../logs`.
 */
export async function runLogs(
  rest: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  home: ConfigLocation = homedir(),
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<number> {
  const args = parseTenantCommandArgs(rest);
  const flags = parseCommandFlags(rest, {
    values: {
      '--limit': 'limit',
      '--level': 'level',
      '--search': 'search',
      '--since': 'since',
      '--until': 'until',
      '--interval': 'interval',
      '--max-polls': 'maxPolls',
    },
    booleans: { '--follow': 'follow', '--tail': 'follow' },
  });
  const { limit, level, search, since, until, follow } = flags;
  let intervalMs = DEFAULT_INTERVAL_MS;
  const seconds = Number(flags.interval);
  if (Number.isFinite(seconds) && seconds > 0) intervalMs = Math.max(500, seconds * 1000);
  const maxPolls = flags.maxPolls === undefined ? Number.POSITIVE_INFINITY : Number(flags.maxPolls);

  const target = resolveTenantTarget(args, home);
  if (!target.ok) return printCliFailure('logs', target.error, args.json);
  const resolved = await resolveControlPlaneToken({
    serviceFlag: args.service ?? target.serviceUrl,
    authFlag: args.authToken,
    env,
    home,
  });
  if (resolved.token === undefined) {
    return printCliFailure(
      'logs',
      {
        code: 'auth_required',
        message: 'No control-plane login token is available.',
        cause: 'Hosted logs require an authenticated Noodle Seed Cloud identity.',
        fix: 'Sign in to the target service.',
        next: 'noodle login',
        exitCode: 3,
      },
      args.json,
    );
  }

  const url = new URL(
    `${resolved.serviceUrl}/v1/orgs/${encodeURIComponent(target.org)}` +
      `/apps/${encodeURIComponent(target.app)}/envs/${encodeURIComponent(target.env)}/logs`,
  );
  if (limit !== undefined) url.searchParams.set('limit', limit);
  if (level !== undefined) url.searchParams.set('level', level);
  if (search !== undefined) url.searchParams.set('search', search);
  if (since !== undefined) url.searchParams.set('since', since);
  if (until !== undefined) url.searchParams.set('until', until);

  try {
    const body = await serviceJson<LogsResponse>(url.toString(), resolved.token);
    if (args.json) {
      if (follow) printJsonStreamSnapshot({ ...body, service: resolved.serviceUrl });
      else printJsonOk({ ...body, service: resolved.serviceUrl });
    } else if (body.events.length === 0) {
      console.log('No logs found.');
    } else {
      // The store returns newest-first; print oldest-first so a terminal reads top-to-bottom.
      for (const event of [...body.events].reverse()) printLog(event);
    }
    if (!follow) return 0;

    const seen = new Set(
      body.events.map((e) => e.id).filter((id): id is string => id !== undefined),
    );
    let polls = 0;
    while (polls < maxPolls) {
      polls += 1;
      await sleep(intervalMs);
      const next = await serviceJson<LogsResponse>(url.toString(), resolved.token);
      const fresh = [...next.events].reverse().filter((e) => e.id === undefined || !seen.has(e.id));
      for (const event of fresh) {
        if (event.id !== undefined) seen.add(event.id);
        if (args.json) printJsonStreamEvent(event);
        else printLog(event);
      }
    }
    return 0;
  } catch (error) {
    return printCliFailure(
      'logs',
      serviceFailure('logs', error, 'noodle logs --org <org> --app <app> [--env <env>] [--follow]'),
      args.json,
    );
  }
}

function printLog(event: LogEvent): void {
  const when = event.createdAt ?? '';
  const level = (event.level ?? 'info').toUpperCase().padEnd(5);
  const where = [event.app, event.env].filter((p) => p !== undefined).join('/');
  const suffix = event.truncated ? ' (truncated)' : '';
  console.log(`${when} ${level} ${where} ${event.message ?? ''}${suffix}`.trim());
}
