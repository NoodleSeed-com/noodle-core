import { isAlertRuleId } from '../store/alert-rules.js';
import {
  DEPLOYMENT_ID_PATTERN,
  type TenantRef,
  validateDomain,
  validateSlug,
  validateTenantRef,
} from '../store.js';

function matchPath<T>(
  pathname: string,
  pattern: RegExp,
  decode: (match: RegExpExecArray) => T | undefined,
): T | undefined {
  const match = pattern.exec(pathname);
  if (!match) return undefined;
  try {
    return decode(match);
  } catch {
    return undefined;
  }
}

function decodeSegment(match: RegExpExecArray, index: number): string {
  return decodeURIComponent(match[index] as string);
}

function orgRef(match: RegExpExecArray): { org: string } {
  return { org: validateSlug('org', decodeSegment(match, 1)) };
}

function appRef(match: RegExpExecArray): { org: string; app: string } {
  return {
    org: validateSlug('org', decodeSegment(match, 1)),
    app: validateSlug('app', decodeSegment(match, 2)),
  };
}

function tenantRef(match: RegExpExecArray): TenantRef {
  return validateTenantRef({
    org: decodeSegment(match, 1),
    app: decodeSegment(match, 2),
    env: decodeSegment(match, 3),
  });
}

export function parseTenantDeployPath(pathname: string): TenantRef | undefined {
  return matchPath(
    pathname,
    /^\/v1\/orgs\/([^/]+)\/apps\/([^/]+)\/envs\/([^/]+)\/deploy$/,
    tenantRef,
  );
}

export function parseTenantDeployPreflightPath(pathname: string): TenantRef | undefined {
  return parseTenantActionPath(pathname, 'deploy/preflight');
}

export function parseTenantAuthDoctorPath(pathname: string): TenantRef | undefined {
  return parseTenantActionPath(pathname, 'auth/doctor');
}

export function parseGoogleWorkloadIdentityPath(pathname: string): TenantRef | undefined {
  return parseTenantActionPath(pathname, 'auth/google-workload-identity');
}

export function parseGoogleWorkloadIdentityDoctorPath(pathname: string): TenantRef | undefined {
  return parseTenantActionPath(pathname, 'auth/google-workload-identity/doctor');
}

export function parseTenantRollbackPath(pathname: string): TenantRef | undefined {
  return parseTenantActionPath(pathname, 'rollback');
}

export function parseTenantAssetPreflightPath(pathname: string): TenantRef | undefined {
  return matchPath(
    pathname,
    /^\/v1\/orgs\/([^/]+)\/apps\/([^/]+)\/envs\/([^/]+)\/assets\/preflight$/,
    tenantRef,
  );
}

/** Match the single-org item path `/v1/orgs/{org}` (org rename lives here as `PATCH`). */
export function parseOrgPath(pathname: string): { org: string } | undefined {
  return matchPath(pathname, /^\/v1\/orgs\/([^/]+)$/, orgRef);
}

/** Match the apps-list collection path `/v1/orgs/{org}/apps` (the `apps` resource, GET only). */
export function parseAppsPath(pathname: string): { org: string } | undefined {
  return matchPath(pathname, /^\/v1\/orgs\/([^/]+)\/apps$/, orgRef);
}

/** Match the single-app item path `/v1/orgs/{org}/apps/{app}` (app inspect, GET only). */
export function parseAppItemPath(pathname: string): { org: string; app: string } | undefined {
  return matchPath(pathname, /^\/v1\/orgs\/([^/]+)\/apps\/([^/]+)$/, appRef);
}

/**
 * Match the envs-list collection path `/v1/orgs/{org}/apps/{app}/envs` (the `envs` resource, GET
 * only). A bare `/envs` with nothing after it — every other `.../envs/{env}/<action>` route (deploy,
 * status, access, rollback, inspect, smoke, logs, assets/preflight, secrets, variables) requires an
 * extra path segment, so this pattern can never collide with them.
 */
export function parseEnvsPath(pathname: string): { org: string; app: string } | undefined {
  return matchPath(pathname, /^\/v1\/orgs\/([^/]+)\/apps\/([^/]+)\/envs$/, appRef);
}

/** Match the single-env item path `/v1/orgs/{org}/apps/{app}/envs/{env}` (env inspect, GET only). */
export function parseEnvItemPath(pathname: string): TenantRef | undefined {
  return matchPath(pathname, /^\/v1\/orgs\/([^/]+)\/apps\/([^/]+)\/envs\/([^/]+)$/, tenantRef);
}

export function parseMembersPath(pathname: string): { org: string; subject?: string } | undefined {
  return (
    matchPath(pathname, /^\/v1\/orgs\/([^/]+)\/members$/, orgRef) ??
    matchPath(pathname, /^\/v1\/orgs\/([^/]+)\/members\/([^/]+)$/, (match) => ({
      ...orgRef(match),
      subject: decodeSegment(match, 2),
    }))
  );
}

/** `/v1/orgs/{org}/domains` and `/v1/orgs/{org}/domains/{domain}`. */
export function parseOrgDomainsPath(
  pathname: string,
): { org: string; domain?: string } | undefined {
  return (
    matchPath(pathname, /^\/v1\/orgs\/([^/]+)\/domains$/, orgRef) ??
    matchPath(pathname, /^\/v1\/orgs\/([^/]+)\/domains\/([^/]+)$/, (match) => ({
      ...orgRef(match),
      domain: validateDomain(decodeSegment(match, 2)),
    }))
  );
}

export function parseInvitationsPath(
  pathname: string,
): { org: string; token?: string; action?: 'accept' } | undefined {
  return (
    matchPath(pathname, /^\/v1\/orgs\/([^/]+)\/invitations$/, orgRef) ??
    matchPath(pathname, /^\/v1\/orgs\/([^/]+)\/invitations\/([^/]+)\/accept$/, (match) => ({
      ...orgRef(match),
      token: decodeSegment(match, 2),
      action: 'accept',
    }))
  );
}

export function parseOrgOpenAIAppsChallengePath(pathname: string): { org: string } | undefined {
  return matchPath(pathname, /^\/v1\/orgs\/([^/]+)\/openai-apps-challenge$/, orgRef);
}

export function parseOrgMcpSubdomainPath(pathname: string): { org: string } | undefined {
  return matchPath(pathname, /^\/v1\/orgs\/([^/]+)\/mcp-subdomain$/, orgRef);
}

export function parseDeploymentsPath(pathname: string): { org: string } | undefined {
  return matchPath(pathname, /^\/v1\/orgs\/([^/]+)\/deployments$/, orgRef);
}

/**
 * Match the single-deployment item path `/v1/orgs/{org}/deployments/{deploymentId}` (deployment
 * inspect, GET only). Unlike `app`/`env`, a `deploymentId` is not a slug — it's a slug plus a random
 * hex suffix minted by `mintDeploymentId` (e.g. `hello-world-b9b4ec7f`) — so validate loosely against
 * `DEPLOYMENT_ID_PATTERN` instead of `validateSlug`.
 */
export function parseDeploymentItemPath(
  pathname: string,
): { org: string; deploymentId: string } | undefined {
  return matchPath(pathname, /^\/v1\/orgs\/([^/]+)\/deployments\/([^/]+)$/, (match) => {
    const org = validateSlug('org', decodeSegment(match, 1));
    const deploymentId = decodeSegment(match, 2);
    if (!DEPLOYMENT_ID_PATTERN.test(deploymentId)) return undefined;
    return { org, deploymentId };
  });
}

/** Match `/v1/orgs/{org}/deployments/{deploymentId}/package` before the deployment item route. */
export function parseDeploymentPackagePath(
  pathname: string,
): { org: string; deploymentId: string } | undefined {
  return matchPath(pathname, /^\/v1\/orgs\/([^/]+)\/deployments\/([^/]+)\/package$/, (match) => {
    const org = validateSlug('org', decodeSegment(match, 1));
    const deploymentId = decodeSegment(match, 2);
    if (!DEPLOYMENT_ID_PATTERN.test(deploymentId)) return undefined;
    return { org, deploymentId };
  });
}

export function parseAuditEventsPath(pathname: string): { org: string } | undefined {
  return matchPath(pathname, /^\/v1\/orgs\/([^/]+)\/audit\/events$/, orgRef);
}

/** App-scoped soft-delete routes (ADR 0117): `/v1/orgs/{org}/apps/{app}/(archive|restore)`. */
export interface AppRouteRef {
  readonly org: string;
  readonly app: string;
}

export function parseAppArchivePath(pathname: string): AppRouteRef | undefined {
  return parseAppActionPath(pathname, 'archive');
}

export function parseAppRestorePath(pathname: string): AppRouteRef | undefined {
  return parseAppActionPath(pathname, 'restore');
}

export function parseProductionEnvironmentPath(pathname: string): AppRouteRef | undefined {
  return parseAppActionPath(pathname, 'production-environment');
}

function parseAppActionPath(
  pathname: string,
  action: 'archive' | 'restore' | 'production-environment',
): AppRouteRef | undefined {
  return matchPath(pathname, new RegExp(`^/v1/orgs/([^/]+)/apps/([^/]+)/${action}$`), appRef);
}

export function parseTenantStatusPath(pathname: string): TenantRef | undefined {
  return parseTenantActionPath(pathname, 'status');
}

export function parseTenantInspectPath(pathname: string): TenantRef | undefined {
  return parseTenantActionPath(pathname, 'inspect');
}

export function parseTenantSmokePath(pathname: string): TenantRef | undefined {
  return parseTenantActionPath(pathname, 'smoke');
}

export function parseTenantAccessPath(pathname: string): TenantRef | undefined {
  return parseTenantActionPath(pathname, 'access');
}

export function parseTenantDeploymentLockPath(pathname: string): TenantRef | undefined {
  return parseTenantActionPath(pathname, 'deployment-lock');
}

export function parseTenantLogsPath(pathname: string): TenantRef | undefined {
  return parseTenantActionPath(pathname, 'logs');
}

export function parseTenantMetricsPath(pathname: string): TenantRef | undefined {
  return parseTenantActionPath(pathname, 'metrics');
}

export function parseTenantEventsPath(pathname: string): TenantRef | undefined {
  return parseTenantActionPath(pathname, 'events');
}

export function parseIntentCapturePath(pathname: string): TenantRef | undefined {
  return parseTenantActionPath(pathname, 'intent-capture');
}

export function parseTenantIntentsPath(pathname: string): TenantRef | undefined {
  return parseTenantActionPath(pathname, 'intents');
}

/** `GET|POST /v1/orgs/{org}/apps/{app}/envs/{env}/alerts` — the alert-rule collection (E2, ADR 0130). */
export function parseTenantAlertsPath(pathname: string): TenantRef | undefined {
  return parseTenantActionPath(pathname, 'alerts');
}

/** `DELETE .../alerts/{id}` — one alert rule. Non-UUID ids never match (they cannot exist). */
export function parseTenantAlertItemPath(
  pathname: string,
): { readonly ref: TenantRef; readonly id: string } | undefined {
  return matchPath(
    pathname,
    /^\/v1\/orgs\/([^/]+)\/apps\/([^/]+)\/envs\/([^/]+)\/alerts\/([^/]+)$/,
    tenantAlertRef,
  );
}

/** `POST .../alerts/{id}/test` — synthetic test-fire through the rule's webhook (E2, ADR 0130). */
export function parseTenantAlertTestPath(
  pathname: string,
): { readonly ref: TenantRef; readonly id: string } | undefined {
  return matchPath(
    pathname,
    /^\/v1\/orgs\/([^/]+)\/apps\/([^/]+)\/envs\/([^/]+)\/alerts\/([^/]+)\/test$/,
    tenantAlertRef,
  );
}

function tenantAlertRef(
  match: RegExpExecArray,
): { readonly ref: TenantRef; readonly id: string } | undefined {
  const id = decodeSegment(match, 4);
  if (!isAlertRuleId(id)) return undefined;
  return { ref: tenantRef(match), id };
}

/** `GET /v1/orgs/{org}/apps/{app}/envs/{env}/sessions/{id}` — the analytics session view (ADR 0121). */
export function parseTenantSessionPath(
  pathname: string,
): { readonly ref: TenantRef; readonly sessionId: string } | undefined {
  return matchPath(
    pathname,
    /^\/v1\/orgs\/([^/]+)\/apps\/([^/]+)\/envs\/([^/]+)\/sessions\/([^/]+)$/,
    (match) => ({
      ref: tenantRef(match),
      sessionId: decodeSegment(match, 4),
    }),
  );
}

/** `GET .../assistant/usage` — scalar-only embedded assistant engagement and model usage. */
export function parseTenantAssistantUsagePath(pathname: string): TenantRef | undefined {
  return matchPath(
    pathname,
    /^\/v1\/orgs\/([^/]+)\/apps\/([^/]+)\/envs\/([^/]+)\/assistant\/usage$/,
    tenantRef,
  );
}

export function parseTenantActionPath(
  pathname: string,
  action:
    | 'status'
    | 'deploy/preflight'
    | 'access'
    | 'deployment-lock'
    | 'rollback'
    | 'inspect'
    | 'smoke'
    | 'logs'
    | 'metrics'
    | 'events'
    | 'intent-capture'
    | 'intents'
    | 'alerts'
    | 'auth/doctor'
    | 'auth/google-workload-identity'
    | 'auth/google-workload-identity/doctor',
): TenantRef | undefined {
  return matchPath(
    pathname,
    new RegExp(`^/v1/orgs/([^/]+)/apps/([^/]+)/envs/([^/]+)/${action}$`),
    tenantRef,
  );
}
