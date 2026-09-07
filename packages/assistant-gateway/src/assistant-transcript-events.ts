import type { AssistantTranscriptEntry } from './assistant-transcript.js';
import type { AssistantViewAvailableData } from './assistant-view-availability.js';

export interface AssistantTranscriptEvent {
  readonly event: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface AssistantRecoveredInteraction {
  readonly event: 'tool_proposed' | 'input_requested';
  readonly data: Readonly<Record<string, unknown>>;
}

/**
 * Project retained visual state through the ordinary assistant event protocol. The browser therefore
 * has one parser and one rendering path for live and recovered turns; this function owns only ordering.
 */
export function assistantTranscriptEvents(input: {
  readonly entries: readonly AssistantTranscriptEntry[];
  readonly latestView?: AssistantViewAvailableData;
  readonly pendingInteraction?: AssistantRecoveredInteraction;
  readonly suggestions?: {
    readonly phase: 'initial' | 'follow_up';
    readonly prompts: readonly string[];
  };
}): readonly AssistantTranscriptEvent[] {
  const events: AssistantTranscriptEvent[] = [];
  let open = false;
  let awaitingAssistant = false;
  for (const entry of input.entries) {
    if (entry.role === 'user') {
      if (open) events.push({ event: 'message_completed', data: {} });
      events.push({ event: 'message_started', data: { message: entry.text } });
      open = true;
      awaitingAssistant = true;
      continue;
    }
    if (!open || !awaitingAssistant) {
      if (open) events.push({ event: 'message_completed', data: {} });
      events.push({ event: 'resume_started', data: { tool: '' } });
      open = true;
    }
    events.push({ event: 'content', data: { delta: entry.text } });
    awaitingAssistant = false;
  }
  if (open) events.push({ event: 'message_completed', data: {} });
  if (input.latestView) events.push({ event: 'view_available', data: { ...input.latestView } });
  if (input.pendingInteraction) events.push(input.pendingInteraction);
  if (input.suggestions?.phase === 'follow_up') {
    events.push({ event: 'suggested_prompts', data: { ...input.suggestions } });
  }
  events.push({ event: 'done', data: {} });
  return events;
}
