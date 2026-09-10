import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ControlPlaneIdentity } from '@noodle-borg/control-plane/portable';
import { readJsonBody, sendJson } from '@noodle-borg/transport-http';
import { SolutionInstallationActivateRequestSchema } from '@noodle-borg/wire-contracts';
import type { SolutionInstallation } from '../business-information/contracts.js';
import { sendForbidden } from '../http-util.js';
import {
  type BusinessInformationRouteDeps,
  invalid,
  methodNotAllowed,
  requireInstallationPermission,
} from './business-information.js';
import type { SolutionInstallationRef } from './business-information-paths.js';
import { installationToWire } from './business-information-wire.js';
import { canManageMembers } from './org-admin.js';

export function stableInstallationId(org: string, app: string, env: string): string {
  return `ins-${createHash('sha256').update(`${org}\0${app}\0${env}`).digest('hex').slice(0, 24)}`;
}

/** Read current activation authority; intake is an independent operator setting. */
export async function installationProjection(
  installation: SolutionInstallation,
  role: Parameters<typeof installationToWire>[1],
  identity: ControlPlaneIdentity,
  deps: BusinessInformationRouteDeps,
): Promise<ReturnType<typeof installationToWire>> {
  const state = (await deps.readInstallationActivation?.(installation)) ?? 'unavailable';
  const canRetry =
    state === 'pending' &&
    deps.activateInstallation !== undefined &&
    role === 'administrator' &&
    (await canManageMembers(deps.controlPlane, installation.scope.org, identity));
  return {
    ...installationToWire(installation, role),
    activation: state === 'pending' ? { state, canRetry } : { state, canRetry: false },
  };
}

export async function retryInstallationActivation(
  req: IncomingMessage,
  res: ServerResponse,
  ref: SolutionInstallationRef,
  identity: ControlPlaneIdentity,
  deps: BusinessInformationRouteDeps,
): Promise<void> {
  if (req.method !== 'POST') return methodNotAllowed(res);
  const authorized = await requireInstallationPermission(
    res,
    ref,
    identity,
    'installation:administer',
    deps,
  );
  if (!authorized) return;
  if (!(await canManageMembers(deps.controlPlane, ref.org, identity)))
    return sendForbidden(res, 'org owner required');
  const body = await readJsonBody(req, deps.maxBody);
  if (!body.ok) return sendJson(res, body.status, { error: body.error });
  const parsed = SolutionInstallationActivateRequestSchema.safeParse(body.value);
  if (!parsed.success) return invalid(res, parsed.error);
  const result = await deps.activateInstallation?.({
    installation: authorized.installation,
    actor: identity,
  });
  if (!result?.ok)
    return sendJson(res, result?.status ?? 503, {
      ok: false,
      code: result?.code ?? 'installation_activation_unavailable',
      error:
        result?.message ?? 'The installation is saved. Retry activation when the service is ready.',
      installationId: authorized.scope.installationId,
    });
  const installation = await installationProjection(
    authorized.installation,
    authorized.grant.role,
    identity,
    deps,
  );
  if (installation.activation?.state !== 'ready')
    return sendJson(res, 503, {
      ok: false,
      code: 'installation_activation_unavailable',
      error:
        'The installation is saved, but readiness could not be established. Retry activation after the service setup is restored.',
      installationId: authorized.scope.installationId,
    });
  return sendJson(res, 200, { ok: true, data: { installation } });
}
