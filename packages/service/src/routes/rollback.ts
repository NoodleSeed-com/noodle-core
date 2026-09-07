import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DeployAuthGate } from '@noodle-borg/control-plane/portable';
import { rollbackDeploymentOperation } from '@noodle-borg/control-plane/portable';
import { readJsonBody, sendJson } from '@noodle-borg/transport-http';
import { baseFromRequest, sendForbidden } from '../http-util.js';
import { endpointUrlOptionsForOrg } from '../mcp-public-routing.js';
import type { ServiceOptions } from '../options.js';
import type { ServerRegistry } from '../registry.js';
import type { AuditSink } from '../store/audit.js';
import type { ControlPlaneStore, TenantRef } from '../store.js';
import { authorizeTenantControl, developerGrantRouteAccess } from './control-plane.js';

export async function handleRollback(
  req: IncomingMessage,
  res: ServerResponse,
  registry: ServerRegistry,
  gate: DeployAuthGate,
  controlPlane: ControlPlaneStore,
  audit: AuditSink,
  maxBody: number,
  tenant: TenantRef,
  options: ServiceOptions,
): Promise<void> {
  const identity = await authorizeTenantControl(
    req,
    res,
    gate,
    controlPlane,
    tenant.org,
    developerGrantRouteAccess(options.developerGrantStore, 'deployments:rollback'),
  );
  if (identity === false) return;
  const body = await readJsonBody(req, maxBody);
  if (!body.ok) return sendJson(res, body.status, { error: body.error });
  const parsed = body.value as { deploymentId?: unknown; reason?: unknown };
  if (typeof parsed.deploymentId !== 'string' || parsed.deploymentId.trim() === '') {
    return sendJson(res, 400, { error: '"deploymentId" is required' });
  }
  if (parsed.reason !== undefined && typeof parsed.reason !== 'string') {
    return sendJson(res, 400, { error: '"reason" must be a string' });
  }
  const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : undefined;
  if (reason !== undefined && (reason.length === 0 || reason.length > 500)) {
    return sendJson(res, 400, {
      error: '"reason" must be a non-empty string of at most 500 characters',
    });
  }
  const base = options.publicBaseUrl ?? baseFromRequest(req, options.tls ?? {});
  const endpointOptions = await endpointUrlOptionsForOrg(options, controlPlane, tenant.org);
  const result = await rollbackDeploymentOperation(
    { registry, controlPlane, audit },
    {
      actor: identity,
      target: tenant,
      deploymentId: parsed.deploymentId,
      ...(reason !== undefined ? { reason } : {}),
      publicBaseUrl: base,
      endpointOptions,
    },
  );
  if (!result.ok) {
    if (result.status === 403) return sendForbidden(res, result.code);
    return sendJson(res, result.status, {
      ok: false,
      code: result.code,
      error: result.message,
    });
  }
  return sendJson(res, 200, { ok: true, ...result.view });
}
