import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  BusinessWorkspaceInvitationRequestSchema,
  BusinessWorkspaceListQuerySchema,
  BusinessWorkspaceRoleSchema,
  type EligibleBusinessAssignee,
} from '@noodle-borg/wire-contracts';
import { z } from 'zod';
import {
  type BusinessWorkspaceAccess,
  type BusinessWorkspaceBackend,
  BusinessWorkspaceError,
  type BusinessWorkspaceTransaction,
  type WorkspaceAuditEvent,
  WorkspaceOrgSchema,
  WorkspaceRevisionSchema,
  type WorkspaceState,
  WorkspaceSubjectSchema,
} from './contracts.js';
import {
  mayDelegate,
  WORKSPACE_ROLE_PERMISSIONS,
  type WorkspacePermission,
} from './permissions.js';

export interface BusinessWorkspaceStoreOptions {
  /** Canonical identity authority, never an email claim or a caller-supplied boolean. */
  readonly isIdentityActive: (subject: string) => Promise<boolean>;
}
interface Mutation {
  readonly org: string;
  readonly actor: string;
  readonly expectedRevision: number;
}
const roleChange = z.strictObject({
  expectedRevision: WorkspaceRevisionSchema,
  subject: WorkspaceSubjectSchema,
  role: BusinessWorkspaceRoleSchema.nullable(),
});
const invitationLifetimeMs = 7 * 24 * 60 * 60 * 1000;

export class BusinessWorkspaceStore {
  constructor(
    private readonly backend: BusinessWorkspaceBackend,
    private readonly options: BusinessWorkspaceStoreOptions,
  ) {}

  async listForSubject(subject: string, query: unknown) {
    if (!WorkspaceSubjectSchema.safeParse(subject).success)
      throw new BusinessWorkspaceError('invalid_request');
    const input = parse(BusinessWorkspaceListQuerySchema, query);
    const after = input.cursor
      ? Buffer.from(input.cursor, 'base64url').toString('utf8')
      : undefined;
    if (
      after !== undefined &&
      (!WorkspaceOrgSchema.safeParse(after).success ||
        Buffer.from(after).toString('base64url') !== input.cursor)
    )
      throw new BusinessWorkspaceError('invalid_request');
    await this.requireActive(subject);
    const candidates = await this.backend.findMemberships(subject, {
      ...(after ? { after } : {}),
      limit: input.limit + 1,
    });
    const workspaces = [];
    for (const org of candidates.slice(0, input.limit)) {
      try {
        const state = await this.inspect(org, subject);
        workspaces.push({
          org,
          authorityVersion: state.authorityVersion,
          revision: state.revision,
          role: state.role,
          permissions: state.permissions,
        });
      } catch (error) {
        // A revocation can win after discovery. Retry the page rather than emit an unauthorized cursor.
        if (!(error instanceof BusinessWorkspaceError) || error.code !== 'forbidden') throw error;
        throw new Error('workspace membership changed during discovery');
      }
    }
    await this.requireActive(subject);
    const last = candidates[input.limit - 1];
    return {
      workspaces,
      ...(candidates.length > input.limit && last
        ? { nextCursor: Buffer.from(last).toString('base64url') }
        : {}),
    };
  }

  /** Internal new-organization composition only; legacy activation uses reviewed migration, never this method. */
  async initializeNewWorkspace(input: {
    readonly org: string;
    readonly ownerSubject: string;
  }): Promise<WorkspaceState> {
    validateIdentity(input.org, input.ownerSubject);
    return this.backend.run(input.org, async (tx) => {
      const existing = await tx.get();
      if (existing) {
        if (existing.initializedBy !== input.ownerSubject)
          throw new BusinessWorkspaceError('already_activated');
        return existing;
      }
      await this.requireActive(input.ownerSubject);
      const state: WorkspaceState = {
        org: input.org,
        authorityVersion: 1,
        revision: 1,
        initializedBy: input.ownerSubject,
        activatedAt: tx.now,
        members: [{ subject: input.ownerSubject, role: 'owner', joinedAt: tx.now }],
        invitations: [],
      };
      await tx.save(state, {
        revision: 1,
        actor: input.ownerSubject,
        action: 'initialized',
        target: input.org,
        at: tx.now,
      });
      return state;
    });
  }

  /** A dispatch that mutates data must call this again inside its workspace authority transaction. */
  async authorize(
    org: string,
    subject: string,
    permission: WorkspacePermission,
  ): Promise<'legacy' | 'allowed' | 'denied'> {
    validateIdentity(org, subject);
    if (!(await this.options.isIdentityActive(subject))) return 'denied';
    const state = await this.backend.read(org);
    if (!state) return 'legacy';
    const member = state.members.find((item) => item.subject === subject);
    return member && WORKSPACE_ROLE_PERMISSIONS[member.role].includes(permission)
      ? 'allowed'
      : 'denied';
  }

  /** Undefined means retained legacy authority, never a versioned workspace with a missing member. */
  async resolveAccess(org: string, subject: string): Promise<BusinessWorkspaceAccess | undefined> {
    validateIdentity(org, subject);
    await this.requireActive(subject);
    const state = await this.backend.read(org);
    if (!state) return undefined;
    const member = state.members.find((item) => item.subject === subject);
    if (!member) throw new BusinessWorkspaceError('forbidden');
    return {
      authorityVersion: 1,
      revision: state.revision,
      subject,
      role: member.role,
      permissions: WORKSPACE_ROLE_PERMISSIONS[member.role],
    };
  }

  /** Minimal assignment choices; not a team directory or a second identity profile store. */
  async listEligibleAssignees(
    org: string,
    actor: string,
  ): Promise<readonly EligibleBusinessAssignee[] | undefined> {
    validateIdentity(org, actor);
    return this.backend.run(org, async (tx) => {
      await this.requireActive(actor);
      const state = await tx.get();
      if (!state) return undefined;
      const member = state.members.find((item) => item.subject === actor);
      if (!member || !WORKSPACE_ROLE_PERMISSIONS[member.role].includes('records:write'))
        throw new BusinessWorkspaceError('forbidden');
      const result: EligibleBusinessAssignee[] = [];
      for (const candidate of state.members) {
        if (
          (candidate.role === 'owner' ||
            candidate.role === 'administrator' ||
            candidate.role === 'operator') &&
          (await this.options.isIdentityActive(candidate.subject))
        )
          result.push({ subject: candidate.subject, role: candidate.role, authorityVersion: 1 });
        if (result.length === 100) break;
      }
      return result;
    });
  }

  /** Commit a local authoritative effect under the same lock/transaction as membership changes.
   * The callback must use this backend's transaction-aware stores, never send an HTTP response or
   * perform a remote side effect. External operations use their own dispatch/confirmation boundary.
   */
  async runAuthorized<T>(
    org: string,
    actor: string,
    permission: WorkspacePermission | null,
    operation: () => Promise<T>,
    legacy?: () => Promise<T>,
  ): Promise<T> {
    validateIdentity(org, actor);
    return this.backend.run(org, async (tx) => {
      const state = await tx.get();
      await this.requireActive(actor);
      if (!state) {
        if (legacy) return legacy();
        throw new BusinessWorkspaceError('legacy_authority');
      }
      const member = state.members.find((item) => item.subject === actor);
      if (
        !member ||
        permission === null ||
        !WORKSPACE_ROLE_PERMISSIONS[member.role].includes(permission)
      )
        throw new BusinessWorkspaceError('forbidden');
      return operation();
    });
  }

  async inspect(org: string, actor: string) {
    validateIdentity(org, actor);
    return this.backend.run(org, async (tx) => {
      const state = await this.requireState(tx);
      await this.requireActive(actor);
      const member = state.members.find((item) => item.subject === actor);
      if (!member) throw new BusinessWorkspaceError('forbidden');
      return {
        org,
        authorityVersion: state.authorityVersion,
        revision: state.revision,
        activatedAt: state.activatedAt,
        role: member.role,
        permissions: WORKSPACE_ROLE_PERMISSIONS[member.role],
        members: state.members,
        invitations: WORKSPACE_ROLE_PERMISSIONS[member.role].includes('team:manage')
          ? state.invitations
              .filter((item) => Date.parse(item.expiresAt) > Date.parse(tx.now))
              .map(({ tokenDigest: _token, ...item }) => item)
          : [],
      };
    });
  }

  async changeRole(
    input: Mutation & {
      readonly subject: string;
      readonly role: z.infer<typeof BusinessWorkspaceRoleSchema> | null;
    },
  ) {
    const change = parse(roleChange, {
      expectedRevision: input.expectedRevision,
      subject: input.subject,
      role: input.role,
    });
    return this.mutate(input, async (tx, state) => {
      const actor = state.members.find((item) => item.subject === input.actor);
      const member = state.members.find((item) => item.subject === change.subject);
      if (!actor || !WORKSPACE_ROLE_PERMISSIONS[actor.role].includes('team:manage'))
        throw new BusinessWorkspaceError('forbidden');
      if (!member) throw new BusinessWorkspaceError('not_found');
      if (
        !mayDelegate(actor.role, member.role) ||
        (change.role !== null && !mayDelegate(actor.role, change.role))
      ) {
        throw new BusinessWorkspaceError('forbidden');
      }
      if (
        member.role === 'owner' &&
        change.role !== 'owner' &&
        state.members.filter((item) => item.role === 'owner').length === 1
      ) {
        throw new BusinessWorkspaceError('last_owner');
      }
      state.members = state.members.flatMap((item) =>
        item.subject !== change.subject
          ? [item]
          : change.role === null
            ? []
            : [{ ...item, role: change.role }],
      );
      // Invitations are revoked when their issuer loses the exact authority under which they were issued.
      state.invitations = state.invitations.filter((item) => item.createdBy !== change.subject);
      return this.commit(
        tx,
        state,
        input.actor,
        change.role === null ? 'removed' : 'role_changed',
        change.subject,
      );
    });
  }

  async invite(
    input: Mutation & {
      readonly email: string;
      readonly role?: z.infer<typeof BusinessWorkspaceRoleSchema>;
    },
  ) {
    const request = parse(BusinessWorkspaceInvitationRequestSchema, {
      email: input.email,
      expectedRevision: input.expectedRevision,
      ...(input.role === undefined ? {} : { role: input.role }),
    });
    return this.mutate(input, async (tx, state) => {
      const actor = state.members.find((item) => item.subject === input.actor);
      if (!mayDelegate(actor?.role, request.role)) throw new BusinessWorkspaceError('forbidden');
      const email = request.email.toLowerCase();
      state.invitations = state.invitations.filter(
        (item) => item.email !== email && Date.parse(item.expiresAt) > Date.parse(tx.now),
      );
      if (state.invitations.length >= 100) throw new BusinessWorkspaceError('workspace_limit');
      const token = randomBytes(32).toString('base64url');
      const invitation = {
        id: randomUUID(),
        email,
        role: request.role,
        tokenDigest: digest(token),
        createdBy: input.actor,
        createdAt: tx.now,
        expiresAt: new Date(Date.parse(tx.now) + invitationLifetimeMs).toISOString(),
      };
      state.invitations.push(invitation);
      const result = await this.commit(tx, state, input.actor, 'invited', invitation.id);
      return {
        id: invitation.id,
        role: invitation.role,
        token,
        expiresAt: invitation.expiresAt,
        revision: result.revision,
      };
    });
  }

  /** Caller supplies the authenticated canonical identity's verified email, never form input. */
  async accept(input: {
    readonly org: string;
    readonly subject: string;
    readonly verifiedEmail: string;
    readonly token: string;
  }) {
    validateIdentity(input.org, input.subject);
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(input.token) ||
      !z.email().max(254).safeParse(input.verifiedEmail).success
    ) {
      throw new BusinessWorkspaceError('invalid_invitation');
    }
    return this.backend.run(input.org, async (tx) => {
      await this.requireActive(input.subject);
      const state = await this.requireState(tx);
      const tokenDigest = Buffer.from(digest(input.token), 'hex');
      const invitation = state.invitations.find((item) =>
        timingSafeEqual(Buffer.from(item.tokenDigest, 'hex'), tokenDigest),
      );
      if (
        !invitation ||
        invitation.email !== input.verifiedEmail.toLowerCase() ||
        Date.parse(invitation.expiresAt) <= Date.parse(tx.now)
      ) {
        throw new BusinessWorkspaceError('invalid_invitation');
      }
      const issuer = state.members.find((item) => item.subject === invitation.createdBy);
      if (
        !mayDelegate(issuer?.role, invitation.role) ||
        !(await this.options.isIdentityActive(invitation.createdBy))
      ) {
        throw new BusinessWorkspaceError('invalid_invitation');
      }
      if (state.members.some((item) => item.subject === input.subject))
        throw new BusinessWorkspaceError('member_exists');
      if (state.members.length >= 1000) throw new BusinessWorkspaceError('workspace_limit');
      state.members.push({ subject: input.subject, role: invitation.role, joinedAt: tx.now });
      state.invitations = state.invitations.filter((item) => item.id !== invitation.id);
      return this.commit(tx, state, input.subject, 'accepted', invitation.id);
    });
  }

  async revokeInvitation(input: Mutation & { readonly invitationId: string }) {
    if (!z.uuid().safeParse(input.invitationId).success)
      throw new BusinessWorkspaceError('invalid_request');
    return this.mutate(input, async (tx, state) => {
      const invitation = state.invitations.find((item) => item.id === input.invitationId);
      const actor = state.members.find((item) => item.subject === input.actor);
      if (!actor || !WORKSPACE_ROLE_PERMISSIONS[actor.role].includes('team:manage'))
        throw new BusinessWorkspaceError('forbidden');
      if (!invitation) throw new BusinessWorkspaceError('not_found');
      if (!mayDelegate(actor.role, invitation.role)) throw new BusinessWorkspaceError('forbidden');
      state.invitations = state.invitations.filter((item) => item.id !== invitation.id);
      return this.commit(tx, state, input.actor, 'invitation_revoked', invitation.id);
    });
  }

  private mutate<T>(
    input: Mutation,
    work: (tx: BusinessWorkspaceTransaction, state: WorkspaceState) => Promise<T>,
  ) {
    validateIdentity(input.org, input.actor);
    if (!WorkspaceRevisionSchema.safeParse(input.expectedRevision).success)
      throw new BusinessWorkspaceError('invalid_request');
    return this.backend.run(input.org, async (tx) => {
      await this.requireActive(input.actor);
      const state = await this.requireState(tx);
      if (!state.members.some((member) => member.subject === input.actor))
        throw new BusinessWorkspaceError('forbidden');
      if (state.revision !== input.expectedRevision)
        throw new BusinessWorkspaceError('revision_conflict', state.revision);
      return work(tx, state);
    });
  }

  private async commit(
    tx: BusinessWorkspaceTransaction,
    state: WorkspaceState,
    actor: string,
    action: WorkspaceAuditEvent['action'],
    target: string,
  ) {
    state.revision++;
    await tx.save(state, { revision: state.revision, actor, action, target, at: tx.now });
    return { revision: state.revision };
  }
  private async requireState(tx: BusinessWorkspaceTransaction): Promise<WorkspaceState> {
    const state = await tx.get();
    if (!state) throw new BusinessWorkspaceError('legacy_authority');
    return state;
  }
  private async requireActive(subject: string) {
    if (!(await this.options.isIdentityActive(subject)))
      throw new BusinessWorkspaceError('forbidden');
  }
}

function validateIdentity(org: string, subject: string) {
  if (
    !WorkspaceOrgSchema.safeParse(org).success ||
    !WorkspaceSubjectSchema.safeParse(subject).success
  ) {
    throw new BusinessWorkspaceError('invalid_request');
  }
}
function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new BusinessWorkspaceError('invalid_request');
  return parsed.data;
}
function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
