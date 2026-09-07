import { isRecord } from './client-errors.js';
import { type AssistantClientEvent, toAssistantClientEvent } from './events.js';
import type { AssistantJsonValue } from './model-context.js';

type InteractionEventName = 'tool_proposed' | 'input_requested';
type AppInteractionEvent = Extract<AssistantClientEvent, { readonly event: InteractionEventName }>;
type JsonObject = Readonly<Record<string, unknown>>;

export function authorizedHeaders(token: string, accept: string): Readonly<Record<string, string>> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: accept };
}

export function parseAppInteraction(value: unknown): AppInteractionEvent | undefined {
  if (!isRecord(value) || !isRecord(value.interaction)) return undefined;
  const { event, data } = value.interaction;
  if ((event !== 'tool_proposed' && event !== 'input_requested') || !isRecord(data))
    return undefined;
  const parsed = toAssistantClientEvent({ event, data });
  if (parsed.event === 'tool_proposed' || parsed.event === 'input_requested') return parsed;
  return undefined;
}

export function appToolResult(result: AssistantJsonValue): JsonObject {
  const text = typeof result === 'string' ? result : JSON.stringify(result);
  return result !== null && typeof result === 'object' && !Array.isArray(result)
    ? { content: [{ type: 'text', text }], structuredContent: result, isError: false }
    : { content: [{ type: 'text', text }], isError: false };
}

export function appInteractionStopped(action: 'decline' | 'cancel'): JsonObject {
  return { content: [{ type: 'text', text: `interaction_${action}` }], isError: true };
}
