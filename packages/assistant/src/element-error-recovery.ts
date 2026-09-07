import type { ResolvedAssistantAppearance } from './appearance.js';
import { AssistantClientError } from './client-errors.js';
import { appendConversationRecovery } from './conversation-recovery.js';
import type { AssistantErrorDetail } from './transport.js';

/**
 * Turn a failed client call into what the transcript should say about it, and what the reader may do next.
 *
 * Extracted from the element because the interesting part is a policy decision, not rendering: a spent
 * or switched-off *daily* budget offers no retry, so the button goes rather than just the alarming words
 * — every open tab retrying is exactly the load the cap was set to refuse. A spent *session* keeps a
 * button, because starting a new conversation genuinely is the fix.
 */
export interface ConversationErrorRecovery {
  readonly messages: HTMLElement | undefined;
  readonly appearance: ResolvedAssistantAppearance;
  readonly error: unknown;
  readonly fallbackCode: string;
  startNewConversation(): void;
  reconnect(): void;
  revealLatest(): void;
}

export function renderConversationError(options: ConversationErrorRecovery): AssistantErrorDetail {
  const { appearance, error } = options;
  const detail =
    error instanceof AssistantClientError
      ? error.detail
      : { code: options.fallbackCode, retryable: false };
  const startNewConversation = detail.serviceCode === 'session_turn_budget_exhausted';
  const reconnect = detail.retryable !== false || detail.serviceCode === undefined;
  const recoveryAction = startNewConversation
    ? { label: appearance.labels.newConversation, run: () => options.startNewConversation() }
    : reconnect
      ? { label: appearance.labels.reconnect, run: () => options.reconnect() }
      : undefined;
  appendConversationRecovery({
    messages: options.messages,
    message:
      detail.code === 'session_expired'
        ? appearance.labels.sessionExpired
        : appearance.labels.unavailable,
    ...(recoveryAction === undefined ? {} : { action: recoveryAction }),
    revealLatest: () => options.revealLatest(),
  });
  return detail;
}
