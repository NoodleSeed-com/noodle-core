import type {
  BusinessGrant,
  BusinessGrantStore,
  BusinessInvitation,
  SolutionInstallation,
} from './contracts.js';
import {
  cloneInvitation,
  normalizeInvitationInput,
  validateInvitationClaim,
  validateInvitationMutation,
} from './invitations.js';
import { cloneGrant, permissionsForBusinessRole } from './model.js';
import { scopeKey } from './pagination.js';
import { validateScope } from './validation.js';

interface Options {
  readonly now: () => Date;
  readonly getInstallation: (
    scope: Parameters<BusinessGrantStore['getGrant']>[0],
  ) => Promise<SolutionInstallation | undefined>;
  readonly getGrant: BusinessGrantStore['getGrant'];
  readonly putGrant: (grant: BusinessGrant) => void;
  readonly withGrantLock: <T>(
    scope: Parameters<BusinessGrantStore['getGrant']>[0],
    operation: () => Promise<T>,
  ) => Promise<T>;
  readonly liveAdministratorCount: (scope: Parameters<BusinessGrantStore['getGrant']>[0]) => number;
}

/** Invitation state isolated from the broader in-memory record adapter. */
export class InMemoryBusinessInvitations {
  readonly #records = new Map<string, BusinessInvitation>();
  readonly #tokens = new Map<string, string>();
  readonly #idempotency = new Map<string, string>();
  readonly #locks = new Map<string, Promise<void>>();

  constructor(private readonly options: Options) {}

  async create(
    input: Parameters<BusinessGrantStore['createInvitation']>[0],
  ): ReturnType<BusinessGrantStore['createInvitation']> {
    permissionsForBusinessRole(input.role);
    const normalized = normalizeInvitationInput(input);
    const replayKey = `${scopeKey(normalized.scope)}\0${normalized.idempotencyDigest}`;
    return this.#withLock(`create:${replayKey}`, async () => {
      if (!(await this.options.getInstallation(normalized.scope))) {
        throw new Error('invitation installation is missing');
      }
      const existingKey = this.#idempotency.get(replayKey);
      const existing = existingKey === undefined ? undefined : this.#records.get(existingKey);
      if (existing !== undefined) {
        return {
          disposition:
            existing.createFingerprint === normalized.createFingerprint ? 'replayed' : 'conflict',
          invitation: cloneInvitation(existing),
        };
      }
      if (this.#tokens.has(normalized.tokenDigest)) {
        throw new Error('invitation token digest already exists');
      }
      const invitation: BusinessInvitation = {
        scope: { ...normalized.scope },
        invitationId: normalized.invitationId,
        email: normalized.email,
        role: normalized.role,
        tokenDigest: normalized.tokenDigest,
        idempotencyDigest: normalized.idempotencyDigest,
        createFingerprint: normalized.createFingerprint,
        revision: 1,
        createdAt: this.options.now().toISOString(),
        expiresAt: normalized.expiresAt.toISOString(),
        createdBySubject: normalized.actorSubject,
      };
      const key = invitationKey(normalized.scope, normalized.invitationId);
      if (this.#records.has(key)) throw new Error('invitation id already exists');
      this.#records.set(key, invitation);
      this.#tokens.set(normalized.tokenDigest, key);
      this.#idempotency.set(replayKey, key);
      return { disposition: 'created', invitation: cloneInvitation(invitation) };
    });
  }

  list(scope: Parameters<BusinessGrantStore['listInvitations']>[0]) {
    const prefix = `${scopeKey(validateScope(scope))}\0`;
    return Promise.resolve(
      [...this.#records.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, invitation]) => cloneInvitation(invitation))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    );
  }

  async revoke(
    input: Parameters<BusinessGrantStore['revokeInvitation']>[0],
  ): ReturnType<BusinessGrantStore['revokeInvitation']> {
    const normalized = validateInvitationMutation(input);
    const key = invitationKey(normalized.scope, normalized.invitationId);
    return this.#withLock(key, async () => {
      const current = this.#records.get(key);
      if (current === undefined) return { ok: false, reason: 'not_found', currentRevision: 0 };
      if (current.revision !== normalized.expectedRevision) {
        return { ok: false, reason: 'conflict', currentRevision: current.revision };
      }
      if (current.acceptedAt !== undefined || current.revokedAt !== undefined) {
        return { ok: false, reason: 'already_used', currentRevision: current.revision };
      }
      const invitation: BusinessInvitation = {
        ...current,
        revision: current.revision + 1,
        revokedAt: this.options.now().toISOString(),
        revokedBySubject: normalized.actorSubject,
      };
      this.#records.set(key, invitation);
      return { ok: true, invitation: cloneInvitation(invitation) };
    });
  }

  async claim(
    input: Parameters<BusinessGrantStore['claimInvitation']>[0],
  ): ReturnType<BusinessGrantStore['claimInvitation']> {
    const normalized = validateInvitationClaim(input);
    return this.#withLock(`token:${normalized.tokenDigest}`, async () => {
      const key = this.#tokens.get(normalized.tokenDigest);
      if (key === undefined) return { ok: false, reason: 'not_found' };
      return this.#withLock(key, async () => {
        const current = this.#records.get(key);
        if (current === undefined) return { ok: false, reason: 'not_found' };
        if (current.acceptedAt !== undefined) return { ok: false, reason: 'already_used' };
        if (current.revokedAt !== undefined) return { ok: false, reason: 'revoked' };
        if (Date.parse(current.expiresAt) <= this.options.now().getTime()) {
          return { ok: false, reason: 'expired' };
        }
        if (current.email !== normalized.email) return { ok: false, reason: 'email_mismatch' };
        return this.options.withGrantLock(current.scope, async () => {
          const previous = await this.options.getGrant(current.scope, normalized.subject);
          if (
            previous?.role === 'administrator' &&
            previous.revokedAt === undefined &&
            current.role !== 'administrator' &&
            this.options.liveAdministratorCount(current.scope) === 1
          ) {
            return { ok: false, reason: 'last_administrator' } as const;
          }
          const now = this.options.now().toISOString();
          const grant: BusinessGrant = {
            scope: { ...current.scope },
            subject: normalized.subject,
            email: normalized.email,
            role: current.role,
            revision: (previous?.revision ?? 0) + 1,
            createdAt: previous?.createdAt ?? now,
            createdBySubject: previous?.createdBySubject ?? current.createdBySubject,
            updatedAt: now,
            updatedBySubject: normalized.subject,
          };
          const invitation: BusinessInvitation = {
            ...current,
            revision: current.revision + 1,
            acceptedAt: now,
            acceptedBySubject: normalized.subject,
          };
          this.options.putGrant(grant);
          this.#records.set(key, invitation);
          return { ok: true, invitation: cloneInvitation(invitation), grant: cloneGrant(grant) };
        });
      });
    });
  }

  async #withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.#locks.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#locks.get(key) === queued) this.#locks.delete(key);
    }
  }
}

function invitationKey(scope: BusinessInvitation['scope'], invitationId: string): string {
  return `${scopeKey(scope)}\0${invitationId}`;
}
