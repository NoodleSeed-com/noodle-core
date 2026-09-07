/**
 * The bounded visible-transcript projection (ADR 0141/0201 amendments 2026-08-26): what a widget may
 * repaint after a full-page navigation — the sign-in redirect above all — from the session's own
 * short-lived history. Transport-free like every gateway decision; `packages/service` adapts.
 *
 * Only rows explicitly tagged `visible` project. Everything else fails closed out of the transcript:
 * `narration` rows are model-facing scaffolding (resolution summaries carrying tool output,
 * `[platform]` resume prompts the visitor never saw), and an untagged legacy row cannot prove which
 * it was. This is a read-only projection over state that already exists and already expires with the
 * session — it is not a durable transcript, and nothing here may extend a retention window.
 */

export interface AssistantTranscriptEntry {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

export interface AssistantTranscriptHistoryEntry {
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly kind?: 'visible' | 'narration';
}

export function visibleTranscript(
  history: readonly AssistantTranscriptHistoryEntry[],
): readonly AssistantTranscriptEntry[] {
  return history
    .filter((entry) => entry.kind === 'visible')
    .map((entry) => ({ role: entry.role, text: entry.content }));
}
