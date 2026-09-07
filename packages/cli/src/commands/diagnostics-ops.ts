import type { ConfigLocation } from '../config.js';
import { resolveControlPlaneToken, serviceJson } from '../control-plane.js';
import { type DetailCardOptions, type DetailRow, renderDetailCard } from '../detail-card.js';
import { accessModeNote } from './deploy-status-ops.js';
import { printJsonOk } from './output.js';
import { stdoutTableOptions } from './resource-shared.js';
import {
  parseTenantCommandArgs,
  printCliFailure,
  resolveTenantTarget,
  serviceFailure,
} from './shared.js';

export async function runInspect(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const args = parseTenantCommandArgs(rest);
  const target = resolveTenantTarget(args, home);
  if (!target.ok) return printCliFailure('inspect', target.error, args.json);
  const resolved = await resolveControlPlaneToken({
    serviceFlag: args.service ?? target.serviceUrl,
    authFlag: args.authToken,
    env,
    home,
  });
  if (resolved.token === undefined) return authRequired('inspect', args.json);
  try {
    const body = await serviceJson<InspectResponse>(
      tenantUrl(resolved.serviceUrl, target, 'inspect'),
      resolved.token,
    );
    if (args.json) {
      printJsonOk({ ...body, service: resolved.serviceUrl });
      return 0;
    }
    console.log(renderInspectCard(body, resolved.serviceUrl, stdoutTableOptions()));
    return 0;
  } catch (error) {
    return printCliFailure('inspect', serviceFailure('inspect', error, 'noodle status'), args.json);
  }
}

export async function runHostedSmoke(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const args = parseTenantCommandArgs(rest);
  const target = resolveTenantTarget(args, home);
  if (!target.ok) return printCliFailure('smoke', target.error, args.json);
  const resolved = await resolveControlPlaneToken({
    serviceFlag: args.service ?? target.serviceUrl,
    authFlag: args.authToken,
    env,
    home,
  });
  if (resolved.token === undefined) return authRequired('smoke', args.json);
  try {
    const body = await serviceJson<SmokeResponse>(
      tenantUrl(resolved.serviceUrl, target, 'smoke'),
      resolved.token,
      {
        method: 'POST',
      },
    );
    if (args.json) {
      printJsonOk({ ...body, service: resolved.serviceUrl });
      return body.ok ? 0 : 1;
    }
    printSmoke(resolved.serviceUrl, body);
    return body.ok ? 0 : 1;
  } catch (error) {
    return printCliFailure('smoke', serviceFailure('smoke', error, 'noodle inspect'), args.json);
  }
}

function authRequired(command: 'inspect' | 'smoke', json: boolean): number {
  return printCliFailure(
    command,
    {
      code: 'auth_required',
      message: 'No control-plane login token is available.',
      cause: `Hosted ${command} requires an authenticated Noodle Seed Cloud identity.`,
      fix: 'Sign in to the target service.',
      next: 'noodle login',
      exitCode: 3,
    },
    json,
  );
}

function tenantUrl(
  serviceUrl: string,
  target: { readonly org: string; readonly app: string; readonly env: string },
  action: 'inspect' | 'smoke',
): string {
  return (
    `${serviceUrl}/v1/orgs/${encodeURIComponent(target.org)}` +
    `/apps/${encodeURIComponent(target.app)}/envs/${encodeURIComponent(target.env)}/${action}`
  );
}

/**
 * Render the `inspect` detail card (approved design 2026-07-06): every previously printed field
 * mapped onto a row — nothing dropped — with findings as toned WARN/FAIL rows so the NEXT footer
 * stays last. Pure; exported for direct tone assertions (spied stdout is never a color TTY).
 */
export function renderInspectCard(
  body: InspectResponse,
  serviceUrl: string,
  opts: DetailCardOptions,
): string {
  const rows: DetailRow[] = [
    { key: 'deployment', value: body.deployment.deploymentId },
    body.deployment.active
      ? { key: 'state', value: 'active', tone: 'good', dot: true }
      : { key: 'state', value: 'inactive', tone: 'dim' },
    { key: 'endpoint', value: body.deployment.endpointUrl },
    {
      key: 'access',
      value: body.deployment.accessMode,
      tone: 'attention',
      note: accessModeNote(body.deployment.accessMode),
    },
    ...(body.deployment.ownerSubject !== undefined
      ? [{ key: 'owner', value: body.deployment.ownerSubject, tone: 'dim' } satisfies DetailRow]
      : []),
    {
      key: 'health',
      value: body.health.state,
      tone: body.health.state === 'ready' ? 'good' : 'bad',
    },
    ...(body.health.missingSecrets.length > 0
      ? [
          {
            key: 'secrets',
            value: `missing ${body.health.missingSecrets.join(', ')}`,
            tone: 'bad',
          } satisfies DetailRow,
        ]
      : []),
    { key: 'tools', value: names(body.surface.tools) },
    { key: 'resources', value: resourceNames(body.surface.resources) },
    { key: 'prompts', value: names(body.surface.prompts) },
    { key: 'widgets', value: widgetNames(body.surface.widgets) },
    {
      key: 'compat',
      value:
        `mcpApps=${body.surface.compatibility.mcpApps} ` +
        `chatgpt=${body.surface.compatibility.chatgpt} claude=${body.surface.compatibility.claude}`,
    },
    { key: 'service', value: serviceUrl, tone: 'dim' },
    ...body.findings.map(
      (finding): DetailRow => ({
        key: finding.level.toUpperCase(),
        value: `${finding.code}: ${finding.message}`,
        tone: finding.level === 'fail' ? 'bad' : 'attention',
      }),
    ),
  ];
  return renderDetailCard(`${body.target.org}/${body.target.app}/${body.target.env}`, rows, opts, [
    'noodle smoke',
    'noodle open',
  ]);
}

function printSmoke(serviceUrl: string, body: SmokeResponse): void {
  console.log(`service: ${serviceUrl}`);
  console.log(`target:  ${body.target.org}/${body.target.app}/${body.target.env}`);
  for (const check of body.checks) console.log(`${check.level} ${check.name}: ${check.message}`);
  console.log(`inspector: ${body.external.inspector}`);
  console.log(`mcpjam:    ${body.external.mcpjam}`);
}

function names(items: readonly { readonly name: string }[]): string {
  return items.length === 0 ? '(none)' : items.map((item) => item.name).join(', ');
}

function resourceNames(items: readonly { readonly uri: string }[]): string {
  return items.length === 0 ? '(none)' : items.map((item) => item.uri).join(', ');
}

function widgetNames(items: readonly { readonly uri: string }[]): string {
  return items.length === 0 ? '(none)' : items.map((item) => item.uri).join(', ');
}

export interface InspectResponse {
  readonly ok: true;
  readonly target: { readonly org: string; readonly app: string; readonly env: string };
  readonly deployment: {
    readonly deploymentId: string;
    readonly endpointUrl: string;
    readonly active: boolean;
    readonly accessMode: string;
    readonly ownerSubject?: string;
    readonly serverName: string;
    readonly createdAt: string;
  };
  readonly health: { readonly state: string; readonly missingSecrets: readonly string[] };
  readonly surface: {
    readonly tools: readonly { readonly name: string }[];
    readonly resources: readonly { readonly uri: string }[];
    readonly prompts: readonly { readonly name: string }[];
    readonly widgets: readonly { readonly uri: string }[];
    readonly widgetLinkedTools: readonly { readonly name: string; readonly resourceUri: string }[];
    readonly appOnlyTools: readonly { readonly name: string }[];
    readonly compatibility: {
      readonly mcpApps: string;
      readonly chatgpt: string;
      readonly claude: string;
    };
  };
  readonly findings: readonly {
    readonly level: 'warn' | 'fail';
    readonly code: string;
    readonly message: string;
  }[];
}

interface SmokeResponse {
  readonly ok: boolean;
  readonly target: { readonly org: string; readonly app: string; readonly env: string };
  readonly checks: readonly {
    readonly level: 'PASS' | 'WARN' | 'FAIL';
    readonly name: string;
    readonly message: string;
  }[];
  readonly external: { readonly inspector: string; readonly mcpjam: string };
}
