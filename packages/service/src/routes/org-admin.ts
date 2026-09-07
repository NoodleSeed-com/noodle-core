/**
 * Org administration control-plane routes (moved from `control-plane.ts` to keep both under the size
 * gate): org create/list/rename, member list/add/remove/role-change, and invitation
 * create/list/revoke/accept. Mutations are owner-only (`canManageMembers`), guarded so an org can never
 * lose its last owner, and every successful mutation emits a durable audit event with safe scalar fields
 * only — never a token, token hash, or request body.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ControlPlaneIdentity, DeployAuthGate } from '@noodle-borg/control-plane/portable';
import {
  mcpSubdomainEndpointOptions,
  PersonalWorkspaceOwnerMutationError,
} from '@noodle-borg/control-plane/portable';
import { normalizePublicBaseDomain, OPENAI_APPS_CHALLENGE_PATH } from '@noodle-borg/module';
import { readJsonBody, sendJson } from '@noodle-borg/transport-http';
import { OrgSummarySchema } from '@noodle-borg/wire-contracts';
import { sendForbidden } from '../http-util.js';
import { hashToken, randomToken } from '../oauth/tokens.js';
import type { AuditSink } from '../store/audit.js';
import {
  type ControlPlaneStore,
  type OrgInvitationRecord,
  type OrgRole,
  validateOrgRole,
} from '../store.js';
import type { InvitationEmailSender } from '../welcome-email.js';
import { authorizeControlPlane, authorizeTenantControl } from './control-plane.js';

const ORG_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const MAX_ORG_DISPLAY_NAME_LENGTH = 200;

export async function handleOrgs(
  req: IncomingMessage,
  res: ServerResponse,
  gate: DeployAuthGate,
  controlPlane: ControlPlaneStore,
  maxBody: number,
): Promise<void> {
  const identity = await authorizeControlPlane(req, res, gate, { requireIdentity: true });
  if (identity === false) return;
  if (req.method === 'GET') {
    const orgs = identity.superAdmin
      ? await controlPlane.listOrgs()
      : await controlPlane.listOrgsForSubject(identity.subject);
    return sendJson(res, 200, { ok: true, orgs });
  }
  if (!identity.superAdmin) return sendForbidden(res, 'super-admin required');
  const body = await readJsonBody(req, maxBody);
  if (!body.ok) return sendJson(res, body.status, { error: body.error });
  const parsed = body.value as { slug?: unknown; displayName?: unknown };
  if (typeof parsed.slug !== 'string')
    return sendJson(res, 400, { error: '"slug" must be a string' });
  if (parsed.displayName !== undefined && typeof parsed.displayName !== 'string') {
    return sendJson(res, 400, { error: '"displayName" must be a string' });
  }
  // Same rules as rename: a name an org could not be renamed to cannot be created with either.
  const displayName =
    typeof parsed.displayName === 'string' ? parsed.displayName.trim() : undefined;
  if (
    displayName !== undefined &&
    (displayName.length === 0 || displayName.length > MAX_ORG_DISPLAY_NAME_LENGTH)
  ) {
    return sendJson(res, 400, {
      error: `"displayName" must be a non-empty string of at most ${MAX_ORG_DISPLAY_NAME_LENGTH} characters`,
    });
  }
  try {
    const org = await controlPlane.createOrgWithOwner({
      slug: parsed.slug,
      ...(displayName !== undefined ? { displayName } : {}),
      owner: { subject: identity.subject, email: identity.email },
    });
    return sendJson(res, 201, { ok: true, org });
  } catch (error) {
    return sendJson(res, 400, { error: (error as Error).message });
  }
}

/** `PATCH /v1/orgs/{org}` — rename an org (display name only; the slug is immutable routing identity). */
export async function handleOrgUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  gate: DeployAuthGate,
  controlPlane: ControlPlaneStore,
  maxBody: number,
  ref: { org: string },
  audit: AuditSink,
): Promise<void> {
  const identity = await authorizeControlPlane(req, res, gate, { requireIdentity: true });
  if (identity === false) return;
  if (!(await canManageMembers(controlPlane, ref.org, identity)))
    return sendForbidden(res, 'forbidden');
  const body = await readJsonBody(req, maxBody);
  if (!body.ok) return sendJson(res, body.status, { error: body.error });
  const parsed = body.value as { displayName?: unknown };
  const displayName =
    typeof parsed.displayName === 'string' ? parsed.displayName.trim() : undefined;
  if (
    displayName === undefined ||
    displayName.length === 0 ||
    displayName.length > MAX_ORG_DISPLAY_NAME_LENGTH
  ) {
    return sendJson(res, 400, {
      error: `"displayName" must be a non-empty string of at most ${MAX_ORG_DISPLAY_NAME_LENGTH} characters`,
    });
  }
  try {
    const org = await controlPlane.updateOrg({ slug: ref.org, displayName });
    if (org === undefined) return sendJson(res, 404, { error: 'not found' });
    await emitOrgAudit(audit, 'org.renamed', ref.org, identity, 200, { displayName });
    return sendJson(res, 200, { ok: true, org });
  } catch (error) {
    return sendJson(res, 400, { error: (error as Error).message });
  }
}

/** `GET /v1/orgs/{org}` — org inspect. Membership-gated like the deployments/apps routes; 404 when
 * the org does not exist (a super-admin can reach any slug, so this is the reachable 404 case). */
export async function handleOrgInspect(
  req: IncomingMessage,
  res: ServerResponse,
  gate: DeployAuthGate,
  controlPlane: ControlPlaneStore,
  ref: { org: string },
): Promise<void> {
  const identity = await authorizeTenantControl(req, res, gate, controlPlane, ref.org);
  if (identity === false) return;
  const org = await controlPlane.getOrg(ref.org);
  if (org === undefined) return sendJson(res, 404, { error: 'not found' });
  return sendJson(res, 200, { ok: true, data: OrgSummarySchema.parse(org) });
}

export async function handleMembers(
  req: IncomingMessage,
  res: ServerResponse,
  gate: DeployAuthGate,
  controlPlane: ControlPlaneStore,
  maxBody: number,
  ref: { org: string; subject?: string },
  audit: AuditSink,
): Promise<void> {
  const identity = await authorizeControlPlane(req, res, gate, { requireIdentity: true });
  if (identity === false) return;
  if (req.method === 'GET' && ref.subject === undefined) {
    if (!(await canViewMembers(controlPlane, ref.org, identity)))
      return sendForbidden(res, 'forbidden');
    try {
      return sendJson(res, 200, { ok: true, members: await controlPlane.listOrgMembers(ref.org) });
    } catch (error) {
      return sendJson(res, 400, { error: (error as Error).message });
    }
  }
  if (req.method === 'POST' && ref.subject === undefined) {
    if (!(await canManageMembers(controlPlane, ref.org, identity)))
      return sendForbidden(res, 'forbidden');
    const body = await readJsonBody(req, maxBody);
    if (!body.ok) return sendJson(res, body.status, { error: body.error });
    const parsed = body.value as { subject?: unknown; email?: unknown; role?: unknown };
    if (typeof parsed.subject !== 'string') {
      return sendJson(res, 400, { error: '"subject" must be a string' });
    }
    if (typeof parsed.email !== 'string') {
      return sendJson(res, 400, { error: '"email" must be a string' });
    }
    let role: OrgRole;
    try {
      role = validateOrgRole(typeof parsed.role === 'string' ? parsed.role : 'developer');
    } catch (error) {
      return sendJson(res, 400, { error: (error as Error).message });
    }
    try {
      // The add route upserts, so re-adding an existing owner with a weaker role is also a demotion.
      if (await demotesLastOwner(controlPlane, ref.org, parsed.subject, role)) {
        return sendJson(res, 409, { error: 'cannot demote the last owner' });
      }
      const member = await controlPlane.addOrgMember({
        org: ref.org,
        subject: parsed.subject,
        email: parsed.email,
        role,
      });
      await emitOrgAudit(audit, 'org.member.added', ref.org, identity, 201, {
        subject: parsed.subject,
        role,
      });
      return sendJson(res, 201, { ok: true, member });
    } catch (error) {
      return sendMemberMutationError(res, error);
    }
  }
  if (req.method === 'PATCH' && ref.subject !== undefined) {
    if (!(await canManageMembers(controlPlane, ref.org, identity)))
      return sendForbidden(res, 'forbidden');
    const body = await readJsonBody(req, maxBody);
    if (!body.ok) return sendJson(res, body.status, { error: body.error });
    const parsed = body.value as { role?: unknown };
    let role: OrgRole;
    try {
      role = validateOrgRole(typeof parsed.role === 'string' ? parsed.role : '');
    } catch (error) {
      return sendJson(res, 400, { error: (error as Error).message });
    }
    try {
      if (await demotesLastOwner(controlPlane, ref.org, ref.subject, role)) {
        return sendJson(res, 409, { error: 'cannot demote the last owner' });
      }
      const member = await controlPlane.updateOrgMemberRole({
        org: ref.org,
        subject: ref.subject,
        role,
      });
      if (member === undefined) return sendJson(res, 404, { error: 'not found' });
      await emitOrgAudit(audit, 'org.member.role_changed', ref.org, identity, 200, {
        subject: ref.subject,
        role,
      });
      return sendJson(res, 200, { ok: true, member });
    } catch (error) {
      return sendMemberMutationError(res, error);
    }
  }
  if (req.method === 'DELETE' && ref.subject !== undefined) {
    if (!(await canManageMembers(controlPlane, ref.org, identity)))
      return sendForbidden(res, 'forbidden');
    if (await demotesLastOwner(controlPlane, ref.org, ref.subject, undefined)) {
      return sendJson(res, 409, { error: 'cannot remove the last owner' });
    }
    try {
      const removed = await controlPlane.removeOrgMember({ org: ref.org, subject: ref.subject });
      if (removed) {
        await emitOrgAudit(audit, 'org.member.removed', ref.org, identity, 204, {
          subject: ref.subject,
        });
      }
      res.writeHead(204);
      res.end();
      return;
    } catch (error) {
      return sendMemberMutationError(res, error);
    }
  }
  return sendJson(res, 404, { error: 'not found' });
}

function sendMemberMutationError(res: ServerResponse, error: unknown): void {
  sendJson(res, error instanceof PersonalWorkspaceOwnerMutationError ? 409 : 400, {
    error: (error as Error).message,
  });
}

export async function handleInvitations(
  req: IncomingMessage,
  res: ServerResponse,
  gate: DeployAuthGate,
  controlPlane: ControlPlaneStore,
  maxBody: number,
  ref: { org: string; token?: string; action?: 'accept' },
  audit: AuditSink,
  url?: URL,
  invitationEmail: {
    readonly sender?: InvitationEmailSender;
    readonly consoleBaseUrl?: string;
  } = {},
  now: () => Date = () => new Date(),
): Promise<void> {
  const identity = await authorizeControlPlane(req, res, gate, { requireIdentity: true });
  if (identity === false) return;
  if (req.method === 'GET' && ref.token === undefined) {
    if (!(await canManageMembers(controlPlane, ref.org, identity)))
      return sendForbidden(res, 'forbidden');
    const includeAll = url?.searchParams.get('all') === 'true';
    try {
      const records = await controlPlane.listOrgInvitations(ref.org);
      const invitations = records
        .map((record) => publicInvitation(record, now))
        .filter((invitation) => includeAll || invitation.status === 'pending');
      return sendJson(res, 200, { ok: true, invitations });
    } catch (error) {
      return sendJson(res, 400, { error: (error as Error).message });
    }
  }
  if (req.method === 'POST' && ref.token === undefined) {
    if (!(await canManageMembers(controlPlane, ref.org, identity)))
      return sendForbidden(res, 'forbidden');
    const body = await readJsonBody(req, maxBody);
    if (!body.ok) return sendJson(res, body.status, { error: body.error });
    const parsed = body.value as { email?: unknown; role?: unknown };
    if (typeof parsed.email !== 'string')
      return sendJson(res, 400, { error: '"email" must be a string' });
    let role: OrgRole;
    try {
      role = validateOrgRole(typeof parsed.role === 'string' ? parsed.role : 'developer');
    } catch (error) {
      return sendJson(res, 400, { error: (error as Error).message });
    }
    const rawToken = randomToken();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(now().getTime() + ORG_INVITATION_TTL_MS);
    const invitation = await controlPlane.createOrgInvitation({
      org: ref.org,
      email: parsed.email,
      role,
      tokenHash,
      createdBySubject: identity.subject,
      createdByEmail: identity.email,
      expiresAt,
    });
    await emitOrgAudit(audit, 'org.invitation.created', ref.org, identity, 201, {
      email: invitation.email,
      role,
    });
    const acceptPath = invitationAcceptPath(ref.org, rawToken);
    let emailDelivery: 'sent' | 'not_configured' | 'failed' = 'not_configured';
    if (invitationEmail.sender !== undefined && invitationEmail.consoleBaseUrl !== undefined) {
      try {
        const org = await controlPlane.getOrg(ref.org);
        await invitationEmail.sender.sendInvitation({
          invitationId: tokenHash,
          email: invitation.email,
          inviterEmail: identity.email,
          orgName: org?.displayName ?? ref.org,
          role,
          acceptUrl: invitationConsoleUrl(invitationEmail.consoleBaseUrl, ref.org, rawToken),
          expiresAt: invitation.expiresAt,
        });
        emailDelivery = 'sent';
      } catch {
        emailDelivery = 'failed';
      }
    }
    return sendJson(res, 201, {
      ok: true,
      invitation: publicInvitation(invitation, now),
      acceptPath,
      emailDelivery,
    });
  }
  if (req.method === 'DELETE' && ref.token === undefined) {
    if (!(await canManageMembers(controlPlane, ref.org, identity)))
      return sendForbidden(res, 'forbidden');
    const body = await readJsonBody(req, maxBody);
    if (!body.ok) return sendJson(res, body.status, { error: body.error });
    const parsed = body.value as { email?: unknown };
    if (typeof parsed.email !== 'string' || parsed.email.trim() === '')
      return sendJson(res, 400, { error: '"email" must be a string' });
    try {
      const revoked = await controlPlane.revokeOrgInvitation({
        org: ref.org,
        email: parsed.email,
      });
      await emitOrgAudit(audit, 'org.invitation.revoked', ref.org, identity, 200, {
        email: parsed.email.toLowerCase(),
        revoked,
      });
      return sendJson(res, 200, { ok: true, revoked });
    } catch (error) {
      return sendJson(res, 400, { error: (error as Error).message });
    }
  }
  if (req.method === 'POST' && ref.token !== undefined && ref.action === 'accept') {
    const tokenHash = hashToken(ref.token);
    const invitation = await controlPlane.getOrgInvitation({ tokenHash });
    if (invitation === undefined || invitation.orgSlug !== ref.org) {
      return sendJson(res, 404, { error: 'not found' });
    }
    if (identity.email.toLowerCase() !== invitation.email) {
      return sendForbidden(res, 'forbidden');
    }
    const consumed = await controlPlane.consumeOrgInvitation({ tokenHash });
    if (consumed === undefined) return sendJson(res, 404, { error: 'not found' });
    const member = await controlPlane.addOrgMember({
      org: consumed.orgSlug,
      subject: identity.subject,
      email: identity.email,
      role: consumed.role,
    });
    await emitOrgAudit(audit, 'org.invitation.accepted', consumed.orgSlug, identity, 201, {
      email: consumed.email,
      role: consumed.role,
    });
    return sendJson(res, 201, { ok: true, member });
  }
  return sendJson(res, 404, { error: 'not found' });
}

export async function handleOpenAIAppsChallenge(
  req: IncomingMessage,
  res: ServerResponse,
  gate: DeployAuthGate,
  controlPlane: ControlPlaneStore,
  maxBody: number,
  ref: { org: string },
  audit: AuditSink,
  publicBaseDomain?: string,
): Promise<void> {
  const identity = await authorizeControlPlane(req, res, gate, { requireIdentity: true });
  if (identity === false) return;
  if (req.method === 'GET') {
    if (!(await canViewMembers(controlPlane, ref.org, identity)))
      return sendForbidden(res, 'forbidden');
    const record = await controlPlane.getOrgOpenAIAppsChallenge(ref.org);
    const { mcpSubdomain } = await mcpSubdomainEndpointOptions(
      controlPlane,
      ref.org,
      publicBaseDomain,
    );
    return sendJson(res, 200, {
      ok: true,
      data: publicOpenAIAppsChallenge(ref.org, record, publicBaseDomain, mcpSubdomain),
    });
  }
  if (req.method === 'PUT') {
    if (!(await canManageMembers(controlPlane, ref.org, identity)))
      return sendForbidden(res, 'forbidden');
    const body = await readJsonBody(req, maxBody);
    if (!body.ok) return sendJson(res, body.status, { error: body.error });
    const parsed = body.value as { challenge?: unknown };
    if (typeof parsed.challenge !== 'string') {
      return sendJson(res, 400, { error: '"challenge" must be a string' });
    }
    try {
      const record = await controlPlane.setOrgOpenAIAppsChallenge({
        org: ref.org,
        challenge: parsed.challenge,
        updatedBySubject: identity.subject,
        ...(identity.email !== undefined ? { updatedByEmail: identity.email } : {}),
      });
      await emitOrgAudit(audit, 'org.openai_apps_challenge.set', ref.org, identity, 200, {
        action: 'set',
      });
      const { mcpSubdomain } = await mcpSubdomainEndpointOptions(
        controlPlane,
        ref.org,
        publicBaseDomain,
      );
      return sendJson(res, 200, {
        ok: true,
        data: publicOpenAIAppsChallenge(ref.org, record, publicBaseDomain, mcpSubdomain),
      });
    } catch (error) {
      return sendJson(res, 400, { error: (error as Error).message });
    }
  }
  if (req.method === 'DELETE') {
    if (!(await canManageMembers(controlPlane, ref.org, identity)))
      return sendForbidden(res, 'forbidden');
    const cleared = await controlPlane.clearOrgOpenAIAppsChallenge(ref.org);
    await emitOrgAudit(audit, 'org.openai_apps_challenge.cleared', ref.org, identity, 200, {
      action: 'clear',
      cleared: cleared ? 1 : 0,
    });
    return sendJson(res, 200, { ok: true, cleared });
  }
  return sendJson(res, 404, { error: 'not found' });
}

export async function canViewMembers(
  store: ControlPlaneStore,
  org: string,
  identity: ControlPlaneIdentity,
): Promise<boolean> {
  if (identity.superAdmin) return true;
  return (await store.getOrgMember({ org, subject: identity.subject })) !== undefined;
}

function publicOpenAIAppsChallenge(
  org: string,
  record: Awaited<ReturnType<ControlPlaneStore['getOrgOpenAIAppsChallenge']>> | undefined,
  publicBaseDomain?: string,
  mcpSubdomain?: string,
) {
  return {
    orgSlug: org,
    configured: record !== undefined,
    challengeUrl: openAIAppsChallengeUrl(mcpSubdomain, publicBaseDomain),
    ...(record !== undefined
      ? {
          challenge: record.challenge,
          updatedAt: record.updatedAt,
          ...(record.updatedByEmail !== undefined ? { updatedByEmail: record.updatedByEmail } : {}),
        }
      : {}),
  };
}

function openAIAppsChallengeUrl(
  mcpSubdomain: string | undefined,
  publicBaseDomain: string | undefined,
): string | null {
  if (publicBaseDomain === undefined || mcpSubdomain === undefined) return null;
  return `https://${encodeURIComponent(mcpSubdomain)}.${normalizePublicBaseDomain(publicBaseDomain)}${OPENAI_APPS_CHALLENGE_PATH}`;
}

export async function canManageMembers(
  store: ControlPlaneStore,
  org: string,
  identity: ControlPlaneIdentity,
): Promise<boolean> {
  if (identity.superAdmin) return true;
  return (await store.getOrgMember({ org, subject: identity.subject }))?.role === 'owner';
}

/**
 * True when giving `subject` a non-owner role (or removing it, `newRole === undefined`) would leave the
 * org with no owner at all. Applies to every caller, including super-admins — the invariant protects the
 * org, not the actor; add another owner first.
 */
async function demotesLastOwner(
  store: ControlPlaneStore,
  org: string,
  subject: string,
  newRole: OrgRole | undefined,
): Promise<boolean> {
  if (newRole === 'owner') return false;
  const current = await store.getOrgMember({ org, subject });
  if (current?.role !== 'owner') return false;
  const members = await store.listOrgMembers(org);
  return !members.some((member) => member.role === 'owner' && member.subject !== subject);
}

type OrgInvitationStatus = 'pending' | 'accepted' | 'expired';

/** The invitation shape safe to return to org owners: everything except the token hash. */
interface PublicOrgInvitation {
  readonly orgSlug: string;
  readonly email: string;
  readonly role: OrgRole;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly createdBySubject: string;
  readonly createdByEmail?: string;
  readonly acceptedAt?: string;
  readonly status: OrgInvitationStatus;
}

function publicInvitation(invitation: OrgInvitationRecord, now: () => Date): PublicOrgInvitation {
  const status: OrgInvitationStatus =
    invitation.acceptedAt !== undefined
      ? 'accepted'
      : Date.parse(invitation.expiresAt) <= now().getTime()
        ? 'expired'
        : 'pending';
  return {
    orgSlug: invitation.orgSlug,
    email: invitation.email,
    role: invitation.role,
    createdAt: invitation.createdAt,
    expiresAt: invitation.expiresAt,
    createdBySubject: invitation.createdBySubject,
    ...(invitation.createdByEmail !== undefined
      ? { createdByEmail: invitation.createdByEmail }
      : {}),
    ...(invitation.acceptedAt !== undefined ? { acceptedAt: invitation.acceptedAt } : {}),
    status,
  };
}

function invitationAcceptPath(org: string, token: string): string {
  return `/v1/orgs/${encodeURIComponent(org)}/invitations/${encodeURIComponent(token)}/accept`;
}

function invitationConsoleUrl(baseUrl: string, org: string, token: string): string {
  const url = new URL('/invitations/accept', baseUrl);
  url.searchParams.set('org', org);
  url.hash = new URLSearchParams({ token }).toString();
  return url.toString();
}

/**
 * Emit one org-administration audit event. Details are flat scalars (subjects, emails, roles, counts,
 * display names) — never invitation tokens, token hashes, or bearer material.
 */
export function emitOrgAudit(
  audit: AuditSink,
  eventType: string,
  org: string,
  identity: ControlPlaneIdentity,
  status: number,
  details: Readonly<Record<string, string | number>>,
): Promise<void> {
  return audit.emit({
    eventType,
    org,
    decision: 'allow',
    status,
    actorSubject: identity.subject,
    ...(identity.email !== undefined ? { actorEmail: identity.email } : {}),
    details,
  });
}
