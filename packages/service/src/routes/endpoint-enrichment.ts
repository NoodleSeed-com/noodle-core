/**
 * Route-layer endpoint enrichment for the resource read surface (CodeRabbit finding, 2026-07-05):
 * `DeploymentSummary.endpointUrl` is derived from the REQUEST's public base (it is a wire concern,
 * not stored state — the same deployment answers on whatever host the service is reached through),
 * so the store/aggregation layers stay base-agnostic and the routes stamp the URL on the way out.
 * Used by the apps/envs facing deployments and the deployments collection/item responses, keeping
 * the whole resource family consistent with what `deploy`/`status` already report.
 */
import type { IncomingMessage } from 'node:http';
import { type EndpointUrlOptions, tenantMcpUrl } from '@noodle-borg/module';
import type { AppSummary, DeploymentSummary, EnvSummary } from '../store.js';

/** Per-request endpoint base: explicit `publicBaseUrl` wins, else the request's own origin. */
export type ResolveEndpointBase = (req: IncomingMessage) => string;
export type { EndpointUrlOptions } from '@noodle-borg/module';
export { tenantMcpUrl };

/** Stamp `endpointUrl` onto one deployment summary. */
export function withEndpointUrl(
  summary: DeploymentSummary,
  base: string,
  options: EndpointUrlOptions = {},
): DeploymentSummary {
  return {
    ...summary,
    endpointUrl: tenantMcpUrl(
      base,
      { org: summary.orgSlug, app: summary.appSlug, env: summary.environment },
      summary.serverVersion,
      options,
    ),
  };
}

export function appWithEndpointUrl(
  app: AppSummary,
  base: string,
  options: EndpointUrlOptions = {},
): AppSummary {
  return app.latest === undefined
    ? app
    : { ...app, latest: withEndpointUrl(app.latest, base, options) };
}

export function envWithEndpointUrl(
  env: EnvSummary,
  base: string,
  options: EndpointUrlOptions = {},
): EnvSummary {
  return env.latest === undefined
    ? env
    : { ...env, latest: withEndpointUrl(env.latest, base, options) };
}
