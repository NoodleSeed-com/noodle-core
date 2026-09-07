import type { ConfigLocation } from '../config.js';
/**
 * The `apps` resource commands: `noodle apps list` / `noodle apps inspect` / `noodle apps open`.
 * Read-only, org-scoped views over the hosted `GET /v1/orgs/{org}/apps[/{app}]` routes (see
 * `packages/service/src/routes/apps.ts`); each `AppSummary` aggregates every deployment of an app
 * across every environment. The wire types, arg parsing, target resolution, failure builders, and
 * branded table styling live in `resource-shared.ts`; the interactive org/app pickers for an
 * unresolved target live in `target-picker.ts`; `--watch`'s live-redraw loop lives in `../watch.js`.
 */
import { resolveControlPlaneToken, ServiceRequestError, serviceJson } from '../control-plane.js';
import { relativeTime } from '../relative-time.js';
import { type Column, renderTable, type TableOptions } from '../table.js';
import { parseWatchFlags, runWatch, type WatchFrame, watchJsonConflictFailure } from '../watch.js';
import { printOrOpenUrl } from './open-ops.js';
import { EXIT, printJsonOk } from './output.js';
import {
  ACCESS_CHIP_COLORS,
  ACTIVE_GREEN,
  type AppResponse,
  type AppSummary,
  type AppsListResponse,
  authRequired,
  DIM_GRAY,
  dimText,
  notFoundApp,
  notFoundEnv,
  parseResourceArgs,
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
import { pickAppInteractively, pickOrgInteractively } from './target-picker.js';

export async function runApps(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const [subcommand, ...tail] = rest;
  if (subcommand === 'list') return runAppsList(tail, env, home);
  if (subcommand === 'inspect') return runAppsInspect(tail, env, home);
  if (subcommand === 'open') return runAppsOpen(tail, env, home);
  usage();
  return EXIT.USAGE;
}

// --- list --------------------------------------------------------------------

/**
 * Fetch + render the `apps list` table (or its empty-state line) — shared by the one-shot print
 * and `--watch`. Exported so tests can exercise the exact function `--watch` polls without
 * driving the (deliberately unbounded) live loop itself.
 */
export async function appsListFrame(
  serviceUrl: string,
  token: string | undefined,
  org: string,
  archived: boolean,
): Promise<WatchFrame> {
  try {
    const url = new URL(`${serviceUrl}/v1/orgs/${encodeURIComponent(org)}/apps`);
    if (archived) url.searchParams.set('archived', 'true');
    const body = await serviceJson<AppsListResponse>(url.toString(), token);
    if (body.data.apps.length === 0) {
      return { ok: true, frame: `No apps in ${org}. Deploy one with \`noodle deploy\`.` };
    }
    const table = renderAppsTable(body.data.apps, stdoutTableOptions());
    const frame = body.data.truncated
      ? `${table}\n${dimText('(list truncated — pass --json for the structured list)', process.stdout)}`
      : table;
    return { ok: true, frame };
  } catch (error) {
    return { ok: false, error: serviceFailure('apps', error, 'noodle doctor') };
  }
}

async function runAppsList(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const { common } = parseResourceArgs(rest);
  const { watch, intervalMs } = parseWatchFlags(rest);
  if (watch && common.json) {
    return printCliFailure('apps', watchJsonConflictFailure('noodle apps list --json'), true);
  }

  let target = resolveOrgTarget(common.org, home);
  const resolved = await resolveControlPlaneToken({
    serviceFlag: common.service ?? (target.ok ? target.serviceUrl : undefined),
    authFlag: common.authToken,
    env,
    home,
  });
  if (!target.ok) {
    const org = await pickOrgInteractively(
      resolved,
      common.json,
      (o) => `noodle apps list --org ${o}`,
    );
    if (org === undefined) return printCliFailure('apps', target.error, common.json);
    target = { ok: true, org };
  }
  if (resolved.token === undefined) return printCliFailure('apps', authRequired(), common.json);

  if (common.json) {
    try {
      const url = new URL(`${resolved.serviceUrl}/v1/orgs/${encodeURIComponent(target.org)}/apps`);
      if (common.archived) url.searchParams.set('archived', 'true');
      const body = await serviceJson<AppsListResponse>(url.toString(), resolved.token);
      printJsonOk(body.data);
      return EXIT.OK;
    } catch (error) {
      return printCliFailure('apps', serviceFailure('apps', error, 'noodle doctor'), true);
    }
  }

  if (watch) {
    return runWatch({
      command: 'apps',
      intervalMs,
      render: () => appsListFrame(resolved.serviceUrl, resolved.token, target.org, common.archived),
    });
  }

  const result = await appsListFrame(
    resolved.serviceUrl,
    resolved.token,
    target.org,
    common.archived,
  );
  if (!result.ok) return printCliFailure('apps', result.error, false);
  console.log(result.frame);
  return EXIT.OK;
}

// --- inspect -------------------------------------------------------------------

async function runAppsInspect(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const { common, positional } = parseResourceArgs(rest);
  let app = positional[0];
  const target = resolveOrgTarget(common.org, home);
  if (!target.ok) {
    if (app === undefined) {
      return printCommandUsageFailure(
        'apps',
        'noodle apps inspect requires an app slug',
        'noodle apps inspect <app> --json',
        common.json,
      );
    }
    return printCliFailure('apps', target.error, common.json);
  }
  const resolved = await resolveControlPlaneToken({
    serviceFlag: common.service ?? target.serviceUrl,
    authFlag: common.authToken,
    env,
    home,
  });
  if (app === undefined) {
    const picked = await pickAppInteractively(
      resolved,
      target.org,
      common.json,
      (a) => `noodle apps inspect ${a} --org ${target.org}`,
    );
    if (picked === undefined) {
      return printCommandUsageFailure(
        'apps',
        'noodle apps inspect requires an app slug',
        'noodle apps inspect <app> --json',
        common.json,
      );
    }
    app = picked;
  }
  if (resolved.token === undefined) return printCliFailure('apps', authRequired(), common.json);
  try {
    const url =
      `${resolved.serviceUrl}/v1/orgs/${encodeURIComponent(target.org)}` +
      `/apps/${encodeURIComponent(app)}`;
    const body = await serviceJson<AppResponse>(url, resolved.token);
    if (common.json) {
      printJsonOk(body.data);
      return EXIT.OK;
    }
    printAppDetail(target.org, body.data);
    return EXIT.OK;
  } catch (error) {
    if (error instanceof ServiceRequestError && error.status === 404) {
      return printCliFailure('apps', notFoundApp(target.org, app), common.json);
    }
    return printCliFailure('apps', serviceFailure('apps', error, 'noodle apps list'), common.json);
  }
}

function printAppDetail(org: string, app: AppSummary): void {
  console.log(`app:      ${app.appSlug}`);
  console.log(`org:      ${org}`);
  console.log(`envs:     ${app.environments.length > 0 ? app.environments.join(', ') : '—'}`);
  console.log(`access:   ${app.accessMode ?? '—'}`);
  console.log(`active:   ${app.active ? 'yes' : 'no'}`);
  console.log(`created:  ${app.createdAt}`);
  console.log(`updated:  ${app.lastActivityAt ?? '—'}`);
  if (app.latest !== undefined) {
    const version = app.latest.serverVersion !== undefined ? ` (v${app.latest.serverVersion})` : '';
    console.log(`latest:   ${app.latest.deploymentId}${version}`);
  } else {
    console.log('latest:   no deploys');
  }
  if (app.archivedAt !== undefined) console.log(`archived: ${app.archivedAt}`);
}

// --- open ------------------------------------------------------------------------

interface EndpointStatusResponse {
  readonly ok: true;
  readonly deployment: { readonly endpointUrl: string };
}

/** `noodle apps open <app>` — resolve the app's facing (or `--env`) endpoint URL and open/print it. */
async function runAppsOpen(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const { common, positional, targetEnv, print } = parseAppsOpenArgs(rest);
  const appSlug = positional[0];
  if (appSlug === undefined) {
    return printCommandUsageFailure(
      'apps',
      'noodle apps open requires an app slug',
      'noodle apps open <app> --json',
      common.json,
    );
  }
  const target = resolveOrgTarget(common.org, home);
  if (!target.ok) return printCliFailure('apps', target.error, common.json);
  const resolved = await resolveControlPlaneToken({
    serviceFlag: common.service ?? target.serviceUrl,
    authFlag: common.authToken,
    env,
    home,
  });
  if (resolved.token === undefined) return printCliFailure('apps', authRequired(), common.json);

  let app: AppResponse;
  try {
    const appUrl =
      `${resolved.serviceUrl}/v1/orgs/${encodeURIComponent(target.org)}` +
      `/apps/${encodeURIComponent(appSlug)}`;
    app = await serviceJson<AppResponse>(appUrl, resolved.token);
  } catch (error) {
    if (error instanceof ServiceRequestError && error.status === 404) {
      return printCliFailure('apps', notFoundApp(target.org, appSlug), common.json);
    }
    return printCliFailure('apps', serviceFailure('apps', error, 'noodle apps list'), common.json);
  }

  const resolvedEnv = targetEnv ?? app.data.latest?.environment;
  if (resolvedEnv === undefined) {
    return printCliFailure('apps', notFoundApp(target.org, appSlug), common.json);
  }

  let status: EndpointStatusResponse;
  try {
    const statusUrl =
      `${resolved.serviceUrl}/v1/orgs/${encodeURIComponent(target.org)}` +
      `/apps/${encodeURIComponent(appSlug)}/envs/${encodeURIComponent(resolvedEnv)}/status`;
    status = await serviceJson<EndpointStatusResponse>(statusUrl, resolved.token);
  } catch (error) {
    if (error instanceof ServiceRequestError && error.status === 404) {
      return printCliFailure('apps', notFoundEnv(target.org, appSlug, resolvedEnv), common.json);
    }
    return printCliFailure(
      'apps',
      serviceFailure('apps', error, 'noodle apps inspect'),
      common.json,
    );
  }

  const url = status.deployment.endpointUrl;
  if (common.json) {
    printJsonOk({ org: target.org, app: appSlug, env: resolvedEnv, url });
    return EXIT.OK;
  }
  await printOrOpenUrl(url, env, print);
  return EXIT.OK;
}

interface AppsOpenArgs {
  readonly common: {
    readonly org?: string;
    readonly service?: string;
    readonly authToken?: string;
    readonly json: boolean;
  };
  readonly positional: string[];
  readonly targetEnv?: string;
  readonly print: boolean;
}

function parseAppsOpenArgs(rest: readonly string[]): AppsOpenArgs {
  const { positional, targetEnv, print, ...common } = parseCommandFlags(rest, {
    values: {
      '--org': 'org',
      '--env': 'targetEnv',
      '--service': 'service',
      '--auth-token': 'authToken',
    },
    booleans: { '--json': 'json', '--print': 'print' },
  });
  return {
    common,
    positional: [...positional],
    ...(targetEnv !== undefined ? { targetEnv } : {}),
    print,
  };
}

// --- table rendering -----------------------------------------------------------

const APPS_COLUMNS: readonly Column<AppSummary>[] = [
  { header: 'APP', get: (a) => a.appSlug },
  {
    header: 'ENVS',
    get: (a) => (a.environments.length > 0 ? a.environments.join(', ') : '—'),
  },
  {
    header: 'LATEST',
    get: (a) => (a.latest === undefined ? 'no deploys' : a.active ? 'active' : 'inactive'),
    color: (a) => (a.latest !== undefined && a.active ? ACTIVE_GREEN : DIM_GRAY),
  },
  {
    header: 'ACCESS',
    get: (a) => a.accessMode ?? '—',
    color: (a) => (a.accessMode !== undefined ? ACCESS_CHIP_COLORS[a.accessMode] : undefined),
  },
  {
    header: 'UPDATED',
    get: (a) => (a.lastActivityAt !== undefined ? relativeTime(a.lastActivityAt) : '—'),
    align: 'right',
    color: (a) => (a.lastActivityAt === undefined ? DIM_GRAY : undefined),
  },
];

/** Render the `apps list` table. Exported so tests (and the contract drift gate) can call it directly. */
export function renderAppsTable(apps: readonly AppSummary[], opts: TableOptions): string {
  return renderTable(APPS_COLUMNS, apps, opts);
}
