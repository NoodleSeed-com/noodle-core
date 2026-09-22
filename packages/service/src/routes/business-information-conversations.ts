import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJsonBody, sendJson } from '@noodle-borg/transport-http';
import type { BusinessPermission } from '../business-information/contracts.js';
import {
  type ApplicationConversations,
  ConversationHistoryError,
} from '../conversation-history/operator.js';
import {
  type BusinessInformationRouteDeps,
  requireIdentity,
  requireInstallationPermission,
} from './business-information.js';
import type { SolutionInstallationRef } from './business-information-paths.js';

export interface BusinessConversationRouteDeps extends BusinessInformationRouteDeps {
  readonly conversations?: ApplicationConversations;
}

/** ADR 0241 decision 10: readers see text; only export and erasure need Owner/Administrator authority. */
const PERMISSIONS: Readonly<
  Record<NonNullable<SolutionInstallationRef['conversationAction']>, BusinessPermission>
> = {
  list: 'records:read',
  show: 'records:read',
  export: 'records:export',
  forget: 'records:delete',
};

export async function handleApplicationConversations(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ref: SolutionInstallationRef,
  deps: BusinessConversationRouteDeps,
): Promise<void> {
  const action = ref.conversationAction ?? 'list';
  const method = action === 'forget' ? 'POST' : 'GET';
  if (req.method !== method) {
    res.setHeader('allow', method);
    return sendJson(res, 405, { error: 'method not allowed' });
  }
  const identity = await requireIdentity(req, res, deps);
  if (identity === false) return;
  const permission = PERMISSIONS[action];
  const authorize = () => requireInstallationPermission(res, ref, identity, permission, deps);
  const authorized = await authorize();
  if (!authorized) return;
  res.setHeader('cache-control', 'private, no-store');
  try {
    if (!deps.conversations) throw new ConversationHistoryError('conversation_unavailable');
    let body: unknown;
    if (method === 'POST') {
      const parsed = await readJsonBody(req, deps.maxBody);
      if (!parsed.ok) return sendJson(res, parsed.status, { error: parsed.error });
      body = parsed.value;
      if (!(await authorize())) return;
    }
    const result = await deps.conversations.project(
      authorized.scope,
      action,
      {
        parameters: [...url.searchParams.entries()],
        ...(ref.conversationId === undefined ? {} : { conversationId: ref.conversationId }),
        body,
      },
      (operation) =>
        deps.store.staff.run(authorized.scope, identity.subject, permission, operation),
    );
    if ('audit' in result && result.audit)
      await deps.audit?.emit({
        ...result.audit,
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
