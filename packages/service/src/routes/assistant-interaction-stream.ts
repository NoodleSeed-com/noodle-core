import type { ServerResponse } from 'node:http';
import type {
  AssistantPendingConfirmationInteractionRecord,
  AssistantPendingInputInteractionRecord,
  AssistantSessionRecord,
  AssistantViewAvailableData,
} from '@noodle-borg/assistant-gateway/portable';
import { assistantConfirmationProposal } from '@noodle-borg/assistant-gateway/portable';
import type { InvocationContext } from '@noodle-borg/runtime';
import type { AssistantRouteDeps } from './assistant.js';
import { narrateInteractionResolution } from './assistant-agent.js';

type InteractionAction = 'accept' | 'decline' | 'cancel';
type AssistantTarget = NonNullable<Awaited<ReturnType<AssistantRouteDeps['registry']['get']>>>;

/** Stream the optional post-resolution narration without weakening the durable structured result. */
export async function narrateResolvedInteraction(
  res: ServerResponse,
  deps: AssistantRouteDeps,
  target: AssistantTarget,
  session: AssistantSessionRecord,
  tool: string,
  action: InteractionAction,
  result: unknown | undefined,
  context: InvocationContext,
  suggestions = false,
): Promise<void> {
  try {
    const generated = await narrateInteractionResolution(
      target,
      session,
      tool,
      action,
      result,
      context,
      deps,
      (delta) => res.write(`event: content\ndata: ${JSON.stringify({ delta })}\n\n`),
      suggestions,
    );
    if (generated.narration) {
      // Streamed to the panel as content deltas above, so it is genuine visible prose.
      await deps.store.appendHistory(session.id, [
        { role: 'assistant', content: generated.narration, kind: 'visible' },
      ]);
    }
    if (generated.suggestions.length > 0) {
      await deps.store.replaceLatestSuggestions(session.id, {
        phase: 'follow_up',
        prompts: generated.suggestions,
      });
      res.write(
        `event: suggested_prompts\ndata: ${JSON.stringify({ phase: 'follow_up', prompts: generated.suggestions })}\n\n`,
      );
    }
  } catch {
    // Narration is a soft enhancement after the durable structured outcome has been emitted.
  }
}

export function writeInteractionSseHeaders(res: ServerResponse, origin: string): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': origin,
    vary: 'Origin',
  });
}

export function writeInteractionResolved(
  res: ServerResponse,
  id: string,
  action: InteractionAction,
): void {
  res.write(`event: interaction_resolved\ndata: ${JSON.stringify({ id, action })}\n\n`);
}

export function writeInputRequested(
  res: ServerResponse,
  input: Pick<
    AssistantPendingInputInteractionRecord,
    'id' | 'message' | 'requestedSchema' | 'expiresAt'
  >,
): void {
  res.write(
    `event: input_requested\ndata: ${JSON.stringify({
      id: input.id,
      message: input.message,
      requestedSchema: input.requestedSchema,
      expiresAt: input.expiresAt,
    })}\n\n`,
  );
}

export function writeToolProposed(
  res: ServerResponse,
  interaction: Pick<
    AssistantPendingConfirmationInteractionRecord,
    'id' | 'tool' | 'review' | 'expiresAt'
  >,
): void {
  res.write(
    `event: tool_proposed\ndata: ${JSON.stringify({
      id: interaction.id,
      tool: interaction.tool,
      ...assistantConfirmationProposal(interaction.review),
      expiresAt: interaction.expiresAt,
      requiresConfirmation: true,
    })}\n\n`,
  );
}

export function writeToolCompleted(
  res: ServerResponse,
  id: string,
  tool: string,
  result: unknown,
  replayed = false,
): void {
  res.write(
    `event: tool_completed\ndata: ${JSON.stringify({ id, tool, result, ...(replayed ? { replayed: true } : {}) })}\n\n`,
  );
}

/** Announce renderer data only; this never reads or executes the linked `ui://` resource. */
export function writeViewAvailable(res: ServerResponse, view: AssistantViewAvailableData): void {
  res.write(`event: view_available\ndata: ${JSON.stringify(view)}\n\n`);
}

export function writeInteractionError(res: ServerResponse, code: string, retryable: boolean): void {
  res.write(`event: error\ndata: ${JSON.stringify({ code, retryable })}\n\n`);
}

export function endInteractionSse(res: ServerResponse): void {
  res.end('event: done\ndata: {}\n\n');
}
