/**
 * Org-scoped read routes: the deployments list and the audit-event query (moved verbatim from
 * `control-plane.ts` for the size gate). The deployments list hides archived apps by default;
 * `?archived=true` includes them with their `archivedAt` stamps (ADR 0117 §2).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DeployAuthGate } from '@noodle-borg/control-plane/portable';
import { sendJson } from '@noodle-borg/transport-http';
import { DeploymentResponseSchema } from '@noodle-borg/wire-contracts';
import type { ResolveEndpointUrlOptions } from '../mcp-public-routing.js';
import type { DeveloperGrantStore } from '../oauth/developer-grant.js';
import type { ServerRegistry } from '../registry.js';
import type { AuditSink, AuditStore } from '../store/audit.js';
import type { ControlPlaneStore } from '../store.js';
import { sendContract } from './apps.js';
import { authorizeTenantControl, developerGrantRouteAccess } from './control-plane.js';
import { withEndpointUrl } from './endpoint-enrichment.js';

export async function handleDeployments(
  req: IncomingMessage,
  res: ServerResponse,
  registry: ServerRegistry,
  gate: DeployAuthGate,
  controlPlane: ControlPlaneStore,
  ref: { org: string },
  url: URL,
  endpointBase: string,
  resolveEndpointOptions: ResolveEndpointUrlOptions,
  developerGrants?: DeveloperGrantStore,
): Promise<void> {
  const app = url.searchParams.get('app') ?? undefined;
  const env = url.searchParams.get('env') ?? undefined;
  const authorized = await authorizeTenantControl(
    req,
    res,
    gate,
    controlPlane,
    ref.org,
    developerGrantRouteAccess(developerGrants, 'cloud:read'),
  );
  if (authorized === false) return;
  const includeArchived = url.searchParams.get('archived') === 'true';
  try {
    const deployments = await registry.listDeployments({
      org: ref.org,
      ...(app !== undefined ? { app } : {}),
      ...(env !== undefined ? { env } : {}),
      ...(includeArchived ? { includeArchived: true } : {}),
    });
    const endpointOptions = await resolveEndpointOptions(ref.org);
    return sendJson(res, 200, {
      ok: true,
      deployments: deployments.map((record) =>
        withEndpointUrl(record, endpointBase, endpointOptions),
      ),
    });
  } catch (error) {
    return sendJson(res, 400, { error: (error as Error).message });
  }
}

/**
 * The single-deployment item route: `GET /v1/orgs/{org}/deployments/{deploymentId}` (deployment
 * inspect). Membership-gated exactly like the `apps`/`envs` item routes (`authorizeTenantControl`); a
 * deployment that exists but belongs to a different org 404s identically to an unknown id — cross-org
 * existence must never leak. Archived deployments ARE returned (with `archivedAt` set): inspecting
 * history, including an archived deployment, is the point of this lookup.
 */
export async function handleDeploymentItem(
  req: IncomingMessage,
  res: ServerResponse,
  registry: ServerRegistry,
  gate: DeployAuthGate,
  controlPlane: ControlPlaneStore,
  ref: { org: string; deploymentId: string },
  endpointBase: string,
  resolveEndpointOptions: ResolveEndpointUrlOptions,
  developerGrants?: DeveloperGrantStore,
): Promise<void> {
  const authorized = await authorizeTenantControl(
    req,
    res,
    gate,
    controlPlane,
    ref.org,
    developerGrantRouteAccess(developerGrants, 'cloud:read'),
  );
  if (authorized === false) return;
  let deployment: Awaited<ReturnType<ServerRegistry['getDeployment']>>;
  try {
    deployment = await registry.getDeployment(ref.org, ref.deploymentId);
  } catch (error) {
    return sendJson(res, 400, { error: (error as Error).message });
  }
  if (deployment === undefined) return sendJson(res, 404, { error: 'unknown deployment' });
  const endpointOptions = await resolveEndpointOptions(ref.org);
  const enriched = withEndpointUrl(deployment, endpointBase, endpointOptions);
  return sendContract(res, () => DeploymentResponseSchema.parse({ ok: true, data: enriched }));
}

export async function handleAuditEvents(
  req: IncomingMessage,
  res: ServerResponse,
  gate: DeployAuthGate,
  controlPlane: ControlPlaneStore,
  audit: AuditSink,
  ref: { org: string },
  url: URL,
  developerGrants?: DeveloperGrantStore,
): Promise<void> {
  const env = optionalQuery(url, 'env');
  const identity = await authorizeTenantControl(
    req,
    res,
    gate,
    controlPlane,
    ref.org,
    developerGrantRouteAccess(developerGrants, 'cloud:read'),
  );
  if (identity === false) return;
  if (!isAuditStore(audit)) {
    return sendJson(res, 409, {
      ok: false,
      error: 'audit events require an audit store capability',
    });
  }
  const limit = parseAuditLimit(url.searchParams.get('limit'));
  if (limit === false)
    return sendJson(res, 400, { error: '"limit" must be an integer from 1 to 100' });
  try {
    const app = optionalQuery(url, 'app');
    const eventType = optionalQuery(url, 'eventType');
    const events = await audit.list({
      org: ref.org,
      ...(app !== undefined ? { app } : {}),
      ...(env !== undefined ? { env } : {}),
      ...(eventType !== undefined ? { eventType } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    await audit.emit({
      eventType: 'audit.events.queried',
      org: ref.org,
      ...(app !== undefined ? { app } : {}),
      ...(env !== undefined ? { env } : {}),
      decision: 'allow',
      status: 200,
      actorSubject: identity.subject,
      ...(identity.email !== undefined ? { actorEmail: identity.email } : {}),
      details: {
        ...(eventType !== undefined ? { eventType } : {}),
        ...(limit !== undefined ? { limit } : {}),
        resultCount: events.length,
      },
    });
    return sendJson(res, 200, { ok: true, events });
  } catch (error) {
    return sendJson(res, 400, { error: (error as Error).message });
  }
}

function isAuditStore(audit: AuditSink): audit is AuditStore {
  return 'list' in audit && typeof audit.list === 'function';
}

function optionalQuery(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key);
  return value === null || value.trim() === '' ? undefined : value;
}

function parseAuditLimit(value: string | null): number | undefined | false {
  if (value === null || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) return false;
  return parsed;
}
