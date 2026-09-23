import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJsonBody, sendJson } from '@noodle-borg/transport-http';
import { ConversationReviewRequestSchema } from '@noodle-borg/wire-contracts';
import type { BusinessPermission } from '../business-information/contracts.js';
import {
  type ApplicationConversations,
  ConversationHistoryError,
  type ConversationWorkingMemoryEraser,
} from '../conversation-history/operator.js';
import {
  type BusinessInformationRouteDeps,
  requireIdentity,
  requireInstallationPermission,
} from './business-information.js';
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
  let permissions: readonly BusinessPermission[] = [PERMISSIONS[route]];
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
    if (await authorize()) sendJson(res, 200, result.response);
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
