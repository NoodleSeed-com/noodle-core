import type { ConfigLocation } from '../config.js';
/**
 * The `envs` resource commands: list, inspect, and owner-only production designation. Org- and
 * app-scoped views over the hosted `GET /v1/orgs/{org}/apps/{app}/envs[/{env}]` routes (see
 * `packages/service/src/routes/envs.ts`); each `EnvSummary` narrows the app aggregation to one
 * environment. The wire types, target resolution, failure builders, and branded table styling live
 * in `resource-shared.ts` (`envs` parses its own `--app` flag, below); the interactive org/app/env
 * pickers for an unresolved target live in `target-picker.ts`.
 */
import { readConfig } from '../config.js';
import { resolveControlPlaneToken, ServiceRequestError, serviceJson } from '../control-plane.js';
import { readProjectLink } from '../project.js';
import { relativeTime } from '../relative-time.js';
import { type Column, renderTable, type TableOptions } from '../table.js';
import { EXIT, printJsonOk } from './output.js';
import {
  ACCESS_CHIP_COLORS,
  ACTIVE_GREEN,
  authRequired,
  DIM_GRAY,
  type EnvResponse,
  type EnvSummary,
  type EnvsListResponse,
  notFoundApp,
  notFoundEnv,
  type ProductionEnvironmentResponse,
  stdoutTableOptions,
} from './resource-shared.js';
import {
  parseCommandFlags,
  printCliFailure,
  printCommandUsageFailure,
  resolveTenantTarget,
  serviceFailure,
  usage,
} from './shared.js';
import {
  pickAppInteractively,
  pickEnvInteractively,
  pickOrgInteractively,
} from './target-picker.js';

export async function runEnvs(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const [subcommand, ...tail] = rest;
  if (subcommand === 'list') return runEnvsList(tail, env, home);
  if (subcommand === 'inspect') return runEnvsInspect(tail, env, home);
  if (subcommand === 'set-production') return runEnvsSetProduction(tail, env, home);
  usage();
  return EXIT.USAGE;
}

// --- shared arg parsing --------------------------------------------------------

interface CommonEnvsArgs {
  readonly org?: string;
  readonly app?: string;
  readonly service?: string;
  readonly authToken?: string;
  readonly json: boolean;
  /** `--archived`: opt archived envs into the list (only `list` reads it; `inspect` always shows one). */
  readonly archived: boolean;
}

function parseCommonEnvsArgs(rest: readonly string[]): {
  readonly common: CommonEnvsArgs;
  readonly positional: string[];
} {
  const { positional, ...common } = parseCommandFlags(rest, {
    values: {
      '--org': 'org',
      '--app': 'app',
      '--service': 'service',
      '--auth-token': 'authToken',
    },
    booleans: { '--json': 'json', '--archived': 'archived' },
  });
  return { common, positional: [...positional] };
}

/**
 * Resolve org/app the same way `resolveTenantTarget` does (flag > link > config), but without
 * failing when one is still missing — the caller uses this to know which picker(s) to attempt
 * before falling back to `resolveTenantTarget`'s combined `target_required` failure.
 */
function partialEnvsTarget(
  common: CommonEnvsArgs,
  home: ConfigLocation,
): { org?: string; app?: string; serviceUrl?: string } {
  const project = readProjectLink();
  const config = readConfig(home);
  const org = common.org ?? project?.org ?? config.defaultOrg;
  const app = common.app ?? project?.app ?? config.defaultApp;
  const serviceUrl = common.service ?? project?.serviceUrl ?? config.serviceUrl;
  return {
    ...(org !== undefined ? { org } : {}),
    ...(app !== undefined ? { app } : {}),
    ...(serviceUrl !== undefined ? { serviceUrl } : {}),
  };
}

// --- list ----------------------------------------------------------------------

async function runEnvsList(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const { common } = parseCommonEnvsArgs(rest);
  const target = resolveTenantTarget(
    {
      ...(common.org !== undefined ? { org: common.org } : {}),
      ...(common.app !== undefined ? { app: common.app } : {}),
    },
    home,
  );
  const partial = partialEnvsTarget(common, home);
  const resolved = await resolveControlPlaneToken({
    serviceFlag: common.service ?? (target.ok ? target.serviceUrl : partial.serviceUrl),
    authFlag: common.authToken,
    env,
    home,
  });

  let org: string;
  let app: string;
  if (target.ok) {
    org = target.org;
    app = target.app;
  } else {
    let pickedOrg = partial.org;
    let pickedApp = partial.app;
    if (pickedOrg === undefined) {
      pickedOrg = await pickOrgInteractively(
        resolved,
        common.json,
        (o) => `noodle envs list --org ${o}`,
      );
    }
    if (pickedOrg !== undefined && pickedApp === undefined) {
      const resolvedOrg = pickedOrg;
      pickedApp = await pickAppInteractively(
        resolved,
        resolvedOrg,
        common.json,
        (a) => `noodle envs list --org ${resolvedOrg} --app ${a}`,
      );
    }
    if (pickedOrg === undefined || pickedApp === undefined) {
      return printCliFailure('envs', target.error, common.json);
    }
    org = pickedOrg;
    app = pickedApp;
  }
  if (resolved.token === undefined) return printCliFailure('envs', authRequired(), common.json);
  try {
    const url = new URL(
      `${resolved.serviceUrl}/v1/orgs/${encodeURIComponent(org)}` +
        `/apps/${encodeURIComponent(app)}/envs`,
    );
    if (common.archived) url.searchParams.set('archived', 'true');
    const body = await serviceJson<EnvsListResponse>(url.toString(), resolved.token);
    if (common.json) {
      printJsonOk(body.data);
      return EXIT.OK;
    }
    if (body.data.envs.length === 0) {
      console.log(`No environments for ${org}/${app}. Deploy with \`noodle deploy\`.`);
      return EXIT.OK;
    }
    console.log(renderEnvsTable(body.data.envs, stdoutTableOptions()));
    return EXIT.OK;
  } catch (error) {
    if (error instanceof ServiceRequestError && error.status === 404) {
      return printCliFailure('envs', notFoundApp(org, app), common.json);
    }
    return printCliFailure('envs', serviceFailure('envs', error, 'noodle doctor'), common.json);
  }
}

// --- inspect -------------------------------------------------------------------

async function runEnvsInspect(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const { common, positional } = parseCommonEnvsArgs(rest);
  let envName = positional[0];
  const target = resolveTenantTarget(
    {
      ...(common.org !== undefined ? { org: common.org } : {}),
      ...(common.app !== undefined ? { app: common.app } : {}),
    },
    home,
  );
  if (!target.ok) {
    if (envName === undefined) {
      return printCommandUsageFailure(
        'envs',
        'noodle envs inspect requires an environment name',
        'noodle envs inspect <env> --json',
        common.json,
      );
    }
    return printCliFailure('envs', target.error, common.json);
  }
  const resolved = await resolveControlPlaneToken({
    serviceFlag: common.service ?? target.serviceUrl,
    authFlag: common.authToken,
    env,
    home,
  });
  if (envName === undefined) {
    const picked = await pickEnvInteractively(
      resolved,
      target.org,
      target.app,
      common.json,
      (e) => `noodle envs inspect ${e} --org ${target.org} --app ${target.app}`,
    );
    if (picked === undefined) {
      return printCommandUsageFailure(
        'envs',
        'noodle envs inspect requires an environment name',
        'noodle envs inspect <env> --json',
        common.json,
      );
    }
    envName = picked;
  }
  if (resolved.token === undefined) return printCliFailure('envs', authRequired(), common.json);
  try {
    const url =
      `${resolved.serviceUrl}/v1/orgs/${encodeURIComponent(target.org)}` +
      `/apps/${encodeURIComponent(target.app)}/envs/${encodeURIComponent(envName)}`;
    const body = await serviceJson<EnvResponse>(url, resolved.token);
    if (common.json) {
      printJsonOk(body.data);
      return EXIT.OK;
    }
    printEnvDetail(target.org, target.app, body.data);
    return EXIT.OK;
  } catch (error) {
    if (error instanceof ServiceRequestError && error.status === 404) {
      return printCliFailure('envs', notFoundEnv(target.org, target.app, envName), common.json);
    }
    return printCliFailure('envs', serviceFailure('envs', error, 'noodle envs list'), common.json);
  }
}

function printEnvDetail(org: string, app: string, envSummary: EnvSummary): void {
  console.log(`env:      ${envSummary.envName}`);
  console.log(`org:      ${org}`);
  console.log(`app:      ${app}`);
  console.log(`production: ${envSummary.isProduction ? 'yes' : 'no'}`);
  console.log(`access:   ${envSummary.accessMode ?? '—'}`);
  console.log(`active:   ${envSummary.active ? 'yes' : 'no'}`);
  console.log(`deploys:  ${envSummary.deploymentCount}`);
  console.log(`created:  ${envSummary.createdAt}`);
  console.log(`updated:  ${envSummary.lastActivityAt ?? '—'}`);
  if (envSummary.latest !== undefined) {
    const version =
      envSummary.latest.serverVersion !== undefined ? ` (v${envSummary.latest.serverVersion})` : '';
    console.log(`latest:   ${envSummary.latest.deploymentId}${version}`);
  } else {
    console.log('latest:   no deploys');
  }
  if (envSummary.archivedAt !== undefined) console.log(`archived: ${envSummary.archivedAt}`);
}

// --- table rendering -----------------------------------------------------------

const ENVS_COLUMNS: readonly Column<EnvSummary>[] = [
  { header: 'ENV', get: (e) => e.envName },
  { header: 'ROLE', get: (e) => (e.isProduction ? 'production' : '—') },
  {
    header: 'STATUS',
    get: (e) => (e.latest === undefined ? 'no deploys' : e.active ? 'active' : 'inactive'),
    color: (e) => (e.latest !== undefined && e.active ? ACTIVE_GREEN : DIM_GRAY),
  },
  {
    header: 'ACCESS',
    get: (e) => e.accessMode ?? '—',
    color: (e) => (e.accessMode !== undefined ? ACCESS_CHIP_COLORS[e.accessMode] : undefined),
  },
  {
    header: 'DEPLOYS',
    get: (e) => String(e.deploymentCount),
    align: 'right',
  },
  {
    header: 'UPDATED',
    get: (e) => (e.lastActivityAt !== undefined ? relativeTime(e.lastActivityAt) : '—'),
    align: 'right',
    color: (e) => (e.lastActivityAt === undefined ? DIM_GRAY : undefined),
  },
];

/** Render the `envs list` table. Exported so tests (and the contract drift gate) can call it directly. */
export function renderEnvsTable(envs: readonly EnvSummary[], opts: TableOptions): string {
  return renderTable(ENVS_COLUMNS, envs, opts);
}

async function runEnvsSetProduction(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const { common, positional } = parseCommonEnvsArgs(rest);
  const envName = positional[0];
  if (envName === undefined) {
    return printCommandUsageFailure(
      'envs',
      'noodle envs set-production requires an environment name',
      'noodle envs set-production <env> --json',
      common.json,
    );
  }
  const target = resolveTenantTarget(
    {
      ...(common.org !== undefined ? { org: common.org } : {}),
      ...(common.app !== undefined ? { app: common.app } : {}),
    },
    home,
  );
  if (!target.ok) return printCliFailure('envs', target.error, common.json);
  const resolved = await resolveControlPlaneToken({
    serviceFlag: common.service ?? target.serviceUrl,
    authFlag: common.authToken,
    env,
    home,
  });
  if (resolved.token === undefined) return printCliFailure('envs', authRequired(), common.json);
  try {
    const url =
      `${resolved.serviceUrl}/v1/orgs/${encodeURIComponent(target.org)}` +
      `/apps/${encodeURIComponent(target.app)}/production-environment`;
    const body = await serviceJson<ProductionEnvironmentResponse>(url, resolved.token, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ environment: envName }),
    });
    if (common.json) printJsonOk(body.data);
    else if (body.data.changed)
      console.log(`${envName} is now the production environment for ${target.org}/${target.app}.`);
    else
      console.log(
        `${envName} is already the production environment for ${target.org}/${target.app}.`,
      );
    return EXIT.OK;
  } catch (error) {
    if (error instanceof ServiceRequestError && error.status === 404) {
      return printCliFailure('envs', notFoundEnv(target.org, target.app, envName), common.json);
    }
    return printCliFailure(
      'envs',
      serviceFailure('envs', error, `noodle envs list --org ${target.org} --app ${target.app}`),
      common.json,
    );
  }
}
