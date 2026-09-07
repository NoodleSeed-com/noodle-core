import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  assistantConfirmationProposal,
  assistantTranscriptEvents,
  assistantViewAvailableData,
  visibleTranscript,
} from '@noodle-borg/assistant-gateway/portable';
import { assistantWireEventSchema } from '@noodle-borg/wire-contracts';
import type { AssistantRouteDeps } from './assistant.js';
import { applyBrowserCors, authenticateSession } from './assistant-route-http.js';
import { sessionScopedTarget } from './assistant-session-target.js';

/**
 * The bounded visible-transcript read (ADR 0141/0201 amendments 2026-08-26), in its own module for
 * the same reason `assistant-elevation.ts` is: `assistant.ts` is at its size limit, and this is a
 * different responsibility from running a turn.
 *
 * POST, deliberately: every other session route is a POST, so the existing preflight's
 * `POST, OPTIONS` shape covers it without widening allow-methods. Auth is exactly the shared
 * session gate — current token, pinned origin — so a stale pre-elevation token cannot read, by
 * construction. A read spends no turn budget: admission binds metered work (ADR 0201 decision 8),
 * and this is a projection over state that already exists and already expires with the session.
 */
export async function handleAssistantTranscript(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AssistantRouteDeps,
): Promise<void> {
  const session = await authenticateSession(req, res, deps);
  if (!session) return;
  applyBrowserCors(req, res, session.origin);
  const target = await sessionScopedTarget(deps.registry, session);
  const latestView =
    target && session.latestView
      ? assistantViewAvailableData(
          target.served.artifact,
          { ...session.latestView, replayed: true },
          (failure) => deps.logger?.warn('assistant.view.unresolved', { ...failure }),
        )
      : undefined;
  const pending = await deps.store.findPendingInteraction({
    sessionId: session.id,
    deploymentId: session.deploymentId,
    now: deps.clock?.() ?? new Date(),
  });
  const pendingInteraction =
    target && pending && target.served.artifact.tools.some((tool) => tool.name === pending.tool)
      ? pending.kind === 'confirmation'
        ? {
            event: 'tool_proposed' as const,
            data: {
              id: pending.id,
              tool: pending.tool,
              ...assistantConfirmationProposal(pending.review),
              expiresAt: pending.expiresAt,
              requiresConfirmation: true as const,
            },
          }
        : {
            event: 'input_requested' as const,
            data: {
              id: pending.id,
              message: pending.message,
              requestedSchema: pending.requestedSchema,
              expiresAt: pending.expiresAt,
            },
          }
      : undefined;
  const events = assistantTranscriptEvents({
    entries: visibleTranscript(session.history),
    ...(session.latestSuggestions?.phase === 'follow_up'
      ? { suggestions: session.latestSuggestions }
      : {}),
    ...(latestView === undefined ? {} : { latestView }),
    ...(pendingInteraction === undefined ? {} : { pendingInteraction }),
  });
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
  });
  for (const event of events) {
    // Parse before sending, like every assistant stream: contract drift fails at the service seam.
    assistantWireEventSchema.parse(event);
    res.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
  }
  res.end();
}
