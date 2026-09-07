/**
 * Login/session and control-plane account commands: login, logout, whoami,
 * target — plus their flag parsers. The deployment listing/inspection commands moved to
 * `deployments-ops.ts` (ADR 0128 D4, promoting `noodle list` to `noodle deployments list`); the org
 * administration commands (orgs, members) live in `org-admin.ts`.
 */
import {
  type ConfigLocation,
  clearConfig,
  configPath,
  maskToken,
  type NoodleConfig,
  readConfig,
  resolveServiceUrl,
  writeConfig,
} from '../config.js';
import {
  browserLogin,
  RefreshTokenRejectedError,
  resolveControlPlaneToken,
  revokeNoodleToken,
  serviceJson,
} from '../control-plane.js';
import { DEFAULT_SERVICE_URL } from '../deploy.js';
import { type DetailCardOptions, type DetailRow, renderDetailCard } from '../detail-card.js';
import { errorMessage, printRecovery } from '../diagnostics.js';
import { pluginServiceOrigin, readPluginCompatibility } from '../plugin-mode/compatibility.js';
import type { PluginMode } from '../plugin-mode/profile.js';
import { readProjectLink } from '../project.js';
import { printJsonOk } from './output.js';
import { stdoutTableOptions } from './resource-shared.js';
import { parseCommandFlags, usage } from './shared.js';

export async function runLogin(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
  pluginMode?: PluginMode,
): Promise<number> {
  const { service, token, envName } = parseCommandFlags(rest, {
    values: { '--service': 'service', '--auth-token': 'token', '--env': 'envName' },
    booleans: {},
  });
  const existing = readConfig(home);
  const serviceUrl =
    (pluginMode === undefined
      ? resolveServiceUrl(service, env, existing)
      : pluginServiceOrigin(readPluginCompatibility(pluginMode.compatibilityFile))) ??
    (token !== undefined || envName === undefined ? DEFAULT_SERVICE_URL : undefined);
  if (token === undefined && serviceUrl !== undefined) {
    try {
      const result = await browserLogin({
        serviceUrl,
        home,
        ...(pluginMode !== undefined
          ? { resource: `${new URL(serviceUrl).origin}/developer/cli` }
          : {}),
      });
      const resolved = await resolveControlPlaneToken({ serviceFlag: serviceUrl, env, home });
      const account =
        resolved.token !== undefined
          ? await tryRefreshAccountDefaults({ serviceUrl, token: resolved.token, home })
          : undefined;
      const config = readConfig(home);
      if (envName !== undefined) writeConfig({ ...config, defaultEnv: envName }, home);
      console.log(`Saved ${configPath(home)} (0600).`);
      console.log(`  service: ${result.serviceUrl}`);
      if (account?.identity.email !== undefined)
        console.log(`  identity: ${account.identity.email}`);
      else if (result.email !== undefined) console.log(`  identity: ${result.email}`);
      if (account?.defaultOrg !== undefined) console.log(`  org:     ${account.defaultOrg}`);
      return 0;
    } catch (error) {
      if (error instanceof RefreshTokenRejectedError) throw error;
      printRecovery({
        command: 'login',
        cause: errorMessage(error),
        fix: 'Check the service URL, browser login configuration, and network connection.',
        next: `noodle login --service ${serviceUrl}`,
      });
      return 1;
    }
  }
  if (service === undefined && token === undefined && envName === undefined) {
    throw new Error('unreachable login state');
  }
  const merged: NoodleConfig = {
    ...existing,
    ...(serviceUrl !== undefined ? { serviceUrl } : {}),
    ...(token !== undefined ? { authToken: token } : {}),
    ...(envName !== undefined ? { defaultEnv: envName } : {}),
  };
  writeConfig(merged, home);
  const account =
    merged.authToken !== undefined && merged.serviceUrl !== undefined
      ? await tryRefreshAccountDefaults({
          serviceUrl: merged.serviceUrl,
          token: merged.authToken,
          home,
        })
      : undefined;
  console.log(`Saved ${configPath(home)} (0600).`);
  const stored = readConfig(home);
  console.log(`  service: ${stored.serviceUrl ?? '(none)'}`);
  console.log(`  token:   ${maskToken(stored.authToken)}`);
  if (account?.identity.email !== undefined) console.log(`  identity: ${account.identity.email}`);
  if (account?.defaultOrg !== undefined) console.log(`  org:     ${account.defaultOrg}`);
  if (merged.defaultEnv) console.log(`  env:     ${merged.defaultEnv}`);
  return 0;
}

export async function runLogout(home: ConfigLocation, pluginMode?: PluginMode): Promise<number> {
  const config = readConfig(home);
  if (
    pluginMode !== undefined &&
    config.authToken !== undefined &&
    config.oauthClientId !== undefined
  ) {
    try {
      await revokeNoodleToken({
        issuer:
          config.oauthIssuer ??
          pluginServiceOrigin(readPluginCompatibility(pluginMode.compatibilityFile)),
        clientId: config.oauthClientId,
        token: config.authToken,
      });
    } catch (error) {
      printRecovery({
        command: 'logout',
        cause: errorMessage(error),
        fix: 'Retry while connected so the plugin grant is revoked before local credentials are cleared.',
        next: 'noodle logout',
      });
      return 1;
    }
  }
  clearConfig(home);
  console.log('Logged out (cleared the stored auth token).');
  return 0;
}

/** Input for the `whoami` detail card — the identity/org facts the command prints today. */
export interface WhoamiCardInput {
  readonly serviceUrl: string;
  readonly token: string | undefined;
  readonly identity?: {
    readonly email?: string;
    readonly subject?: string;
    readonly superAdmin?: boolean;
  };
  readonly orgs?: readonly string[];
}

/**
 * Render the `whoami` detail card (approved design 2026-07-06): the identity email (or subject)
 * as the orange title, dim provenance rows, and a NEXT footer — `noodle login` when signed out.
 * Pure; exported for direct tone assertions (spied stdout is never a color TTY).
 */
export function renderWhoamiCard(input: WhoamiCardInput, opts: DetailCardOptions): string {
  const title = input.identity?.email ?? input.identity?.subject ?? 'not signed in';
  const rows: DetailRow[] = [
    { key: 'service', value: input.serviceUrl },
    { key: 'token', value: maskToken(input.token), tone: 'dim' },
    ...(input.identity?.subject !== undefined
      ? [{ key: 'subject', value: input.identity.subject, tone: 'dim' } satisfies DetailRow]
      : []),
    ...(input.identity?.superAdmin !== undefined
      ? [
          {
            key: 'admin',
            value: input.identity.superAdmin ? 'yes' : 'no',
            tone: input.identity.superAdmin ? 'attention' : 'dim',
          } satisfies DetailRow,
        ]
      : []),
    ...(input.orgs !== undefined
      ? [{ key: 'orgs', value: input.orgs.join(', ') || '(none)' } satisfies DetailRow]
      : []),
  ];
  const next = input.token === undefined ? ['noodle login'] : ['noodle target show'];
  return renderDetailCard(title, rows, opts, next);
}

export async function runWhoami(
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
  rest: readonly string[] = [],
): Promise<number> {
  const { serviceFlag, authFlag } = parseServiceFlags(rest);
  const { serviceUrl, token, config } = await resolveControlPlaneToken({
    serviceFlag,
    authFlag,
    env,
    home,
  });
  if (token === undefined) {
    console.log(
      renderWhoamiCard(
        {
          serviceUrl,
          token,
          ...(config.identity !== undefined ? { identity: config.identity } : {}),
        },
        stdoutTableOptions(),
      ),
    );
    return 0;
  }
  try {
    const body = await serviceJson<{
      ok: true;
      identity: { email: string; subject: string; superAdmin: boolean };
      orgs: readonly { slug: string }[];
    }>(`${serviceUrl}/v1/whoami`, token);
    persistAccountDefaults(body, home);
    console.log(
      renderWhoamiCard(
        {
          serviceUrl,
          token,
          identity: body.identity,
          orgs: body.orgs.map((org) => org.slug),
        },
        stdoutTableOptions(),
      ),
    );
    return 0;
  } catch (error) {
    printRecovery({
      command: 'whoami',
      cause: errorMessage(error),
      fix: 'Check your login and service URL.',
      next: `noodle login --service ${serviceUrl}`,
    });
    return 1;
  }
}

interface WhoamiBody {
  readonly ok: true;
  readonly identity: {
    readonly email: string;
    readonly subject: string;
    readonly superAdmin: boolean;
  };
  readonly orgs: readonly { readonly slug: string }[];
}

async function refreshAccountDefaults(input: {
  readonly serviceUrl: string;
  readonly token: string;
  readonly home: ConfigLocation;
}): Promise<{ readonly identity: WhoamiBody['identity']; readonly defaultOrg?: string }> {
  const body = await serviceJson<WhoamiBody>(`${input.serviceUrl}/v1/whoami`, input.token);
  return persistAccountDefaults(body, input.home);
}

async function tryRefreshAccountDefaults(input: {
  readonly serviceUrl: string;
  readonly token: string;
  readonly home: ConfigLocation;
}): Promise<
  { readonly identity: WhoamiBody['identity']; readonly defaultOrg?: string } | undefined
> {
  try {
    return await refreshAccountDefaults(input);
  } catch {
    return undefined;
  }
}

function persistAccountDefaults(
  body: WhoamiBody,
  home: ConfigLocation,
): { readonly identity: WhoamiBody['identity']; readonly defaultOrg?: string } {
  const config = readConfig(home);
  const defaultOrg =
    body.identity.superAdmin === false
      ? config.defaultOrg !== undefined && body.orgs.some((org) => org.slug === config.defaultOrg)
        ? config.defaultOrg
        : body.orgs[0]?.slug
      : config.defaultOrg;
  const { defaultOrg: _previousDefaultOrg, ...configWithoutDefault } = config;
  writeConfig(
    {
      ...configWithoutDefault,
      identity: {
        subject: body.identity.subject,
        email: body.identity.email,
      },
      ...(defaultOrg !== undefined ? { defaultOrg } : {}),
    },
    home,
  );
  return {
    identity: body.identity,
    ...(defaultOrg !== undefined ? { defaultOrg } : {}),
  };
}

/** Where an effective `target show` field's value came from. */
type TargetFieldSource = 'link' | 'config' | 'default' | 'unset';

interface ResolvedTargetField {
  readonly value: string | null;
  readonly source: TargetFieldSource;
}

/** Resolve one target field: linked project value > saved config value > built-in default. */
function resolveTargetField(
  link: string | undefined,
  config: string | undefined,
  fallback?: string,
): ResolvedTargetField {
  if (link !== undefined) return { value: link, source: 'link' };
  if (config !== undefined) return { value: config, source: 'config' };
  if (fallback !== undefined) return { value: fallback, source: 'default' };
  return { value: null, source: 'unset' };
}

function sourceLabel(source: TargetFieldSource): string {
  if (source === 'unset') return '';
  if (source === 'default') return '(default)';
  return `(from ${source})`;
}

/** The five resolved fields `target show` displays. */
export interface ResolvedTargetView {
  readonly runtime: ResolvedTargetField;
  readonly service: ResolvedTargetField;
  readonly org: ResolvedTargetField;
  readonly app: ResolvedTargetField;
  readonly env: ResolvedTargetField;
}

/**
 * Render the `target show` detail card (approved design 2026-07-06): the effective org/app/env as
 * the orange title, one row per field with its source as a dim provenance note, unset fields dim.
 * Pure; exported for direct tone assertions (spied stdout is never a color TTY).
 */
export function renderTargetShowCard(target: ResolvedTargetView, opts: DetailCardOptions): string {
  const unset = opts.glyph === 'ascii' ? '-' : '—';
  const row = (key: string, field: ResolvedTargetField): DetailRow => ({
    key,
    value: field.value ?? unset,
    ...(field.value === null ? { tone: 'dim' as const } : {}),
    ...(sourceLabel(field.source) !== '' ? { note: sourceLabel(field.source) } : {}),
  });
  const title = [target.org, target.app, target.env].map((field) => field.value ?? unset).join('/');
  return renderDetailCard(
    title,
    [
      row('runtime', target.runtime),
      row('service', target.service),
      row('org', target.org),
      row('app', target.app),
      row('env', target.env),
    ],
    opts,
    ['noodle target set --org <org>'],
  );
}

export function runTarget(rest: readonly string[], home: ConfigLocation): number {
  const [action, ...tail] = rest;
  const args = parseTargetArgs(tail);
  const config = readConfig(home);
  const json = tail.includes('--json');
  if (action === 'show') {
    const project = readProjectLink();
    const target = {
      runtime: resolveTargetField(undefined, config.defaultRuntime, 'local'),
      service: resolveTargetField(project?.serviceUrl, config.serviceUrl, DEFAULT_SERVICE_URL),
      org: resolveTargetField(project?.org, config.defaultOrg),
      app: resolveTargetField(project?.app, config.defaultApp),
      env: resolveTargetField(project?.env, config.defaultEnv, 'prod'),
    };
    if (json) {
      printJsonOk({ target });
      return 0;
    }
    console.log(renderTargetShowCard(target, stdoutTableOptions()));
    return 0;
  }
  if (action === 'set') {
    const updated = {
      ...config,
      ...(args.runtime !== undefined ? { defaultRuntime: args.runtime } : {}),
      ...(args.service !== undefined ? { serviceUrl: args.service } : {}),
      ...(args.org !== undefined ? { defaultOrg: args.org } : {}),
      ...(args.app !== undefined ? { defaultApp: args.app } : {}),
      ...(args.targetEnv !== undefined ? { defaultEnv: args.targetEnv } : {}),
    };
    writeConfig(updated, home);
    if (json) {
      printJsonOk({
        target: {
          runtime: updated.defaultRuntime ?? 'local',
          service: updated.serviceUrl ?? null,
          org: updated.defaultOrg ?? null,
          app: updated.defaultApp ?? null,
          env: updated.defaultEnv ?? null,
        },
      });
      return 0;
    }
    console.log(`Saved ${configPath(home)} (0600).`);
    return 0;
  }
  usage();
  return 2;
}

function parseServiceFlags(rest: readonly string[]): {
  readonly serviceFlag?: string;
  readonly authFlag?: string;
} {
  return parseCommandFlags(rest, {
    values: { '--service': 'serviceFlag', '--auth-token': 'authFlag' },
    booleans: {},
  });
}

function parseTargetArgs(rest: readonly string[]): {
  readonly runtime?: 'local' | 'cloud' | 'other';
  readonly service?: string;
  readonly org?: string;
  readonly app?: string;
  readonly targetEnv?: string;
} {
  const { runtime, ...args } = parseCommandFlags(rest, {
    values: {
      '--runtime': 'runtime',
      '--service': 'service',
      '--org': 'org',
      '--app': 'app',
      '--env': 'targetEnv',
    },
    booleans: {},
  });
  return {
    ...args,
    ...(runtime === 'local' || runtime === 'cloud' || runtime === 'other' ? { runtime } : {}),
  };
}
