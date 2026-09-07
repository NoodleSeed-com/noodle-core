import { homedir } from 'node:os';
import type { ConfigLocation } from '../config.js';
import { resolveControlPlaneToken, serviceJson } from '../control-plane.js';
import { ROSE } from '../gradient.js';
import { relativeTime } from '../relative-time.js';
import { type Column, renderTable, type TableOptions } from '../table.js';
import { EXIT, printJsonFailure, printJsonOk } from './output.js';
import { ACTIVE_GREEN, DIM_GRAY, stdoutTableOptions } from './resource-shared.js';
import { parseCommandFlags, printCliFailure, serviceFailure } from './shared.js';

interface ServiceCapabilitiesResponse {
  readonly ok: true;
  readonly capabilities: readonly string[];
  readonly modules?: readonly {
    readonly name: string;
    readonly capabilities: readonly string[];
  }[];
}

interface ServiceEventsResponse {
  readonly ok: true;
  readonly events: readonly {
    readonly id?: string;
    readonly eventType?: string;
    readonly org?: string;
    readonly app?: string;
    readonly env?: string;
    readonly actorEmail?: string;
    readonly actorSubject?: string;
    readonly createdAt?: string;
    readonly decision?: string;
    readonly reasonCode?: string;
    readonly status?: string;
    readonly details?: Record<string, string | number | boolean>;
  }[];
}

// --- table rendering ---------------------------------------------------------------

/** The audit-event fields the branded table renders (a subset of the wire event passthrough). */
export interface AuditEventRow {
  readonly eventType?: string;
  readonly actorEmail?: string;
  readonly actorSubject?: string;
  readonly createdAt?: string;
  readonly decision?: string;
}

const AUDIT_COLUMNS: readonly Column<AuditEventRow>[] = [
  {
    header: 'TIME',
    get: (e) => (e.createdAt !== undefined ? relativeTime(e.createdAt) : '—'),
    align: 'right',
  },
  { header: 'EVENT', get: (e) => e.eventType ?? '(event)' },
  {
    header: 'ACTOR',
    get: (e) => e.actorEmail ?? e.actorSubject ?? '(unknown actor)',
    color: () => DIM_GRAY,
  },
  {
    header: 'DECISION',
    get: (e) => e.decision ?? '—',
    color: (e) => (e.decision === 'allow' ? ACTIVE_GREEN : e.decision === 'deny' ? ROSE : DIM_GRAY),
  },
];

/** Render the `audit events` table (founder-approved design, 2026-07-06). Exported for tests. */
export function renderAuditEventsTable(
  events: readonly AuditEventRow[],
  opts: TableOptions,
): string {
  return renderTable(AUDIT_COLUMNS, events, opts);
}

export async function runAudit(
  rest: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  home: ConfigLocation = homedir(),
): Promise<number> {
  const [subcommand, ...tail] = rest;
  if (subcommand === 'status') return runAuditStatus(tail, env, home);
  if (subcommand === 'events') return runAuditEvents(tail, env, home);
  console.error('usage: noodle audit status|events [--service <url>] [--auth-token <t>] [--json]');
  return 2;
}

async function runAuditStatus(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const { serviceFlag, authFlag, json } = parseCommandFlags(rest, {
    values: { '--service': 'serviceFlag', '--auth-token': 'authFlag' },
    booleans: { '--json': 'json' },
  });

  const resolved = await resolveControlPlaneToken({
    serviceFlag,
    authFlag,
    env,
    home,
  });

  const url = `${resolved.serviceUrl}/v1/service/capabilities?advanced=1`;
  try {
    const body = await serviceJson<ServiceCapabilitiesResponse>(url, resolved.token);
    const hasAudit = body.capabilities.includes('audit');
    const auditModules = (body.modules ?? []).filter((m) => m.capabilities.includes('audit'));

    if (json) {
      printJsonOk({
        service: resolved.serviceUrl,
        enabled: hasAudit,
        status: hasAudit ? 'enabled' : 'disabled',
        modules: auditModules.map((m) => m.name),
      });
      return 0;
    }

    console.log(`service: ${resolved.serviceUrl}`);
    console.log(`audit: ${hasAudit ? 'enabled' : 'disabled'}`);
    if (auditModules.length > 0) {
      console.log(`module: ${auditModules.map((m) => m.name).join(', ')}`);
    } else if (hasAudit) {
      console.log('module: built-in/default');
    }
    return 0;
  } catch (error) {
    return printCliFailure(
      'audit status',
      serviceFailure('audit status', error, 'noodle audit status [--service <url>]'),
      json,
    );
  }
}

async function runAuditEvents(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const { serviceFlag, authFlag, org, app, envFlag, eventType, limit, json } = parseCommandFlags(
    rest,
    {
      values: {
        '--service': 'serviceFlag',
        '--auth-token': 'authFlag',
        '--org': 'org',
        '--app': 'app',
        '--env': 'envFlag',
        '--event-type': 'eventType',
        '--limit': 'limit',
      },
      booleans: { '--json': 'json' },
    },
  );

  if (org === undefined || org.trim() === '') {
    if (json) {
      return printJsonFailure(
        {
          code: 'target_required',
          message: 'audit events requires --org.',
          fix: 'Pass the organization slug with --org.',
          next: 'noodle audit events --org <org> --json',
        },
        EXIT.USAGE,
      );
    }
    console.error('audit events: --org is required');
    return EXIT.USAGE;
  }

  const resolved = await resolveControlPlaneToken({
    serviceFlag,
    authFlag,
    env,
    home,
  });

  try {
    const caps = await serviceJson<ServiceCapabilitiesResponse>(
      `${resolved.serviceUrl}/v1/service/capabilities`,
      resolved.token,
    );
    if (!caps.capabilities.includes('audit')) {
      if (json) {
        return printJsonFailure(
          {
            code: 'missing_capability',
            message: 'The target service does not support audit events.',
            fix: 'configure audit in the service runtime',
            next: 'noodle service capabilities --json',
            detail: { capability: 'audit' },
          },
          EXIT.FAILURE,
        );
      } else {
        console.log('FAIL audit events: missing audit capability');
        console.log('  Cause: this service does not support auditing.');
        console.log('  Fix: configure audit in the service runtime.');
      }
      return 1;
    }

    const url = new URL(`${resolved.serviceUrl}/v1/orgs/${encodeURIComponent(org)}/audit/events`);
    if (app !== undefined) url.searchParams.set('app', app);
    if (envFlag !== undefined) url.searchParams.set('env', envFlag);
    if (eventType !== undefined) url.searchParams.set('eventType', eventType);
    if (limit !== undefined) url.searchParams.set('limit', limit);

    const body = await serviceJson<ServiceEventsResponse>(url.toString(), resolved.token);
    if (json) {
      printJsonOk({ events: body.events, service: resolved.serviceUrl });
      return 0;
    }

    if (body.events.length === 0) {
      console.log('No audit events found.');
      return 0;
    }

    console.log(renderAuditEventsTable(body.events, stdoutTableOptions()));
    return 0;
  } catch (error) {
    return printCliFailure(
      'audit events',
      serviceFailure(
        'audit events',
        error,
        'noodle audit events --org <org> [--app <app>] [--env <env>]',
      ),
      json,
    );
  }
}
