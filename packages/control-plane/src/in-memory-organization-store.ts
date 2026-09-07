import { randomUUID } from 'node:crypto';
import type {
  ActiveMcpSubdomainClaim,
  ChangeMcpSubdomainInput,
  McpSubdomainMutationResult,
  McpSubdomainSetting,
  OrganizationStore,
  OrgDomainRecord,
  OrgInvitationRecord,
  OrgMemberRecord,
  OrgOpenAIAppsChallengeRecord,
  OrgRecord,
  OrgRole,
  SignupAllowlistKind,
  SignupAllowlistRecord,
} from './contracts.js';
import { InMemoryMcpSubdomainClaimStore } from './mcp-subdomain-claims.js';
import {
  type AcceptOrganizationAgreementInput,
  InMemoryOrganizationAgreements,
} from './organization-agreements.js';
import {
  domainFromEmail,
  domainKey,
  memberKey,
  normalizeSignupAllowlistValue,
  signupKey,
} from './organization-helpers.js';
import {
  validateDomain,
  validateOpenAIAppsChallenge,
  validateOrgMembershipDomain,
  validateOrgRole,
  validateSignupAllowlistKind,
  validateSlug,
} from './validation.js';

interface InMemoryOrganizationStoreOptions {
  readonly now?: () => Date;
  readonly orgs?: Map<string, OrgRecord>;
  readonly members?: Map<string, OrgMemberRecord>;
}

/** Shared in-memory organization persistence used by service-backed development stores. */
export class InMemoryOrganizationStore {
  readonly #orgs: Map<string, OrgRecord>;
  readonly #members: Map<string, OrgMemberRecord>;
  readonly #domains = new Map<string, OrgDomainRecord>();
  readonly #openAIAppsChallenges = new Map<string, OrgOpenAIAppsChallengeRecord>();
  readonly #signup = new Map<string, SignupAllowlistRecord>();
  readonly #invitations = new Map<string, OrgInvitationRecord>();
  readonly #mcpSubdomainClaims: InMemoryMcpSubdomainClaimStore;
  readonly #now: () => Date;
  readonly #agreements: InMemoryOrganizationAgreements;

  constructor(options: InMemoryOrganizationStoreOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#orgs = options.orgs ?? new Map();
    this.#members = options.members ?? new Map();
    this.#mcpSubdomainClaims = new InMemoryMcpSubdomainClaimStore(this.#now);
    this.#agreements = new InMemoryOrganizationAgreements(
      (org, subject) => this.isExactOwner(org, subject),
      this.#now,
    );
  }

  getOrganizationAgreement(org: string, version: string) {
    return this.#agreements.getOrganizationAgreement(org, version);
  }

  acceptOrganizationAgreement(input: AcceptOrganizationAgreementInput) {
    return this.#agreements.acceptOrganizationAgreement(input);
  }

  hasOrg(org: string): boolean {
    return this.#orgs.has(org);
  }

  isExactOwner(org: string, subject: string): boolean {
    return this.#members.get(memberKey(org, subject))?.role === 'owner';
  }

  ensureDefaultMcpSubdomain(org: string): ActiveMcpSubdomainClaim | undefined {
    return this.#mcpSubdomainClaims.ensureDefaultMcpSubdomain(org);
  }

  getActiveMcpSubdomain(org: string): Promise<ActiveMcpSubdomainClaim | undefined> {
    return this.#mcpSubdomainClaims.getActiveMcpSubdomain(org);
  }

  resolveActiveMcpSubdomain(mcpSubdomain: string): Promise<ActiveMcpSubdomainClaim | undefined> {
    return this.#mcpSubdomainClaims.resolveActiveMcpSubdomain(mcpSubdomain);
  }

  getMcpSubdomainSetting(org: string): Promise<McpSubdomainSetting | undefined> {
    return this.#mcpSubdomainClaims.getMcpSubdomainSetting(org);
  }

  changeMcpSubdomain(input: ChangeMcpSubdomainInput): Promise<McpSubdomainMutationResult> {
    return this.#mcpSubdomainClaims.changeMcpSubdomain(input, () =>
      this.isExactOwner(input.org, input.actor.subject),
    );
  }

  createOrg(input: { slug: string; displayName?: string }): Promise<OrgRecord> {
    const slug = validateSlug('org', input.slug);
    this.ensureDefaultMcpSubdomain(slug);
    const existing = this.#orgs.get(slug);
    if (existing !== undefined) return Promise.resolve(existing);
    const org: OrgRecord = {
      slug,
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      createdAt: this.#now().toISOString(),
    };
    this.#orgs.set(slug, org);
    return Promise.resolve(org);
  }

  updateOrg(input: { slug: string; displayName: string }): Promise<OrgRecord | undefined> {
    const slug = validateSlug('org', input.slug);
    const existing = this.#orgs.get(slug);
    if (existing === undefined) return Promise.resolve(undefined);
    const updated: OrgRecord = { ...existing, displayName: input.displayName };
    this.#orgs.set(slug, updated);
    return Promise.resolve(updated);
  }

  getOrg(org: string): Promise<OrgRecord | undefined> {
    return Promise.resolve(this.#orgs.get(validateSlug('org', org)));
  }

  listOrgs(): Promise<readonly OrgRecord[]> {
    return Promise.resolve([...this.#orgs.values()].sort((a, b) => a.slug.localeCompare(b.slug)));
  }

  listOrgsForSubject(subject: string): Promise<readonly OrgRecord[]> {
    const slugs = new Set(
      [...this.#members.values()]
        .filter((member) => member.subject === subject)
        .map((member) => member.orgSlug),
    );
    return Promise.resolve(
      [...this.#orgs.values()]
        .filter((org) => slugs.has(org.slug))
        .sort((a, b) => a.slug.localeCompare(b.slug)),
    );
  }

  async addOrgMember(input: {
    org: string;
    subject: string;
    email: string;
    role: OrgRole;
  }): Promise<OrgMemberRecord> {
    const org = validateSlug('org', input.org);
    await this.createOrg({ slug: org });
    const member: OrgMemberRecord = {
      orgSlug: org,
      subject: input.subject,
      email: input.email.toLowerCase(),
      role: validateOrgRole(input.role),
      createdAt: this.#now().toISOString(),
    };
    this.#members.set(memberKey(org, input.subject), member);
    return member;
  }

  removeOrgMember(input: { org: string; subject: string }): Promise<boolean> {
    return Promise.resolve(
      this.#members.delete(memberKey(validateSlug('org', input.org), input.subject)),
    );
  }

  updateOrgMemberRole(input: {
    org: string;
    subject: string;
    role: OrgRole;
  }): Promise<OrgMemberRecord | undefined> {
    const org = validateSlug('org', input.org);
    const role = validateOrgRole(input.role);
    const key = memberKey(org, input.subject);
    const existing = this.#members.get(key);
    if (existing === undefined) return Promise.resolve(undefined);
    const updated: OrgMemberRecord = { ...existing, role };
    this.#members.set(key, updated);
    return Promise.resolve(updated);
  }

  getOrgMember(input: { org: string; subject: string }): Promise<OrgMemberRecord | undefined> {
    return Promise.resolve(
      this.#members.get(memberKey(validateSlug('org', input.org), input.subject)),
    );
  }

  listOrgMembers(org: string): Promise<readonly OrgMemberRecord[]> {
    const safe = validateSlug('org', org);
    return Promise.resolve(
      [...this.#members.values()]
        .filter((member) => member.orgSlug === safe)
        .sort((a, b) => a.email.localeCompare(b.email)),
    );
  }

  isOrgMember(input: { org: string; subject: string }): Promise<boolean> {
    return Promise.resolve(
      this.#members.has(memberKey(validateSlug('org', input.org), input.subject)),
    );
  }

  async addOrgDomain(input: {
    org: string;
    domain: string;
    challenge?: string;
  }): Promise<OrgDomainRecord> {
    const org = validateSlug('org', input.org);
    const domain = validateOrgMembershipDomain(input.domain);
    await this.createOrg({ slug: org });
    const key = domainKey(org, domain);
    const existing = this.#domains.get(key);
    if (existing !== undefined) return existing;
    const record: OrgDomainRecord = {
      orgSlug: org,
      domain,
      challenge: input.challenge ?? `noodle-${randomUUID()}`,
      createdAt: this.#now().toISOString(),
    };
    this.#domains.set(key, record);
    return record;
  }

  removeOrgDomain(input: { org: string; domain: string }): Promise<boolean> {
    const org = validateSlug('org', input.org);
    const domain = validateDomain(input.domain);
    return Promise.resolve(this.#domains.delete(domainKey(org, domain)));
  }

  markOrgDomainVerification(input: {
    org: string;
    domain: string;
    verified: boolean;
  }): Promise<OrgDomainRecord | undefined> {
    const org = validateSlug('org', input.org);
    const domain = validateDomain(input.domain);
    const key = domainKey(org, domain);
    const existing = this.#domains.get(key);
    if (existing === undefined) return Promise.resolve(undefined);
    const checked = this.#now().toISOString();
    const { verifiedAt: _oldVerifiedAt, ...withoutVerifiedAt } = existing;
    const updated: OrgDomainRecord = {
      ...withoutVerifiedAt,
      lastCheckedAt: checked,
      ...(input.verified ? { verifiedAt: existing.verifiedAt ?? checked } : {}),
    };
    this.#domains.set(key, updated);
    return Promise.resolve(updated);
  }

  listOrgDomains(org: string): Promise<readonly OrgDomainRecord[]> {
    const safe = validateSlug('org', org);
    return Promise.resolve(
      [...this.#domains.values()]
        .filter((record) => record.orgSlug === safe)
        .sort((a, b) => a.domain.localeCompare(b.domain)),
    );
  }

  async setOrgOpenAIAppsChallenge(input: {
    org: string;
    challenge: string;
    updatedBySubject?: string;
    updatedByEmail?: string;
  }): Promise<OrgOpenAIAppsChallengeRecord> {
    const org = validateSlug('org', input.org);
    await this.createOrg({ slug: org });
    const record: OrgOpenAIAppsChallengeRecord = {
      orgSlug: org,
      challenge: validateOpenAIAppsChallenge(input.challenge),
      updatedAt: this.#now().toISOString(),
      ...(input.updatedBySubject !== undefined ? { updatedBySubject: input.updatedBySubject } : {}),
      ...(input.updatedByEmail !== undefined ? { updatedByEmail: input.updatedByEmail } : {}),
    };
    this.#openAIAppsChallenges.set(org, record);
    return record;
  }

  getOrgOpenAIAppsChallenge(org: string): Promise<OrgOpenAIAppsChallengeRecord | undefined> {
    return Promise.resolve(this.#openAIAppsChallenges.get(validateSlug('org', org)));
  }

  clearOrgOpenAIAppsChallenge(org: string): Promise<boolean> {
    return Promise.resolve(this.#openAIAppsChallenges.delete(validateSlug('org', org)));
  }

  async isDataPlaneOrgMember(input: {
    org: string;
    subject: string;
    email?: string;
  }): Promise<boolean> {
    if (await this.isOrgMember({ org: input.org, subject: input.subject })) return true;
    if (input.email === undefined) return false;
    const domain = domainFromEmail(input.email);
    if (domain === undefined) return false;
    const domains = await this.listOrgDomains(input.org);
    return domains.some((record) => record.domain === domain);
  }

  allowSignup(input: {
    kind: SignupAllowlistKind;
    value: string;
    createdBySubject?: string;
  }): Promise<SignupAllowlistRecord> {
    const record: SignupAllowlistRecord = {
      kind: validateSignupAllowlistKind(input.kind),
      value: normalizeSignupAllowlistValue(input.kind, input.value),
      createdAt: this.#now().toISOString(),
      ...(input.createdBySubject !== undefined ? { createdBySubject: input.createdBySubject } : {}),
    };
    this.#signup.set(signupKey(record.kind, record.value), record);
    return Promise.resolve(record);
  }

  listSignupAllowlist(): Promise<readonly SignupAllowlistRecord[]> {
    return Promise.resolve(
      [...this.#signup.values()].sort((a, b) =>
        `${a.kind}:${a.value}`.localeCompare(`${b.kind}:${b.value}`),
      ),
    );
  }

  isSignupAllowed(input: { subject: string; email: string }): Promise<boolean> {
    const subject = input.subject.toLowerCase();
    if (this.#signup.has(signupKey('subject', subject))) return Promise.resolve(true);
    const domain = domainFromEmail(input.email);
    return Promise.resolve(domain !== undefined && this.#signup.has(signupKey('domain', domain)));
  }

  async createOrgInvitation(input: {
    org: string;
    email: string;
    role: OrgRole;
    tokenHash: string;
    createdBySubject: string;
    createdByEmail?: string;
    expiresAt: Date;
  }): Promise<OrgInvitationRecord> {
    const org = validateSlug('org', input.org);
    await this.createOrg({ slug: org });
    const record: OrgInvitationRecord = {
      orgSlug: org,
      email: input.email.toLowerCase(),
      role: validateOrgRole(input.role),
      tokenHash: input.tokenHash,
      createdAt: this.#now().toISOString(),
      expiresAt: input.expiresAt.toISOString(),
      createdBySubject: input.createdBySubject,
      ...(input.createdByEmail !== undefined ? { createdByEmail: input.createdByEmail } : {}),
    };
    this.#invitations.set(input.tokenHash, record);
    return record;
  }

  getOrgInvitation(input: { tokenHash: string }): Promise<OrgInvitationRecord | undefined> {
    const record = this.#invitations.get(input.tokenHash);
    if (record === undefined || record.acceptedAt !== undefined) return Promise.resolve(undefined);
    if (Date.parse(record.expiresAt) <= this.#now().getTime()) return Promise.resolve(undefined);
    return Promise.resolve(record);
  }

  consumeOrgInvitation(input: { tokenHash: string }): Promise<OrgInvitationRecord | undefined> {
    const record = this.#invitations.get(input.tokenHash);
    if (record === undefined || record.acceptedAt !== undefined) return Promise.resolve(undefined);
    if (Date.parse(record.expiresAt) <= this.#now().getTime()) return Promise.resolve(undefined);
    const accepted = { ...record, acceptedAt: this.#now().toISOString() };
    this.#invitations.set(input.tokenHash, accepted);
    return Promise.resolve(accepted);
  }

  listOrgInvitations(org: string): Promise<readonly OrgInvitationRecord[]> {
    const safe = validateSlug('org', org);
    return Promise.resolve(
      [...this.#invitations.values()]
        .filter((record) => record.orgSlug === safe)
        .sort(
          (a, b) =>
            Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.email.localeCompare(b.email),
        ),
    );
  }

  revokeOrgInvitation(input: { org: string; email: string }): Promise<number> {
    const org = validateSlug('org', input.org);
    const email = input.email.toLowerCase();
    let revoked = 0;
    for (const [tokenHash, record] of this.#invitations) {
      if (record.orgSlug === org && record.email === email && record.acceptedAt === undefined) {
        this.#invitations.delete(tokenHash);
        revoked += 1;
      }
    }
    return Promise.resolve(revoked);
  }
}

export type InMemoryOrganizationOperations = Omit<
  OrganizationStore,
  | 'provisionPersonalWorkspace'
  | 'claimWelcomeEmail'
  | 'markWelcomeEmailSent'
  | 'markWelcomeEmailFailed'
  | 'getWelcomeEmail'
  | 'createOrgWithOwner'
>;

/** Bind standard organization methods for composition with service-owned billing and outbox state. */
export function bindInMemoryOrganizationStore(
  store: InMemoryOrganizationStore,
): InMemoryOrganizationOperations {
  return {
    getOrganizationAgreement: store.getOrganizationAgreement.bind(store),
    acceptOrganizationAgreement: store.acceptOrganizationAgreement.bind(store),
    getActiveMcpSubdomain: store.getActiveMcpSubdomain.bind(store),
    resolveActiveMcpSubdomain: store.resolveActiveMcpSubdomain.bind(store),
    getMcpSubdomainSetting: store.getMcpSubdomainSetting.bind(store),
    changeMcpSubdomain: store.changeMcpSubdomain.bind(store),
    createOrg: store.createOrg.bind(store),
    updateOrg: store.updateOrg.bind(store),
    getOrg: store.getOrg.bind(store),
    listOrgs: store.listOrgs.bind(store),
    listOrgsForSubject: store.listOrgsForSubject.bind(store),
    addOrgMember: store.addOrgMember.bind(store),
    removeOrgMember: store.removeOrgMember.bind(store),
    updateOrgMemberRole: store.updateOrgMemberRole.bind(store),
    getOrgMember: store.getOrgMember.bind(store),
    listOrgMembers: store.listOrgMembers.bind(store),
    isOrgMember: store.isOrgMember.bind(store),
    addOrgDomain: store.addOrgDomain.bind(store),
    removeOrgDomain: store.removeOrgDomain.bind(store),
    markOrgDomainVerification: store.markOrgDomainVerification.bind(store),
    listOrgDomains: store.listOrgDomains.bind(store),
    setOrgOpenAIAppsChallenge: store.setOrgOpenAIAppsChallenge.bind(store),
    getOrgOpenAIAppsChallenge: store.getOrgOpenAIAppsChallenge.bind(store),
    clearOrgOpenAIAppsChallenge: store.clearOrgOpenAIAppsChallenge.bind(store),
    isDataPlaneOrgMember: store.isDataPlaneOrgMember.bind(store),
    allowSignup: store.allowSignup.bind(store),
    listSignupAllowlist: store.listSignupAllowlist.bind(store),
    isSignupAllowed: store.isSignupAllowed.bind(store),
    createOrgInvitation: store.createOrgInvitation.bind(store),
    getOrgInvitation: store.getOrgInvitation.bind(store),
    consumeOrgInvitation: store.consumeOrgInvitation.bind(store),
    listOrgInvitations: store.listOrgInvitations.bind(store),
    revokeOrgInvitation: store.revokeOrgInvitation.bind(store),
  };
}
