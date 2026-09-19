import type {
  CreateOrgWithOwnerInput,
  OrgMemberRecord,
  OrgRecord,
  OrgRole,
  PersonalWorkspaceProvisionInput,
  PersonalWorkspaceProvisionResult,
  WelcomeEmailRecord,
} from './contracts.js';
import { PersonalWorkspaceOwnerMutationError } from './contracts.js';
import { InMemoryAtomicState } from './in-memory-atomic-state.js';
import { InMemoryOrganizationStore } from './in-memory-organization-store.js';
import { personalOrgSlugSuffix } from './organization-helpers.js';
import { validateUserOwnedOrgSlug } from './validation.js';

/** Portable organization state. Commercial account provisioning is an optional module side effect. */
export class InMemoryControlPlaneStore extends InMemoryOrganizationStore {
  readonly #welcomeEmails: Map<string, WelcomeEmailRecord>;
  readonly #personalWorkspaces: Map<string, string>;
  readonly #now: () => Date;
  readonly #transactions: InMemoryAtomicState;
  readonly #personalWorkspaceCreated:
    | ((input: { readonly org: string; readonly ownerSubject: string }) => Promise<void>)
    | undefined;

  constructor(
    options: {
      readonly now?: () => Date;
      readonly transactions?: InMemoryAtomicState;
      /** Fresh-only local participant; all stores must share the supplied transaction context. */
      readonly personalWorkspaceCreated?: (input: {
        readonly org: string;
        readonly ownerSubject: string;
      }) => Promise<void>;
    } = {},
  ) {
    if (options.personalWorkspaceCreated && !options.transactions)
      throw new Error('fresh workspace composition requires a shared memory transaction context');
    const now = options.now ?? (() => new Date());
    const transactions = options.transactions ?? new InMemoryAtomicState();
    super({ now, transactions });
    this.#now = now;
    this.#transactions = transactions;
    this.#personalWorkspaceCreated = options.personalWorkspaceCreated;
    this.#welcomeEmails = transactions.map();
    this.#personalWorkspaces = transactions.map();
  }

  provisionPersonalWorkspace(
    input: PersonalWorkspaceProvisionInput,
  ): Promise<PersonalWorkspaceProvisionResult> {
    return this.#transactions.run(async () => {
      const requestedSlug = validateUserOwnedOrgSlug(input.slug);
      const bound = this.#personalWorkspaces.get(input.subject);
      if (bound !== undefined) {
        await this.#ensureOwner(bound, input);
        const org = await this.getOrg(bound);
        if (org === undefined) throw new Error('personal workspace binding lost org');
        return { org, created: false };
      }

      const suffix = personalOrgSlugSuffix(input.subject);
      const candidates: OrgRecord[] = [];
      for (const org of await this.listOrgs()) {
        if (!org.slug.startsWith('u-') || !org.slug.endsWith(suffix)) continue;
        if (
          (await this.getOrgMember({ org: org.slug, subject: input.subject }))?.role === 'owner'
        ) {
          candidates.push(org);
        }
      }
      if (candidates.length > 1) throw new Error('personal workspace legacy mapping is ambiguous');
      const legacy = candidates[0];
      if (legacy !== undefined) {
        await this.#ensureOwner(legacy.slug, input);
        this.#personalWorkspaces.set(input.subject, legacy.slug);
        return { org: legacy, created: false };
      }
      if ((await this.getOrg(requestedSlug)) !== undefined) {
        throw new Error('personal workspace slug is already assigned');
      }
      const org = await this.createOrg({ slug: requestedSlug, displayName: input.displayName });
      await this.#ensureOwner(requestedSlug, input);
      await this.#personalWorkspaceCreated?.({ org: requestedSlug, ownerSubject: input.subject });
      const createdAt = this.#now().toISOString();
      this.#welcomeEmails.set(input.subject, {
        subject: input.subject,
        email: input.email.toLowerCase(),
        ...(input.firstName === undefined ? {} : { firstName: input.firstName }),
        createdAt,
        attemptCount: 0,
        nextAttemptAt: createdAt,
      });
      this.#personalWorkspaces.set(input.subject, requestedSlug);
      return { org, created: true };
    });
  }

  createOrgWithOwner(input: CreateOrgWithOwnerInput): Promise<OrgRecord> {
    return this.#transactions.run(async () => {
      const slug = validateUserOwnedOrgSlug(input.slug);
      const existing = await this.getOrg(slug);
      if (existing !== undefined) {
        const owner = (await this.listOrgMembers(slug)).find((member) => member.role === 'owner');
        if (owner !== undefined) return existing;
      }
      const org = await this.createOrg({
        slug,
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
      });
      await this.addOrgMember({ org: slug, ...input.owner, role: 'owner' });
      return org;
    });
  }

  override addOrgMember(input: {
    org: string;
    subject: string;
    email: string;
    role: OrgRole;
  }): Promise<OrgMemberRecord> {
    this.#assertPersonalOwnerMutation(input.org, input.subject, input.role);
    return super.addOrgMember(input);
  }

  override removeOrgMember(input: { org: string; subject: string }): Promise<boolean> {
    this.#assertPersonalOwnerMutation(input.org, input.subject);
    return super.removeOrgMember(input);
  }

  override updateOrgMemberRole(input: {
    org: string;
    subject: string;
    role: OrgRole;
  }): Promise<OrgMemberRecord | undefined> {
    this.#assertPersonalOwnerMutation(input.org, input.subject, input.role);
    return super.updateOrgMemberRole(input);
  }

  claimWelcomeEmail(input: {
    readonly now: Date;
    readonly leaseMs: number;
  }): Promise<WelcomeEmailRecord | undefined> {
    const nowMs = input.now.getTime();
    const record = [...this.#welcomeEmails.values()]
      .filter(
        (candidate) =>
          candidate.sentAt === undefined &&
          Date.parse(candidate.nextAttemptAt) <= nowMs &&
          (candidate.leaseExpiresAt === undefined || Date.parse(candidate.leaseExpiresAt) <= nowMs),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (record === undefined) return Promise.resolve(undefined);
    const claimed: WelcomeEmailRecord = {
      ...record,
      attemptCount: record.attemptCount + 1,
      leaseExpiresAt: new Date(nowMs + input.leaseMs).toISOString(),
    };
    this.#welcomeEmails.set(record.subject, claimed);
    return Promise.resolve(claimed);
  }

  markWelcomeEmailSent(input: {
    readonly subject: string;
    readonly providerMessageId: string;
  }): Promise<void> {
    const record = this.#welcomeEmails.get(input.subject);
    if (record !== undefined) {
      const { leaseExpiresAt: _lease, lastErrorCode: _error, ...pending } = record;
      this.#welcomeEmails.set(input.subject, {
        ...pending,
        sentAt: this.#now().toISOString(),
        providerMessageId: input.providerMessageId,
      });
    }
    return Promise.resolve();
  }

  markWelcomeEmailFailed(input: {
    readonly subject: string;
    readonly nextAttemptAt: Date;
  }): Promise<void> {
    const record = this.#welcomeEmails.get(input.subject);
    if (record !== undefined) {
      const { leaseExpiresAt: _lease, ...pending } = record;
      this.#welcomeEmails.set(input.subject, {
        ...pending,
        nextAttemptAt: input.nextAttemptAt.toISOString(),
        lastErrorCode: 'delivery_failed',
      });
    }
    return Promise.resolve();
  }

  getWelcomeEmail(subject: string): Promise<WelcomeEmailRecord | undefined> {
    return Promise.resolve(this.#welcomeEmails.get(subject));
  }

  async #ensureOwner(org: string, input: PersonalWorkspaceProvisionInput): Promise<void> {
    const current = await this.getOrgMember({ org, subject: input.subject });
    if (current !== undefined && current.role !== 'owner') {
      throw new Error('personal workspace legacy ownership mismatch');
    }
    await this.addOrgMember({
      org,
      subject: input.subject,
      email: input.email,
      role: 'owner',
    });
  }

  #assertPersonalOwnerMutation(org: string, subject: string, role?: OrgRole): void {
    if (this.#personalWorkspaces.get(subject) === org && role !== 'owner') {
      throw new PersonalWorkspaceOwnerMutationError();
    }
  }
}
