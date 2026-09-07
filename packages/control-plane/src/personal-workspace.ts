import type { ControlPlaneIdentity, OrganizationStore, OrgRecord } from './contracts.js';
import { personalOrgSlug } from './organization-helpers.js';

export interface PersonalWorkspace {
  readonly org: OrgRecord;
  readonly created: boolean;
}

export async function ensurePersonalWorkspace(
  controlPlane: Pick<OrganizationStore, 'provisionPersonalWorkspace'>,
  identity: ControlPlaneIdentity,
): Promise<PersonalWorkspace> {
  const slug = personalOrgSlug(identity);
  return controlPlane.provisionPersonalWorkspace({
    slug,
    displayName: identity.email,
    ...(identity.identityIssuer === undefined ? {} : { identityIssuer: identity.identityIssuer }),
    subject: identity.subject,
    email: identity.email,
    ...(identity.givenName !== undefined ? { firstName: identity.givenName } : {}),
  });
}
