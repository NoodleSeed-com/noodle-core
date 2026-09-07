import type { ControlPlaneIdentity } from '@noodle-borg/control-plane/portable';
import { type DeveloperCapability, developerResourcePath } from '@noodle-borg/developer-mcp';
import {
  activeDeveloperGrant,
  type DeveloperAccessGrant,
  type DeveloperGrantStore,
} from '../oauth/developer-grant.js';
import type { ControlPlaneStore } from '../store.js';

export interface DeveloperGrantAuthorizationContext {
  readonly grants: DeveloperGrantStore;
  readonly controlPlane: ControlPlaneStore;
  readonly org: string;
  readonly capability: DeveloperCapability;
  /** The developer resources this route serves; the grant's own resource must be one of them. */
  readonly resourcePaths: ReadonlySet<string>;
  readonly now?: () => string;
}

export async function authorizeDeveloperGrant(
  identity: ControlPlaneIdentity,
  context: DeveloperGrantAuthorizationContext,
): Promise<boolean> {
  if (identity.developerGrantId === undefined || identity.oauthClientId === undefined) return false;
  const grant = await activeDeveloperGrantForIdentity(identity, context.grants, {
    at: context.now?.() ?? new Date().toISOString(),
  });
  if (grant === undefined) return false;
  const grantPath = developerResourcePath(grant.resource);
  if (grantPath === undefined || !context.resourcePaths.has(grantPath)) return false;
  if (!grant.capabilities.includes(context.capability)) return false;
  const member = await context.controlPlane.getOrgMember({
    org: context.org,
    subject: identity.subject,
  });
  if (member === undefined) return false;
  return context.capability !== 'deployments:rollback' || member.role === 'owner';
}

export async function activeDeveloperGrantForIdentity(
  identity: ControlPlaneIdentity,
  grants: DeveloperGrantStore,
  options: { readonly at?: string; readonly resource?: string } = {},
): Promise<DeveloperAccessGrant | undefined> {
  if (identity.developerGrantId === undefined || identity.oauthClientId === undefined)
    return undefined;
  const grant = await grants.get(identity.developerGrantId);
  return grant !== undefined &&
    activeDeveloperGrant(grant, {
      subject: identity.subject,
      clientId: identity.oauthClientId,
      resource: options.resource ?? grant.resource,
      at: options.at ?? new Date().toISOString(),
    })
    ? grant
    : undefined;
}
