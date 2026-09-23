import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ControlPlaneIdentity } from '@noodle-borg/control-plane/portable';
import { readJsonBody, sendJson } from '@noodle-borg/transport-http';
import { ConversationReviewRequestSchema } from '@noodle-borg/wire-contracts';
import type { BusinessPermission } from '../business-information/contracts.js';
import { businessGrantAllows } from '../business-information/model.js';
import {
  type ApplicationConversations,
  ConversationHistoryError,
  type ConversationWorkingMemoryEraser,
} from '../conversation-history/operator.js';
import { sendForbidden } from '../http-util.js';
import {
  type BusinessInformationRouteDeps,
  requireIdentity,
  requireInstallationPermission,
} from './business-information.js';
import { resolveBusinessStaffGrant } from './business-information-access.js';
import type { SolutionInstallationRef } from './business-information-paths.js';

export interface BusinessConversationRouteDeps extends BusinessInformationRouteDeps {
  readonly conversations?: ApplicationConversations;
  /** Erases a WhatsApp participant's working memory when their history is forgotten. */
  readonly forgetWhatsApp?: ConversationWorkingMemoryEraser;
}

/**
 * ADR 0241 decision 10: readers see text; reviewing and noting need the record-handling permissions an
 * Operator holds; only export and erasure need Owner/Administrator authority.
 */
const PERMISSIONS: Readonly<
  Record<NonNullable<SolutionInstallationRef['conversationAction']>, BusinessPermission>
> = {
  list: 'records:read',
  show: 'records:read',
  export: 'records:export',
  forget: 'records:delete',
};
const METHODS: Readonly<
  Record<NonNullable<SolutionInstallationRef['conversationAction']>, readonly string[]>
> = { list: ['GET'], show: ['GET', 'PATCH'], export: ['GET'], forget: ['POST'] };

export async function handleApplicationConversations(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ref: SolutionInstallationRef,
  deps: BusinessConversationRouteDeps,
): Promise<void> {
  const route = ref.conversationAction ?? 'list';
  const methods = METHODS[route];
  if (!methods.includes(req.method ?? '')) {
    res.setHeader('allow', methods.join(', '));
    return sendJson(res, 405, { error: 'method not allowed' });
  }
  const action = req.method === 'PATCH' ? 'review' : route;
  const identity = await requireIdentity(req, res, deps);
  if (identity === false) return;
  // A review's permissions follow its fields, so it is read-authorized before its body is parsed.
  let permissions: readonly BusinessPermission[] = [
    action === 'list' || action === 'show'
      ? await readPermission(ref, identity, deps)
      : PERMISSIONS[route],
  ];
  const authorize = async () => {
    const [last = PERMISSIONS[route], ...earlier] = [...permissions].reverse();
    for (const permission of earlier)
      if (!(await requireInstallationPermission(res, ref, identity, permission, deps)))
        return false;
    return requireInstallationPermission(res, ref, identity, last, deps);
  };
  const authorized = await authorize();
  if (!authorized) return;
  res.setHeader('cache-control', 'private, no-store');
  try {
    if (!deps.conversations) throw new ConversationHistoryError('conversation_unavailable');
    let body: unknown;
    if (req.method !== 'GET') {
      const parsed = await readJsonBody(req, deps.maxBody);
      if (!parsed.ok) return sendJson(res, parsed.status, { error: parsed.error });
      body = parsed.value;
      if (action === 'review') {
        const review = ConversationReviewRequestSchema.safeParse(body);
        if (!review.success) throw new ConversationHistoryError('conversation_invalid');
        permissions = [
          ...(review.data.reviewStatus === undefined ? [] : ['records:status' as const]),
          ...(review.data.note === undefined ? [] : ['records:note' as const]),
        ];
      }
      if (!(await authorize())) return;
    }
    const fence = permissions.at(-1) ?? PERMISSIONS[route];
    const result = await deps.conversations.project(
      authorized.scope,
      action,
      {
        parameters: [...url.searchParams.entries()],
        ...(ref.conversationId === undefined ? {} : { conversationId: ref.conversationId }),
        body,
        actor: identity.subject,
        ...(deps.forgetWhatsApp ? { forgetWorkingMemory: deps.forgetWhatsApp } : {}),
      },
      (operation) => deps.store.staff.run(authorized.scope, identity.subject, fence, operation),
    );
    for (const event of result.audits)
      await deps.audit?.emit({
        ...event,
        org: ref.org,
        app: authorized.scope.app,
        env: authorized.scope.env,
        actorSubject: identity.subject,
      });
    if (!(await authorize())) return;
    // A Preview read is answered only while the environment is still a Preview.
    if (fence === 'drafts:preview' && !(await deps.conversations.isPreview(authorized.scope)))
      return sendForbidden(res, 'business permission required: records:read');
    sendJson(res, 200, result.response);
  } catch (error) {
    if (!(error instanceof ConversationHistoryError)) throw error;
    sendJson(
      res,
      error.code === 'conversation_not_found'
        ? 404
        : error.code === 'conversation_unavailable'
          ? 503
          : 400,
      { code: error.code, error: error.message },
    );
  }
}

/**
 * ADR 0241 decision 18: a Builder never holds `records:read`, but reads a Preview environment's
 * conversations under `drafts:preview`. Every other caller keeps the ordinary read permission, so a
 * production installation still denies Builders.
 */
async function readPermission(
  ref: SolutionInstallationRef,
  identity: ControlPlaneIdentity,
  deps: BusinessConversationRouteDeps,
): Promise<BusinessPermission> {
  if (ref.installationId === undefined || !deps.conversations) return 'records:read';
  const installation = await deps.store.getInstallationById(ref.org, ref.installationId);
  if (installation === undefined) return 'records:read';
  const grant = await resolveBusinessStaffGrant(deps, installation.scope, identity.subject);
  return !businessGrantAllows(grant, 'records:read') &&
    businessGrantAllows(grant, 'drafts:preview') &&
    (await deps.conversations.isPreview(installation.scope))
    ? 'drafts:preview'
    : 'records:read';
}
