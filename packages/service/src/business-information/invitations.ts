import { createHash } from 'node:crypto';
import type { BusinessInvitation, BusinessRole, InstallationScope } from './contracts.js';
import { validateExpectedRevision } from './model.js';
import { validateEmail, validateScalar, validateScope } from './validation.js';

export type BusinessInvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

export function normalizeInvitationInput(input: {
  readonly scope: InstallationScope;
  readonly invitationId: string;
  readonly email: string;
  readonly role: BusinessRole;
  readonly tokenDigest: string;
  readonly idempotencyKey: string;
  readonly expiresAt: Date;
  readonly actorSubject: string;
}) {
  const expiresAt = input.expiresAt;
  if (!Number.isFinite(expiresAt.getTime())) throw new Error('invitation expiry is invalid');
  const tokenDigest = validateDigest('invitation token digest', input.tokenDigest);
  const idempotencyDigest = createHash('sha256')
    .update(validateScalar('invitation idempotency key', input.idempotencyKey, 128))
    .digest('hex');
  const normalized = {
    scope: validateScope(input.scope),
    invitationId: validateScalar('invitation id', input.invitationId, 128),
    email: validateEmail(input.email),
    role: input.role,
    tokenDigest,
    idempotencyDigest,
    expiresAt,
    actorSubject: validateScalar('actor subject', input.actorSubject, 256),
  };
  return {
    ...normalized,
    createFingerprint: createHash('sha256')
      .update(
        JSON.stringify({
          scope: normalized.scope,
          email: normalized.email,
          role: normalized.role,
          tokenDigest: normalized.tokenDigest,
        }),
      )
      .digest('hex'),
  };
}

export function validateInvitationMutation(input: {
  readonly scope: InstallationScope;
  readonly invitationId: string;
  readonly expectedRevision: number;
  readonly actorSubject: string;
}) {
  validateExpectedRevision(input.expectedRevision);
  return {
    scope: validateScope(input.scope),
    invitationId: validateScalar('invitation id', input.invitationId, 128),
    expectedRevision: input.expectedRevision,
    actorSubject: validateScalar('actor subject', input.actorSubject, 256),
  };
}

export function validateInvitationClaim(input: {
  readonly tokenDigest: string;
  readonly subject: string;
  readonly email: string;
}) {
  return {
    tokenDigest: validateDigest('invitation token digest', input.tokenDigest),
    subject: validateScalar('identity subject', input.subject, 256),
    email: validateEmail(input.email),
  };
}

export function invitationStatus(
  invitation: BusinessInvitation,
  now: Date,
): BusinessInvitationStatus {
  if (invitation.acceptedAt !== undefined) return 'accepted';
  if (invitation.revokedAt !== undefined) return 'revoked';
  if (Date.parse(invitation.expiresAt) <= now.getTime()) return 'expired';
  return 'pending';
}

export function cloneInvitation(invitation: BusinessInvitation): BusinessInvitation {
  return { ...invitation, scope: { ...invitation.scope } };
}

function validateDigest(name: string, value: string): string {
  const digest = validateScalar(name, value, 64);
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`${name} is invalid`);
  return digest;
}
