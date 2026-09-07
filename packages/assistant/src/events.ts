import type { AssistantConfiguration } from './appearance.js';
import type { AssistantAppearanceWarning } from './host-appearance.js';
import type { AssistantJsonValue, AssistantModelContextUpdate } from './model-context.js';
import type { AssistantEvent } from './transport.js';

interface NamedEvent<Name extends string, Data> {
  readonly event: Name;
  readonly data: Data;
}

interface TurnDetail {
  readonly turnId?: string;
}

export interface AssistantContentDetail extends TurnDetail {
  readonly delta: string;
}

export interface AssistantToolStartedDetail extends TurnDetail {
  readonly id: string;
  readonly tool: string;
}

export interface AssistantToolProposedDetail extends TurnDetail {
  readonly id: string;
  readonly tool: string;
  readonly title?: string;
  readonly description?: string;
  readonly arguments?: AssistantJsonValue;
  readonly reviewSchema?: Readonly<Record<string, unknown>>;
  readonly expiresAt?: string;
  /** Optional only for compatibility with assistant services published before named-event pinning. */
  readonly requiresConfirmation?: true;
}

/**
 * A capability the visitor must sign in to reach (ADR 0201, 5.6b). `signInTicket` is the value the host
 * page hands to its **own** backend, which spends it with its own client credentials
 * (`createAssistantSession({ signInTicket })`); on its own it names a conversation and nothing more.
 * It is deliberately not called a continuation: the server-held interaction continuation must never
 * reach browser code, and this value's whole job is to travel through the browser.
 */
export interface AssistantAuthRequestedDetail extends TurnDetail {
  readonly id: string;
  readonly tool: string;
  readonly signInTicket: string;
  readonly expiresAt: string;
}

export interface AssistantInputRequestedDetail extends TurnDetail {
  readonly id: string;
  readonly message: string;
  readonly requestedSchema: Readonly<Record<string, unknown>>;
  readonly expiresAt: string;
}

export interface AssistantInteractionResolvedDetail extends TurnDetail {
  readonly id: string;
  /** Optional only for compatibility with the original accept-only confirmation endpoint. */
  readonly action?: 'accept' | 'decline' | 'cancel';
}

export interface AssistantToolCompletedDetail extends TurnDetail {
  readonly id: string;
  readonly tool: string;
  readonly result: AssistantJsonValue;
  readonly replayed?: true;
}

export interface AssistantViewAvailableDetail extends TurnDetail {
  /** Model tool-call id for an immediate result, or interaction id for a confirmed result. */
  readonly id: string;
  readonly tool: string;
  readonly resourceUri: string;
  readonly title?: string;
  /** Bounded, schema-redacted public tool output; widget-only metadata is never included. */
  readonly result: AssistantJsonValue;
  readonly arguments?: AssistantJsonValue;
  readonly html?: string;
  readonly resourceMeta?: Readonly<Record<string, unknown>>;
  /** HTTPS handoff origins declared by the server; absent/empty means app links fail closed. */
  readonly allowedOpenDomains?: readonly string[];
  readonly replayed?: true;
}

export interface AssistantErrorEventDetail extends TurnDetail {
  readonly code: string;
  readonly status?: number;
  readonly retryable?: boolean;
}

export interface AssistantSuggestedPromptsDetail extends TurnDetail {
  readonly phase: 'initial' | 'follow_up';
  readonly prompts: readonly string[];
}

export type AssistantContentEvent = NamedEvent<'content', AssistantContentDetail>;
export type AssistantToolStartedEvent = NamedEvent<'tool_started', AssistantToolStartedDetail>;
export type AssistantToolProposedEvent = NamedEvent<'tool_proposed', AssistantToolProposedDetail>;
export type AssistantInputRequestedEvent = NamedEvent<
  'input_requested',
  AssistantInputRequestedDetail
>;
type AssistantAuthRequestedEvent = NamedEvent<'auth_requested', AssistantAuthRequestedDetail>;
export type AssistantInteractionResolvedEvent = NamedEvent<
  'interaction_resolved',
  AssistantInteractionResolvedDetail
>;
export type AssistantToolCompletedEvent = NamedEvent<
  'tool_completed',
  AssistantToolCompletedDetail
>;
export type AssistantViewAvailableEvent = NamedEvent<
  'view_available',
  AssistantViewAvailableDetail
>;
export type AssistantErrorEvent = NamedEvent<'error', AssistantErrorEventDetail>;
export type AssistantSuggestedPromptsEvent = NamedEvent<
  'suggested_prompts',
  AssistantSuggestedPromptsDetail
>;
export type AssistantDoneEvent = NamedEvent<'done', TurnDetail>;

interface AssistantLegacyInteractionProposedDetail {
  readonly id: string;
  readonly tool?: string;
  readonly title?: string;
  readonly arguments?: AssistantJsonValue;
}

type AssistantContextValue = string | number | boolean | null;

export type AssistantClientLifecycleEvent =
  | NamedEvent<
      'session_started',
      { readonly expiresAt: string; readonly configuration?: AssistantConfiguration }
    >
  | NamedEvent<'session_expired', Readonly<Record<string, never>>>
  | NamedEvent<'session_reset', Readonly<Record<string, never>>>
  | NamedEvent<'session_continued', { readonly message: string }>
  | NamedEvent<
      'context_changed',
      { readonly context: Readonly<Record<string, AssistantContextValue>> }
    >
  | NamedEvent<'model_context_changed', { readonly modelContext: AssistantModelContextUpdate }>
  | NamedEvent<'message_started', { readonly message: string }>
  | NamedEvent<'message_completed', Readonly<Record<string, never>>>
  | NamedEvent<'resume_started', { readonly tool: string }>
  | NamedEvent<
      'interaction_started',
      { readonly id: string; readonly action: 'accept' | 'decline' | 'cancel' }
    >
  | NamedEvent<
      'interaction_completed',
      { readonly id: string; readonly action: 'accept' | 'decline' | 'cancel' }
    >;

export interface AssistantUnrecognizedEvent {
  readonly event: 'unrecognized';
  readonly data: {
    readonly name: string;
    readonly payload: Readonly<Record<string, unknown>>;
  };
}

/** Closed event union for the DOM-free client; unknown future SSE names remain observable safely. */
export type AssistantClientEvent =
  | AssistantContentEvent
  | AssistantToolStartedEvent
  | AssistantToolProposedEvent
  | AssistantInputRequestedEvent
  | AssistantAuthRequestedEvent
  | AssistantInteractionResolvedEvent
  | AssistantToolCompletedEvent
  | AssistantViewAvailableEvent
  | AssistantErrorEvent
  | AssistantSuggestedPromptsEvent
  | AssistantDoneEvent
  | NamedEvent<'interaction_proposed', AssistantLegacyInteractionProposedDetail>
  | AssistantClientLifecycleEvent
  | AssistantUnrecognizedEvent;

declare global {
  interface HTMLElementEventMap {
    'assistant-view-available': CustomEvent<AssistantViewAvailableDetail>;
    'assistant-appearance-warning': CustomEvent<AssistantAppearanceWarning>;
    'assistant-event': CustomEvent<AssistantClientEvent>;
    'assistant-session-continued': CustomEvent<{ readonly message: string }>;
  }
}

/** Normalize and minimally validate generic transport frames before asserting public event types. */
export function toAssistantClientEvent(event: AssistantEvent): AssistantClientEvent {
  const value = event.data;
  switch (event.event) {
    case 'content':
      if (typeof value.delta === 'string' && hasOptionalTurnId(value)) {
        return event as unknown as AssistantContentEvent;
      }
      break;
    case 'tool_started':
      if (hasString(value, 'id') && hasString(value, 'tool') && hasOptionalTurnId(value)) {
        return event as unknown as AssistantToolStartedEvent;
      }
      break;
    case 'tool_proposed':
      if (
        hasString(value, 'id') &&
        hasString(value, 'tool') &&
        hasOptionalString(value.title) &&
        hasOptionalString(value.description) &&
        hasOptionalJson(value.arguments) &&
        (value.reviewSchema === undefined || isRecord(value.reviewSchema)) &&
        hasOptionalString(value.expiresAt) &&
        (value.requiresConfirmation === undefined || value.requiresConfirmation === true) &&
        hasOptionalTurnId(value)
      ) {
        return event as unknown as AssistantToolProposedEvent;
      }
      break;
    case 'input_requested':
      if (
        hasString(value, 'id') &&
        hasString(value, 'message') &&
        isRecord(value.requestedSchema) &&
        hasString(value, 'expiresAt') &&
        hasOptionalTurnId(value)
      ) {
        return event as unknown as AssistantInputRequestedEvent;
      }
      break;
    case 'auth_requested': {
      // Services published before the signInTicket rename emit only `continuation`; normalize so a
      // listener written today reads one key regardless of the service's age.
      const signInTicket =
        typeof value.signInTicket === 'string'
          ? value.signInTicket
          : typeof value.continuation === 'string'
            ? value.continuation
            : undefined;
      if (
        hasString(value, 'id') &&
        hasString(value, 'tool') &&
        signInTicket !== undefined &&
        hasString(value, 'expiresAt') &&
        hasOptionalTurnId(value)
      ) {
        return {
          event: 'auth_requested',
          data: { ...value, signInTicket },
        } as unknown as AssistantAuthRequestedEvent;
      }
      break;
    }
    case 'interaction_resolved':
      if (
        hasString(value, 'id') &&
        (value.action === undefined || isInteractionAction(value.action)) &&
        hasOptionalTurnId(value)
      ) {
        return event as unknown as AssistantInteractionResolvedEvent;
      }
      break;
    case 'tool_completed':
      if (
        hasString(value, 'id') &&
        hasString(value, 'tool') &&
        isJsonValue(value.result, 0) &&
        (value.replayed === undefined || value.replayed === true) &&
        hasOptionalTurnId(value)
      ) {
        return event as unknown as AssistantToolCompletedEvent;
      }
      break;
    case 'view_available':
      if (isViewAvailableDetail(value)) return event as unknown as AssistantViewAvailableEvent;
      break;
    case 'error':
      if (
        hasString(value, 'code') &&
        (value.status === undefined || typeof value.status === 'number') &&
        (value.retryable === undefined || typeof value.retryable === 'boolean') &&
        hasOptionalTurnId(value)
      ) {
        return event as unknown as AssistantErrorEvent;
      }
      break;
    case 'suggested_prompts':
      if (isSuggestedPromptsDetail(value))
        return event as unknown as AssistantSuggestedPromptsEvent;
      break;
    case 'done':
      if (hasOptionalTurnId(value)) return event as AssistantDoneEvent;
      break;
    case 'interaction_proposed':
      if (
        hasString(value, 'id') &&
        (hasString(value, 'tool') || hasString(value, 'title')) &&
        hasOptionalJson(value.arguments)
      ) {
        return event as unknown as NamedEvent<
          'interaction_proposed',
          AssistantLegacyInteractionProposedDetail
        >;
      }
      break;
  }
  return { event: 'unrecognized', data: { name: event.event, payload: value } };
}

function isSuggestedPromptsDetail(value: unknown): value is AssistantSuggestedPromptsDetail {
  if (!isRecord(value)) return false;
  return (
    (value.phase === 'initial' || value.phase === 'follow_up') &&
    Array.isArray(value.prompts) &&
    value.prompts.length <= 3 &&
    value.prompts.every(
      (prompt) => typeof prompt === 'string' && prompt.trim().length > 0 && prompt.length <= 240,
    ) &&
    hasOptionalTurnId(value)
  );
}

function isViewAvailableDetail(value: Readonly<Record<string, unknown>>): boolean {
  return (
    hasString(value, 'id') &&
    hasString(value, 'tool') &&
    typeof value.resourceUri === 'string' &&
    value.resourceUri.startsWith('ui://') &&
    hasOptionalString(value.title) &&
    (value.replayed === undefined || value.replayed === true) &&
    isJsonValue(value.result, 0) &&
    hasOptionalJson(value.arguments) &&
    hasOptionalString(value.html) &&
    (value.resourceMeta === undefined || isRecord(value.resourceMeta)) &&
    (value.allowedOpenDomains === undefined ||
      (Array.isArray(value.allowedOpenDomains) && value.allowedOpenDomains.every(isHttpsUrl))) &&
    hasOptionalTurnId(value)
  );
}

function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function hasOptionalTurnId(value: Readonly<Record<string, unknown>>): boolean {
  return hasOptionalString(value.turnId);
}

function hasString(value: Readonly<Record<string, unknown>>, key: string): boolean {
  const entry = value[key];
  return typeof entry === 'string' && entry.length > 0;
}

function hasOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function hasOptionalJson(value: unknown): boolean {
  return value === undefined || isJsonValue(value, 0);
}

function isInteractionAction(value: unknown): value is 'accept' | 'decline' | 'cancel' {
  return value === 'accept' || value === 'decline' || value === 'cancel';
}

function isJsonValue(value: unknown, depth: number): value is AssistantJsonValue {
  if (depth > 16) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.length <= 256 && value.every((entry) => isJsonValue(entry, depth + 1));
  }
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= 256 && entries.every(([, entry]) => isJsonValue(entry, depth + 1));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
