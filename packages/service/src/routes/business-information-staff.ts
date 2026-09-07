import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJsonBody, sendJson } from '@noodle-borg/transport-http';
import {
  BusinessInvitationCreateRequestSchema,
  BusinessInvitationRevokeRequestSchema,
  formatWireError,
} from '@noodle-borg/wire-contracts';
import type { SolutionInstallation } from '../business-information/contracts.js';
import { hashToken } from '../oauth/tokens.js';
import {
  type BusinessInformationRouteDeps,
  requireIdentity,
  requireInstallationPermission,
} from './business-information.js';
import type { SolutionInstallationRef } from './business-information-paths.js';
import { parseBusinessPaging } from './business-information-request.js';
import { grantToWire, installationToWire, invitationToWire } from './business-information-wire.js';

const HOUR_MS = 60 * 60 * 1_000;

export async function handleMySolutionInstallations(
  req: IncomingMessage,
  res: ServerResponse,
  deps: BusinessInformationRouteDeps,
): Promise<void> {
  if (req.method !== 'GET') return methodNotAllowed(res);
  const identity = await requireIdentity(req, res, deps);
  if (identity === false) return;
  const paging = parseBusinessPaging(new URL(req.url ?? '/', 'http://service.invalid'), 100);
  if (!paging.ok) return sendJson(res, 400, { error: paging.error });
  const after =
    paging.value.cursor === undefined ? undefined : decodeDiscoveryCursor(paging.value.cursor);
  if (paging.value.cursor !== undefined && after === undefined) {
    return sendJson(res, 400, { error: 'cursor is invalid' });
  }
  const limit = paging.value.limit ?? 100;
  const joined = [...(await deps.store.listInstallationsForSubject(identity.subject))]
    .sort((left, right) => compareDiscoveryRows(left, right))
    .filter((item) => after === undefined || discoveryOrderKey(item) > after)
    .slice(0, limit + 1);
  const visible = joined.slice(0, limit);
  sendJson(res, 200, {
    ok: true,
    data: {
      installations: visible.map(({ installation, grant }) =>
        installationToWire(installation, grant.role),
      ),
      ...(joined.length > limit && visible.at(-1) !== undefined
        ? { nextCursor: encodeDiscoveryCursor(visible.at(-1) as (typeof visible)[number]) }
        : {}),
    },
  });
}

export async function handleBusinessInvitations(
  req: IncomingMessage,
  res: ServerResponse,
  ref: SolutionInstallationRef,
  deps: BusinessInformationRouteDeps,
): Promise<void> {
  const identity = await requireIdentity(req, res, deps);
  if (identity === false) return;
  const authorized = await requireInstallationPermission(res, ref, identity, 'grants:manage', deps);
  if (authorized === undefined) return;
  res.setHeader('cache-control', 'no-store');
  const now = deps.now?.() ?? new Date();
  if (req.method === 'GET' && ref.invitationId === undefined) {
    const invitations = await deps.store.listInvitations(authorized.scope);
    return sendJson(res, 200, {
      ok: true,
      data: { invitations: invitations.slice(0, 100).map((item) => invitationToWire(item, now)) },
    });
  }
  if (req.method === 'POST' && ref.invitationId === undefined) {
    const body = await readJsonBody(req, deps.maxBody);
    if (!body.ok) return sendJson(res, body.status, { error: body.error });
    const parsed = BusinessInvitationCreateRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      return sendJson(res, 400, { error: formatWireError(parsed.error) });
    }
    const result = await deps.store.createInvitation({
      scope: authorized.scope,
      invitationId: `binv_${randomUUID().replaceAll('-', '')}`,
      email: parsed.data.email,
      role: parsed.data.role,
      tokenDigest: hashToken(parsed.data.token),
      idempotencyKey: parsed.data.idempotencyKey,
      expiresAt: new Date(now.getTime() + parsed.data.expiresInHours * HOUR_MS),
      actorSubject: identity.subject,
    });
    if (result.disposition === 'conflict') {
      return sendJson(res, 409, {
        error: 'idempotency key was already used for a different invitation',
        code: 'idempotency_conflict',
      });
    }
    await emitStaffAudit(deps, {
      eventType: 'business.invitation.created',
      org: authorized.scope.org,
      subject: identity.subject,
      email: identity.email,
      details: {
        installationId: authorized.scope.installationId,
        invitationId: result.invitation.invitationId,
        invitedEmail: result.invitation.email,
        role: result.invitation.role,
        replayed: result.disposition === 'replayed' ? 1 : 0,
      },
    });
    return sendJson(res, result.disposition === 'created' ? 201 : 200, {
      ok: true,
      data: {
        invitation: invitationToWire(result.invitation, now),
        acceptPath: `/portal-invitations/${encodeURIComponent(parsed.data.token)}`,
        replayed: result.disposition === 'replayed',
      },
    });
  }
  if (req.method === 'DELETE' && ref.invitationId !== undefined) {
    const body = await readJsonBody(req, deps.maxBody);
    if (!body.ok) return sendJson(res, body.status, { error: body.error });
    const parsed = BusinessInvitationRevokeRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      return sendJson(res, 400, { error: formatWireError(parsed.error) });
    }
    const result = await deps.store.revokeInvitation({
      scope: authorized.scope,
      invitationId: ref.invitationId,
      expectedRevision: parsed.data.expectedRevision,
      actorSubject: identity.subject,
    });
    if (!result.ok) {
      const status = result.reason === 'not_found' ? 404 : result.reason === 'conflict' ? 409 : 422;
      return sendJson(res, status, {
        error: result.reason.replaceAll('_', ' '),
        code: result.reason,
        currentRevision: result.currentRevision,
      });
    }
    await emitStaffAudit(deps, {
      eventType: 'business.invitation.revoked',
      org: authorized.scope.org,
      subject: identity.subject,
      email: identity.email,
      details: {
        installationId: authorized.scope.installationId,
        invitationId: result.invitation.invitationId,
      },
    });
    return sendJson(res, 200, {
      ok: true,
      data: { invitation: invitationToWire(result.invitation, now) },
    });
  }
  methodNotAllowed(res);
}

export async function handleBusinessInvitationAccept(
  req: IncomingMessage,
  res: ServerResponse,
  rawToken: string,
  deps: BusinessInformationRouteDeps,
): Promise<void> {
  if (req.method !== 'POST') return methodNotAllowed(res);
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(rawToken)) {
    return sendJson(res, 404, {
      error: 'invitation is unavailable',
      code: 'invitation_unavailable',
    });
  }
  const identity = await requireIdentity(req, res, deps);
  if (identity === false) return;
  res.setHeader('cache-control', 'no-store');
  const result = await deps.store.claimInvitation({
    tokenDigest: hashToken(rawToken),
    subject: identity.subject,
    email: identity.email,
  });
  if (!result.ok) {
    if (result.reason === 'last_administrator') {
      return sendJson(res, 409, {
        error: 'another administrator is required before accepting this role',
        code: 'last_administrator',
      });
    }
    const status =
      result.reason === 'email_mismatch' ? 403 : result.reason === 'not_found' ? 404 : 410;
    return sendJson(res, status, {
      error:
        result.reason === 'email_mismatch'
          ? 'sign in with the invited email address'
          : 'invitation is unavailable',
      code: result.reason === 'email_mismatch' ? result.reason : 'invitation_unavailable',
    });
  }
  const installation = await deps.store.getInstallation(result.grant.scope);
  if (installation === undefined) throw new Error('claimed invitation installation is missing');
  await emitStaffAudit(deps, {
    eventType: 'business.invitation.accepted',
    org: result.grant.scope.org,
    subject: identity.subject,
    email: identity.email,
    details: {
      installationId: result.grant.scope.installationId,
      invitationId: result.invitation.invitationId,
      role: result.grant.role,
    },
  });
  sendJson(res, 201, {
    ok: true,
    data: {
      installation: installationToWire(installation, result.grant.role),
      grant: grantToWire(result.grant),
    },
  });
}

export async function handleEligibleBusinessAssignees(
  req: IncomingMessage,
  res: ServerResponse,
  ref: SolutionInstallationRef,
  deps: BusinessInformationRouteDeps,
): Promise<void> {
  if (req.method !== 'GET') return methodNotAllowed(res);
  const identity = await requireIdentity(req, res, deps);
  if (identity === false) return;
  const authorized = await requireInstallationPermission(
    res,
    ref,
    identity,
    'records:assign',
    deps,
  );
  if (authorized === undefined) return;
  const grants = await deps.store.listEligibleAssignees(authorized.scope);
  sendJson(res, 200, {
    ok: true,
    data: {
      assignees: grants
        .map((grant) => ({ subject: grant.subject, email: grant.email, role: grant.role }))
        .slice(0, 100),
    },
  });
}

function methodNotAllowed(res: ServerResponse): void {
  res.setHeader('allow', 'GET, POST, DELETE');
  sendJson(res, 405, { error: 'method not allowed' });
}

function discoveryOrderKey(item: { readonly installation: SolutionInstallation }): string {
  return `${item.installation.createdAt}\0${item.installation.scope.org}\0${item.installation.scope.installationId}`;
}

function compareDiscoveryRows(
  left: Parameters<typeof discoveryOrderKey>[0],
  right: Parameters<typeof discoveryOrderKey>[0],
): number {
  const leftKey = discoveryOrderKey(left);
  const rightKey = discoveryOrderKey(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function encodeDiscoveryCursor(item: Parameters<typeof discoveryOrderKey>[0]): string {
  return Buffer.from(discoveryOrderKey(item), 'utf8').toString('base64url');
}

function decodeDiscoveryCursor(raw: string): string | undefined {
  if (!/^[A-Za-z0-9_-]{1,1024}$/.test(raw)) return undefined;
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const parts = decoded.split('\0');
    if (
      parts.length !== 3 ||
      Number.isNaN(Date.parse(parts[0] ?? '')) ||
      !/^[a-z0-9][a-z0-9-]{0,62}$/.test(parts[1] ?? '') ||
      (parts[2]?.length ?? 0) < 1 ||
      (parts[2]?.length ?? 0) > 256
    ) {
      return undefined;
    }
    return decoded;
  } catch {
    return undefined;
  }
}

async function emitStaffAudit(
  deps: BusinessInformationRouteDeps,
  event: {
    readonly eventType: string;
    readonly org: string;
    readonly subject: string;
    readonly email: string;
    readonly details: Readonly<Record<string, string | number>>;
  },
): Promise<void> {
  await deps.audit?.emit({
    eventType: event.eventType,
    org: event.org,
    decision: 'allow',
    status: 200,
    actorSubject: event.subject,
    actorEmail: event.email,
    details: event.details,
  });
}
