import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ControlPlaneIdentity } from '@noodle-borg/control-plane/portable';
import { sendJson } from '@noodle-borg/transport-http';
import { admitBusinessTarget, authorizeBusinessApi } from '../business-api-admission.js';
import {
  type BusinessPermission,
  type BusinessStaffGrant,
  businessGrantAllows,
  type InstallationScope,
  type SolutionInstallation,
} from '../business-information/portable.js';
import { sendForbidden } from '../http-util.js';
import type { BusinessInformationRouteDeps } from './business-information.js';
import type { SolutionInstallationRef } from './business-information-paths.js';

export async function requireIdentity(
  req: IncomingMessage,
  res: ServerResponse,
  deps: BusinessInformationRouteDeps,
): Promise<ControlPlaneIdentity | false> {
  return authorizeBusinessApi(req, res, deps);
}

export async function requireInstallationGrant(
  res: ServerResponse,
  ref: SolutionInstallationRef,
  identity: ControlPlaneIdentity,
  deps: BusinessInformationRouteDeps,
  permission?: BusinessPermission,
): Promise<
  | {
      installation: SolutionInstallation;
      scope: InstallationScope;
      grant: BusinessStaffGrant;
    }
  | undefined
> {
  if (ref.installationId === undefined) return undefined;
  const installation = await deps.store.getInstallationById(ref.org, ref.installationId);
  if (installation === undefined) {
    sendJson(res, 404, { error: 'installation not found' });
    return undefined;
  }
  const grant = await resolveBusinessStaffGrant(deps, installation.scope, identity.subject);
  if (grant?.revokedAt !== undefined || grant === undefined) {
    sendForbidden(res, 'business grant required');
    return undefined;
  }
  if (permission && !businessGrantAllows(grant, permission)) {
    sendForbidden(res, `business permission required: ${permission}`);
    return undefined;
  }
  if (!(await admitBusinessTarget(res, installation.scope))) return undefined;
  return { installation, scope: installation.scope, grant };
}

export async function resolveBusinessStaffGrant(
  deps: BusinessInformationRouteDeps,
  scope: InstallationScope,
  subject: string,
): Promise<BusinessStaffGrant | undefined> {
  return deps.store.staff.resolve(scope, subject);
}

export async function requireInstallationPermission(
  res: ServerResponse,
  ref: SolutionInstallationRef,
  identity: ControlPlaneIdentity,
  permission: BusinessPermission,
  deps: BusinessInformationRouteDeps,
): ReturnType<typeof requireInstallationGrant> {
  return requireInstallationGrant(res, ref, identity, deps, permission);
}

/** Local store effects only: respond after the authority transaction commits. */
export async function runBusinessStaffOperation<T>(
  deps: BusinessInformationRouteDeps,
  scope: InstallationScope,
  actor: string,
  permission: BusinessPermission,
  operation: () => Promise<T>,
): Promise<T> {
  return deps.store.staff.run(scope, actor, permission, operation);
}
