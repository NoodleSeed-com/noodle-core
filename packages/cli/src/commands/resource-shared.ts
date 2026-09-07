import type {
  AppResponse,
  AppSummary,
  AppsListResponse,
  DeploymentPackageData,
  DeploymentPackageResponse,
  DeploymentResponse,
  DeploymentSummary,
  EnvResponse,
  EnvSummary,
  EnvsListResponse,
  ProductionEnvironmentResponse,
} from '@noodle-borg/wire-contracts';
import type { ConfigLocation } from '../config.js';
/**
 * Shared substrate for the resource command family (`apps`, `envs`, and `deployments` today; `orgs`
 * next): the hosted wire summary/response types, arg parsing + org-target resolution, the
 * `auth_required`/`not_found` failure builders, and the branded table styling (semantic colours,
 * the access-chip map, `dimText`, and the stdout table-option builder) that every resource `list`
 * view shares. Extracted first so each per-resource command module can build on it without the
 * command modules importing one another.
 */
import { readConfig } from '../config.js';
import { serviceJson } from '../control-plane.js';
import { detectColorMode, detectGlyphMode, paint, type RGB } from '../gradient.js';
import { readProjectLink } from '../project.js';
import type { TableOptions } from '../table.js';
import { EXIT } from './output.js';
import { type CliFailure, parseCommandFlags } from './shared.js';

// --- wire summary / response types ---------------------------------------------

/** The `GET /v1/orgs/{org}/deployments` collection response — unwrapped (no `data`), long-shipped. */
export interface DeploymentsListResponse {
  readonly ok: true;
  readonly deployments: readonly DeploymentSummary[];
}

export type {
  AppResponse,
  AppSummary,
  AppsListResponse,
  DeploymentPackageData,
  DeploymentPackageResponse,
  DeploymentResponse,
  DeploymentSummary,
  EnvResponse,
  EnvSummary,
  EnvsListResponse,
  ProductionEnvironmentResponse,
};

// --- shared arg parsing / org resolution ---------------------------------------

export interface ResourceArgs {
  readonly org?: string;
  readonly service?: string;
  readonly authToken?: string;
  readonly json: boolean;
  /** `--archived`: opt archived resources into the list (only `list` reads it; `inspect` always shows one). */
  readonly archived: boolean;
}

export function parseResourceArgs(rest: readonly string[]): {
  readonly common: ResourceArgs;
  readonly positional: string[];
} {
  const { positional, ...common } = parseCommandFlags(rest, {
    values: { '--org': 'org', '--service': 'service', '--auth-token': 'authToken' },
    booleans: { '--json': 'json', '--archived': 'archived' },
  });
  return { common, positional: [...positional] };
}

/** Resolve the target org: `--org` flag > linked project org > `config.defaultOrg`. */
export function resolveOrgTarget(
  orgFlag: string | undefined,
  home: ConfigLocation,
):
  | { readonly ok: true; readonly org: string; readonly serviceUrl?: string }
  | { readonly ok: false; readonly error: CliFailure } {
  const project = readProjectLink();
  const config = readConfig(home);
  const org = orgFlag ?? project?.org ?? config.defaultOrg;
  const serviceUrl = project?.serviceUrl ?? config.serviceUrl;
  if (org === undefined) {
    return {
      ok: false,
      error: {
        code: 'target_required',
        message: 'org is required',
        cause: 'No org target was supplied or saved.',
        fix: 'Pass --org, link the project, or set a default target.',
        next: 'noodle target set --org <org>',
        exitCode: EXIT.USAGE,
      },
    };
  }
  return { ok: true, org, ...(serviceUrl !== undefined ? { serviceUrl } : {}) };
}

// --- failure builders ----------------------------------------------------------

export function authRequired(): CliFailure {
  return {
    code: 'auth_required',
    message: 'No control-plane login token is available.',
    cause: 'Hosted apps commands require an authenticated Noodle Seed Cloud identity.',
    fix: 'Sign in to the target service.',
    next: 'noodle login',
    exitCode: EXIT.AUTH,
  };
}

/**
 * Build a `not_found` CLI failure — one shape shared by every resource `list`/`inspect` (apps/envs/
 * deployments today; orgs next). The caller supplies the resource label, its identity, the full
 * `cause` sentence, and the recovery `fix`/`next` text.
 */
function notFoundFailure(
  kind: string,
  name: string,
  cause: string,
  fix: string,
  next: string,
): CliFailure {
  return {
    code: 'not_found',
    message: `${kind} "${name}" was not found`,
    cause,
    fix,
    next,
    exitCode: EXIT.FAILURE,
  };
}

/** `not_found` for an app with no deployments (also used by `envs list` on an unknown app). */
export function notFoundApp(org: string, app: string): CliFailure {
  return notFoundFailure(
    'app',
    app,
    `${org}/${app} has no deployments.`,
    'Check the app slug and org, or list the org’s apps.',
    `noodle apps list --org ${org}`,
  );
}

/** `not_found` for an env with no deployments. */
export function notFoundEnv(org: string, app: string, envName: string): CliFailure {
  return notFoundFailure(
    'env',
    envName,
    `${org}/${app}/${envName} has no deployments.`,
    'Check the env name, org, and app, or list the app’s envs.',
    `noodle envs list --org ${org} --app ${app}`,
  );
}

/**
 * `not_found` for an unknown (or cross-org) deployment id. The service 404s a deployment that
 * belongs to a different org identically to an unknown id, so this never distinguishes the two —
 * existence must never leak across tenants.
 */
export function notFoundDeployment(org: string, deploymentId: string): CliFailure {
  return notFoundFailure(
    'deployment',
    deploymentId,
    `${org}/${deploymentId} was not found.`,
    'Check the deployment id and org, or list the org’s deployments.',
    `noodle deployments list --org ${org}`,
  );
}

// --- interactive-picker candidate fetches ---------------------------------------
//
// `target-picker.ts` presents the picker UI; these fetch the candidates it lists,
// shared here so `apps`/`envs`/`deployments` don't duplicate the (org|app|env) list
// requests. Every fetch failure resolves to an empty array — the caller's picker
// gate (`canPickTarget`) already requires a token, so a failure here just means "no
// candidates to offer," falling back to the existing non-interactive failure.

/** One entry from `GET /v1/orgs` — just enough to label the interactive org picker. */
export interface OrgCandidate {
  readonly slug: string;
  readonly displayName?: string;
}

export async function fetchOrgCandidates(
  serviceUrl: string,
  token: string,
): Promise<readonly OrgCandidate[]> {
  try {
    const body = await serviceJson<{ ok: true; orgs: readonly OrgCandidate[] }>(
      `${serviceUrl}/v1/orgs`,
      token,
    );
    return body.orgs;
  } catch {
    return [];
  }
}

export async function fetchAppCandidates(
  serviceUrl: string,
  org: string,
  token: string,
): Promise<readonly AppSummary[]> {
  try {
    const body = await serviceJson<AppsListResponse>(
      `${serviceUrl}/v1/orgs/${encodeURIComponent(org)}/apps`,
      token,
    );
    return body.data.apps;
  } catch {
    return [];
  }
}

export async function fetchEnvCandidates(
  serviceUrl: string,
  org: string,
  app: string,
  token: string,
): Promise<readonly EnvSummary[]> {
  try {
    const body = await serviceJson<EnvsListResponse>(
      `${serviceUrl}/v1/orgs/${encodeURIComponent(org)}/apps/${encodeURIComponent(app)}/envs`,
      token,
    );
    return body.data.envs;
  } catch {
    return [];
  }
}

// --- table styling -------------------------------------------------------------

export const ACTIVE_GREEN: RGB = [34, 197, 94];
export const DIM_GRAY: RGB = [115, 115, 115];
/** Archived-state amber, distinct from the plain active/inactive green/dim (deployments list/inspect). */
export const ARCHIVED_AMBER: RGB = [245, 158, 11];
export const ACCESS_CHIP_COLORS: Record<string, RGB> = {
  'owner-only': DIM_GRAY,
  'org-members': [56, 189, 248], // sky-400
  authenticated: [167, 139, 250], // violet-400
  customers: [45, 212, 191], // teal-400
};

export function dimText(text: string, stream: { isTTY?: boolean }): string {
  return paint(DIM_GRAY, text, detectColorMode(stream));
}

/** The stdout-derived table options every resource `list` view renders with. */
export function stdoutTableOptions(): TableOptions {
  return {
    color: detectColorMode(process.stdout),
    glyph: detectGlyphMode(),
    maxTableWidth: process.stdout.columns,
  };
}
