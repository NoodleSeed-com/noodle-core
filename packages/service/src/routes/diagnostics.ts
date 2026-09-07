import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DeployAuthGate } from '@noodle-borg/control-plane/portable';
import { sendJson } from '@noodle-borg/transport-http';
import { type InspectResponse, inspectServiceDeployment } from '../developer-mcp/inspection.js';
import { baseFromRequest } from '../http-util.js';
import { endpointUrlOptionsForOrg } from '../mcp-public-routing.js';
import type { ServiceOptions } from '../options.js';
import type { ServerRegistry } from '../registry.js';
import type { ControlPlaneStore, TenantRef } from '../store.js';
import { authorizeTenantControl, developerGrantRouteAccess } from './control-plane.js';

export async function handleInspect(
  req: IncomingMessage,
  res: ServerResponse,
  registry: ServerRegistry,
  gate: DeployAuthGate,
  controlPlane: ControlPlaneStore,
  tenant: TenantRef,
  options: ServiceOptions,
): Promise<void> {
  const allowed = await authorizeTenant(req, res, gate, controlPlane, tenant, options);
  if (!allowed) return;
  const endpointOptions = await endpointUrlOptionsForOrg(options, controlPlane, tenant.org);
  const body = await inspectServiceDeployment(
    registry,
    tenant,
    options.publicBaseUrl ?? baseFromRequest(req, options.tls ?? {}),
    endpointOptions,
  );
  if (body === undefined) return sendJson(res, 404, { error: 'no active deployment' });
  return sendJson(res, 200, body);
}

export async function handleHostedSmoke(
  req: IncomingMessage,
  res: ServerResponse,
  registry: ServerRegistry,
  gate: DeployAuthGate,
  controlPlane: ControlPlaneStore,
  tenant: TenantRef,
  options: ServiceOptions,
): Promise<void> {
  const allowed = await authorizeTenant(req, res, gate, controlPlane, tenant, options);
  if (!allowed) return;
  const endpointOptions = await endpointUrlOptionsForOrg(options, controlPlane, tenant.org);
  const inspected = await inspectServiceDeployment(
    registry,
    tenant,
    options.publicBaseUrl ?? baseFromRequest(req, options.tls ?? {}),
    endpointOptions,
  );
  if (inspected === undefined) return sendJson(res, 404, { error: 'no active deployment' });
  return sendJson(res, 200, smokeBody(inspected));
}

async function authorizeTenant(
  req: IncomingMessage,
  res: ServerResponse,
  gate: DeployAuthGate,
  controlPlane: ControlPlaneStore,
  tenant: TenantRef,
  options: ServiceOptions,
): Promise<boolean> {
  return (
    (await authorizeTenantControl(
      req,
      res,
      gate,
      controlPlane,
      tenant.org,
      developerGrantRouteAccess(options.developerGrantStore, 'cloud:read'),
    )) !== false
  );
}

function smokeBody(inspected: InspectResponse): SmokeResponse {
  const checks: SmokeCheck[] = [
    { level: 'PASS', name: 'Deployment', message: 'active deployment found' },
    inspected.health.missingSecrets.length === 0
      ? { level: 'PASS', name: 'Config', message: 'all required managed config is present' }
      : {
          level: 'FAIL',
          name: 'Config',
          message: `missing managed secrets: ${inspected.health.missingSecrets.join(', ')}`,
        },
    {
      level: inspected.surface.tools.length > 0 ? 'PASS' : 'WARN',
      name: 'Surface',
      message:
        `${inspected.surface.tools.length} tools, ${inspected.surface.resources.length} resources, ` +
        `${inspected.surface.prompts.length} prompts, ${inspected.surface.widgets.length} widgets`,
    },
    {
      level: inspected.surface.compatibility.mcpApps === 'pass' ? 'PASS' : 'WARN',
      name: 'MCP Apps',
      message:
        inspected.surface.compatibility.mcpApps === 'pass'
          ? 'widget metadata is structurally ready'
          : 'widget metadata needs review',
    },
  ];
  return {
    ok: checks.every((check) => check.level !== 'FAIL'),
    target: inspected.target,
    checks,
    external: externalCommands(inspected.deployment.endpointUrl),
  };
}

function externalCommands(endpointUrl: string): {
  readonly inspector: string;
  readonly mcpjam: string;
} {
  return {
    inspector: `npx @modelcontextprotocol/inspector ${endpointUrl}`,
    mcpjam: `npx @mcpjam/cli@latest server probe --url ${endpointUrl} --quiet --format json`,
  };
}

type SmokeLevel = 'PASS' | 'WARN' | 'FAIL';

interface SmokeCheck {
  readonly level: SmokeLevel;
  readonly name: string;
  readonly message: string;
}

interface SmokeResponse {
  readonly ok: boolean;
  readonly target: TenantRef;
  readonly checks: readonly SmokeCheck[];
  readonly external: { readonly inspector: string; readonly mcpjam: string };
}
