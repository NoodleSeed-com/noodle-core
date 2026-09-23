import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJsonBody, sendJson } from '@noodle-borg/transport-http';
import { ConversationHistoryError } from '../conversation-history/operator.js';
import { sendUnauthorized } from '../http-util.js';
import type { AssistantRouteDeps } from './assistant.js';
import { basicCredentials } from './assistant-route-http.js';

export type AssistantConversationAction = 'list' | 'forget-user';

/**
 * Backend-only conversation routes for an embed client (ADR 0241 decision 12). They authenticate
 * exactly like the session exchange and never read a tenant from the body; there is no browser CORS
 * surface, because the client secret must never reach a browser.
 */
export async function handleAssistantConversations(
  req: IncomingMessage,
  res: ServerResponse,
  action: AssistantConversationAction,
  deps: AssistantRouteDeps,
): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    return sendJson(res, 405, { error: 'method not allowed' });
  }
  const credentials = basicCredentials(req);
  if (!credentials) return sendUnauthorized(res, 'invalid assistant client');
  const client = await deps.store.authenticateClient(credentials.id, credentials.secret);
  if (!client) return sendUnauthorized(res, 'invalid assistant client');
  res.setHeader('cache-control', 'private, no-store');
  const body = await readJsonBody(req, deps.maxBody);
  if (!body.ok) return sendJson(res, body.status, { error: body.error });
  try {
    const conversations = deps.customerConversations;
    if (!conversations) throw new ConversationHistoryError('conversation_unavailable');
    const owner = { id: client.id, tenant: client.tenant };
    const result =
      action === 'list'
        ? await conversations.list(owner, body.value)
        : await conversations.forgetUser(owner, body.value);
    await deps.audit.emit({
      ...result.audit,
      org: client.tenant.org,
      app: client.tenant.app,
      env: client.tenant.env,
      decision: 'allow',
      actorSubject: client.id,
    });
    sendJson(res, 200, result.response);
  } catch (error) {
    if (!(error instanceof ConversationHistoryError)) throw error;
    sendJson(res, error.code === 'conversation_unavailable' ? 503 : 400, {
      code: error.code,
      error: error.message,
    });
  }
}
