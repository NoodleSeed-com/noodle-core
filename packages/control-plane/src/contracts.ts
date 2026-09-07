export type OrgRole = 'owner' | 'developer';

/** The canonical principal bound to a personal workspace must remain that organization's owner. */
export class PersonalWorkspaceOwnerMutationError extends Error {
  readonly code = 'personal_workspace_owner_immutable';

  constructor() {
    super('personal workspace owner is immutable');
    this.name = 'PersonalWorkspaceOwnerMutationError';
  }
}

export interface OrgRecord {
  readonly slug: string;
  readonly displayName?: string;
  readonly createdAt: string;
}

/** One currently routable public MCP hostname label bound to an immutable organization slug. */
export interface ActiveMcpSubdomainClaim {
  readonly mcpSubdomain: string;
  readonly orgSlug: string;
  readonly claimedAt: string;
}

/** Membership-visible organization MCP address and its next self-service change boundary. */
export interface McpSubdomainSetting extends ActiveMcpSubdomainClaim {
  readonly changeAllowedAt?: string;
}

export interface ChangeMcpSubdomainInput {
  readonly org: string;
  readonly mcpSubdomain: string;
  /** Operation-scoped private key. Implementations hash it before persistence. */
  readonly idempotencyKey: string;
  readonly actor: {
    readonly subject: string;
    readonly email?: string;
  };
}

export interface McpSubdomainMutationResult {
  readonly orgSlug: string;
  readonly previousMcpSubdomain: string;
  readonly mcpSubdomain: string;
  readonly changed: boolean;
  readonly replayed: boolean;
  readonly changedAt?: string;
  readonly changeAllowedAt?: string;
  /** True when the canonical audit row committed atomically with this result. */
  readonly auditCommitted: boolean;
}

export interface CreateOrgWithOwnerInput {
  readonly slug: string;
  readonly displayName?: string;
  readonly owner: {
    readonly identityIssuer?: string;
    readonly subject: string;
    readonly email: string;
  };
}

export interface OrgMemberRecord {
  readonly orgSlug: string;
  readonly subject: string;
  readonly email: string;
  readonly role: OrgRole;
  readonly createdAt: string;
}

export interface OrgDomainRecord {
  readonly orgSlug: string;
  readonly domain: string;
  readonly challenge: string;
  readonly createdAt: string;
  readonly verifiedAt?: string;
  readonly lastCheckedAt?: string;
}

export interface OrgOpenAIAppsChallengeRecord {
  readonly orgSlug: string;
  readonly challenge: string;
  readonly updatedAt: string;
  readonly updatedBySubject?: string;
  readonly updatedByEmail?: string;
}

export interface OrgInvitationRecord {
  readonly orgSlug: string;
  readonly email: string;
  readonly role: OrgRole;
  readonly tokenHash: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly createdBySubject: string;
  readonly createdByEmail?: string;
  readonly acceptedAt?: string;
}

export type SignupAllowlistKind = 'subject' | 'domain';

export interface SignupAllowlistRecord {
  readonly kind: SignupAllowlistKind;
  readonly value: string;
  readonly createdAt: string;
  readonly createdBySubject?: string;
}

/** Verified actor authorized to use the deployment and organization control plane. */
export interface ControlPlaneIdentity {
  readonly subject: string;
  readonly email: string;
  readonly identityIssuer?: string;
  readonly givenName?: string;
  readonly superAdmin: boolean;
  readonly developerGrantId?: string;
  readonly oauthClientId?: string;
  readonly authTime?: number;
}

export interface PersonalWorkspaceProvisionInput {
  readonly slug: string;
  readonly displayName: string;
  readonly identityIssuer?: string;
  readonly subject: string;
  readonly email: string;
  readonly firstName?: string;
}

export interface PersonalWorkspaceProvisionResult {
  readonly org: OrgRecord;
  /** True only when this call created the personal org and its welcome-email outbox record. */
  readonly created: boolean;
}

export interface WelcomeEmailRecord {
  readonly subject: string;
  readonly email: string;
  readonly firstName?: string;
  readonly createdAt: string;
  readonly attemptCount: number;
  readonly nextAttemptAt: string;
  readonly leaseExpiresAt?: string;
  readonly sentAt?: string;
  readonly providerMessageId?: string;
  readonly lastErrorCode?: 'delivery_failed';
}

export interface OrganizationStore {
  /** Resolve the one active public MCP label for an immutable organization identity. */
  getActiveMcpSubdomain(org: string): Promise<ActiveMcpSubdomainClaim | undefined>;
  /** Resolve an active public MCP label to its immutable organization identity. */
  resolveActiveMcpSubdomain(mcpSubdomain: string): Promise<ActiveMcpSubdomainClaim | undefined>;
  /** Membership-facing current value and cooldown boundary; never returns claim history. */
  getMcpSubdomainSetting(org: string): Promise<McpSubdomainSetting | undefined>;
  /** Atomic exact-owner mutation. The persistence layer repeats authorization inside its lock. */
  changeMcpSubdomain(input: ChangeMcpSubdomainInput): Promise<McpSubdomainMutationResult>;
  /** Atomically create a user's personal org, owner membership, and first-signup welcome outbox row. */
  provisionPersonalWorkspace(
    input: PersonalWorkspaceProvisionInput,
  ): Promise<PersonalWorkspaceProvisionResult>;
  claimWelcomeEmail(input: {
    readonly now: Date;
    readonly leaseMs: number;
  }): Promise<WelcomeEmailRecord | undefined>;
  markWelcomeEmailSent(input: {
    readonly subject: string;
    readonly providerMessageId: string;
  }): Promise<void>;
  markWelcomeEmailFailed(input: {
    readonly subject: string;
    readonly nextAttemptAt: Date;
  }): Promise<void>;
  /** Point read used by operators and focused tests; never exposed through the public API. */
  getWelcomeEmail(subject: string): Promise<WelcomeEmailRecord | undefined>;
  createOrg(input: { readonly slug: string; readonly displayName?: string }): Promise<OrgRecord>;
  /**
   * Create an org with its first owner, or repair an existing org that has no owner. Existing owned
   * orgs keep their membership unchanged so a later super-admin cannot claim them by repeating create.
   */
  createOrgWithOwner(input: CreateOrgWithOwnerInput): Promise<OrgRecord>;
  /** Update an existing org's display name; `undefined` when the org does not exist (never creates). */
  updateOrg(input: {
    readonly slug: string;
    readonly displayName: string;
  }): Promise<OrgRecord | undefined>;
  /** Point read for org inspect (`GET /v1/orgs/{org}`); `undefined` when the org does not exist. */
  getOrg(org: string): Promise<OrgRecord | undefined>;
  listOrgs(): Promise<readonly OrgRecord[]>;
  listOrgsForSubject(subject: string): Promise<readonly OrgRecord[]>;
  addOrgMember(input: {
    readonly org: string;
    readonly subject: string;
    readonly email: string;
    readonly role: OrgRole;
  }): Promise<OrgMemberRecord>;
  removeOrgMember(input: { readonly org: string; readonly subject: string }): Promise<boolean>;
  /** Change an existing member's role; `undefined` when the member does not exist (never adds). */
  updateOrgMemberRole(input: {
    readonly org: string;
    readonly subject: string;
    readonly role: OrgRole;
  }): Promise<OrgMemberRecord | undefined>;
  getOrgMember(input: {
    readonly org: string;
    readonly subject: string;
  }): Promise<OrgMemberRecord | undefined>;
  listOrgMembers(org: string): Promise<readonly OrgMemberRecord[]>;
  isOrgMember(input: { readonly org: string; readonly subject: string }): Promise<boolean>;
  /** Register a domain whose signed-in users are org members on the data plane (ADR 0181). */
  addOrgDomain(input: {
    readonly org: string;
    readonly domain: string;
    readonly challenge?: string;
  }): Promise<OrgDomainRecord>;
  removeOrgDomain(input: { readonly org: string; readonly domain: string }): Promise<boolean>;
  /** Dormant DNS-proof state, retained for a future org auto-join surface; it gates nothing today. */
  markOrgDomainVerification(input: {
    readonly org: string;
    readonly domain: string;
    readonly verified: boolean;
  }): Promise<OrgDomainRecord | undefined>;
  listOrgDomains(org: string): Promise<readonly OrgDomainRecord[]>;
  setOrgOpenAIAppsChallenge(input: {
    readonly org: string;
    readonly challenge: string;
    readonly updatedBySubject?: string;
    readonly updatedByEmail?: string;
  }): Promise<OrgOpenAIAppsChallengeRecord>;
  getOrgOpenAIAppsChallenge(org: string): Promise<OrgOpenAIAppsChallengeRecord | undefined>;
  clearOrgOpenAIAppsChallenge(org: string): Promise<boolean>;
  isDataPlaneOrgMember(input: {
    readonly org: string;
    readonly subject: string;
    readonly email?: string;
  }): Promise<boolean>;
  allowSignup(input: {
    readonly kind: SignupAllowlistKind;
    readonly value: string;
    readonly createdBySubject?: string;
  }): Promise<SignupAllowlistRecord>;
  listSignupAllowlist(): Promise<readonly SignupAllowlistRecord[]>;
  isSignupAllowed(input: { readonly subject: string; readonly email: string }): Promise<boolean>;
  createOrgInvitation(input: {
    readonly org: string;
    readonly email: string;
    readonly role: OrgRole;
    readonly tokenHash: string;
    readonly createdBySubject: string;
    readonly createdByEmail?: string;
    readonly expiresAt: Date;
  }): Promise<OrgInvitationRecord>;
  getOrgInvitation(input: { readonly tokenHash: string }): Promise<OrgInvitationRecord | undefined>;
  consumeOrgInvitation(input: {
    readonly tokenHash: string;
  }): Promise<OrgInvitationRecord | undefined>;
  /**
   * Every invitation record for one org (pending, accepted, and expired), newest-first. Callers derive
   * status from `acceptedAt`/`expiresAt`; the raw `tokenHash` must never leave the control plane.
   */
  listOrgInvitations(org: string): Promise<readonly OrgInvitationRecord[]>;
  /**
   * Delete every unaccepted invitation for one email (case-insensitive) in one org, returning how many
   * were revoked. Accepted invitations are membership history and stay in place.
   */
  revokeOrgInvitation(input: { readonly org: string; readonly email: string }): Promise<number>;
}
