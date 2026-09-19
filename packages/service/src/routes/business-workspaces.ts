import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJsonBody, sendJson } from '@noodle-borg/transport-http';
import {
  BusinessWorkspaceAcceptRequestSchema,
  BusinessWorkspaceInvitationRequestSchema,
  BusinessWorkspaceIssuedInvitationResponseSchema,
  BusinessWorkspaceMutationResponseSchema,
  BusinessWorkspaceResponseSchema,
  BusinessWorkspaceRevisionRequestSchema,
  BusinessWorkspaceRoleChangeRequestSchema,
} from '@noodle-borg/wire-contracts';
import { admitBusinessTarget, authorizeBusinessApi } from '../business-api-admission.js';
import { BusinessWorkspaceError } from '../business-workspaces/contracts.js';
import {
  businessWorkspaceMethod,
  parseBusinessWorkspacePath,
} from '../business-workspaces/paths.js';
import type { ServiceOptions } from '../options.js';
import type { ApplicationDraftRouteDeps } from './application-drafts.js';

type Deps = Omit<ApplicationDraftRouteDeps, 'drafts'> &
  Pick<NonNullable<ServiceOptions['businessAuthoring']>, 'verifiedEmail'>;

export async function handleBusinessWorkspaceRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: Deps,
): Promise<void> {
  res.setHeader('cache-control', 'private, no-store');
  try {
    await handle(req, res, url, deps);
  } catch (error) {
    if (error instanceof BusinessWorkspaceError) {
      const status =
        error.code === 'forbidden'
          ? 403
          : error.code === 'invalid_request'
            ? 400
            : error.code === 'not_found'
              ? 404
              : 409;
      return sendJson(res, status, {
        error: error.code.replaceAll('_', ' '),
        code: error.code,
        ...(error.currentRevision === undefined ? {} : { currentRevision: error.currentRevision }),
      });
    }
    sendJson(res, 503, {
      error: 'Workspace access is temporarily unavailable.',
      code: 'workspace_unavailable',
    });
  }
}

async function handle(req: IncomingMessage, res: ServerResponse, url: URL, deps: Deps) {
  const ref = parseBusinessWorkspacePath(url.pathname);
  if (!ref) return sendJson(res, 404, { error: 'not found' });
  const identity = await authorizeBusinessApi(req, res, deps);
  if (!identity) return;
  const method = businessWorkspaceMethod(ref);
  if (req.method !== method) {
    res.setHeader('allow', method);
    return sendJson(res, 405, { error: 'method not allowed' });
  }
  if ([...url.searchParams].length) return invalid(res);
  const { org } = ref;
  if (ref.action !== 'accept') {
    const state = await deps.workspaces.inspect(org, identity.subject);
    if (ref.action && !state.permissions.includes('team:manage'))
      throw new BusinessWorkspaceError('forbidden');
    if (!(await admitBusinessTarget(res, { org }))) return;
    if (!ref.action)
      return sendJson(res, 200, BusinessWorkspaceResponseSchema.parse({ ok: true, data: state }));
  }
  const body = await readJsonBody(req, Math.min(deps.maxBody, 16 * 1024));
  if (!body.ok) return sendJson(res, body.status, { error: body.error });
  if (ref.action === 'accept') {
    const input = BusinessWorkspaceAcceptRequestSchema.safeParse(body.value);
    if (!input.success) return invalid(res);
    const email = await deps.verifiedEmail?.(identity.subject, identity.email);
    if (!email)
      return sendJson(res, 403, {
        error: 'Sign in with a verified invited email address.',
        code: 'verified_email_required',
      });
    // Subject admission already ran. The opaque one-use invitation supplies authority, not the org in the URL.
    const result = await deps.workspaces.accept({
      org,
      subject: identity.subject,
      verifiedEmail: email,
      token: input.data.token,
    });
    return sendJson(
      res,
      200,
      BusinessWorkspaceMutationResponseSchema.parse({ ok: true, data: result }),
    );
  }
  if (ref.action === 'invitations' && !ref.id) {
    const input = BusinessWorkspaceInvitationRequestSchema.safeParse(body.value);
    if (!input.success) return invalid(res);
    const result = await deps.workspaces.invite({ ...input.data, org, actor: identity.subject });
    return sendJson(
      res,
      201,
      BusinessWorkspaceIssuedInvitationResponseSchema.parse({ ok: true, data: result }),
    );
  }
  if (ref.action === 'invitations' && ref.id) {
    const input = BusinessWorkspaceRevisionRequestSchema.safeParse(body.value);
    if (!input.success) return invalid(res);
    const result = await deps.workspaces.revokeInvitation({
      ...input.data,
      org,
      actor: identity.subject,
      invitationId: ref.id,
    });
    return sendJson(
      res,
      200,
      BusinessWorkspaceMutationResponseSchema.parse({ ok: true, data: result }),
    );
  }
  const input = BusinessWorkspaceRoleChangeRequestSchema.safeParse(body.value);
  if (!input.success) return invalid(res);
  const result = await deps.workspaces.changeRole({ ...input.data, org, actor: identity.subject });
  return sendJson(
    res,
    200,
    BusinessWorkspaceMutationResponseSchema.parse({ ok: true, data: result }),
  );
}

function invalid(res: ServerResponse) {
  return sendJson(res, 400, { error: 'Invalid workspace request.', code: 'invalid_request' });
}
