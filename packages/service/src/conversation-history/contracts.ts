import type { TenantRef } from '../store.js';

/**
 * Durable conversation history (ADR 0241): the people-facing record of what a customer saw, kept apart
 * from the model's short working memory. It is never read back into a prompt, log, audit or analytics.
 */
export const CONVERSATION_DAY_MS = 86_400_000;
/** A WhatsApp conversation ends after this much silence, matching the provider's service window. */
export const CHANNEL_CONVERSATION_GAP_MS = CONVERSATION_DAY_MS;

export type ConversationChannel = 'website' | 'whatsapp';
/** The Owner/Admin recording switches (ADR 0241 decision 5). */
export type ConversationSource = 'website_visitors' | 'signed_in_customers' | 'whatsapp';

/**
 * Stored in clear so erasure can find it: an anonymous handle, the customer's user id from the backend
 * exchange, or the binding-scoped keyed participant hash. Never a credential or a phone number.
 */
export interface ConversationSubject {
  readonly kind: 'anonymous' | 'customer' | 'participant';
  readonly ref: string;
}

export interface ConversationHeader {
  readonly id: string;
  readonly tenant: TenantRef;
  readonly channel: ConversationChannel;
  readonly subject: ConversationSubject;
}

export type ConversationOutcomeStatus = 'succeeded' | 'failed' | 'declined' | 'cancelled';

/** A visible message, or a reference to a tool outcome; never a payload, narration or context. */
export type ConversationItem =
  | {
      readonly kind: 'message';
      readonly role: 'user' | 'assistant';
      readonly text: string;
      readonly at: number;
    }
  | {
      readonly kind: 'outcome';
      readonly interactionId: string;
      readonly tool: string;
      readonly status: ConversationOutcomeStatus;
      readonly at: number;
    };

export type StoredConversationItem = ConversationItem & {
  readonly seq: number;
  readonly expiresAt: number;
};

export interface StoredConversation extends ConversationHeader {
  readonly startedAt: number;
  readonly lastMessageAt: number;
  readonly items: readonly StoredConversationItem[];
}

/** A list row: metadata only, so listing never opens sealed content. */
export interface ConversationSummary {
  readonly id: string;
  readonly channel: ConversationChannel;
  readonly subject: ConversationSubject;
  readonly startedAt: number;
  readonly lastMessageAt: number;
  /** Items still unexpired at the listing time. */
  readonly itemCount: number;
}

/** Keyset position: newest first by last message time, then id (code-unit order) descending. */
export interface ConversationListPosition {
  readonly lastMessageAt: number;
  readonly id: string;
}

/** Physical rows removed by an erasure. */
export interface ConversationForgetResult {
  readonly conversations: number;
  readonly items: number;
}

export interface ConversationHistoryStore {
  /**
   * Appends items, each expiring `days` after its own time, creating the conversation on first write.
   * A verified subject written to an anonymous conversation re-owns it; nothing is copied.
   */
  append(
    header: ConversationHeader,
    items: readonly ConversationItem[],
    days: number,
  ): Promise<void>;
  /** The newest conversation of this subject whose last item is at or after `since`. */
  findRecent(
    tenant: TenantRef,
    channel: ConversationChannel,
    subject: ConversationSubject,
    since: number,
  ): Promise<string | undefined>;
  /** Moves an anonymous conversation to a verified customer; items keep their original time. */
  reown(tenant: TenantRef, id: string, subject: ConversationSubject): Promise<boolean>;
  /** Only items unexpired at `now`: the access cutoff is immediate, whatever the purge backlog. */
  read(tenant: TenantRef, id: string, now: number): Promise<StoredConversation | undefined>;
  /** Conversations with at least one item unexpired at `now`, newest first, strictly after `after`. */
  list(
    tenant: TenantRef,
    input: {
      readonly now: number;
      readonly limit: number;
      readonly after?: ConversationListPosition;
      readonly channel?: ConversationChannel;
    },
  ): Promise<readonly ConversationSummary[]>;
  /** Erases one conversation and every item, expired or not. Unknown ids remove nothing. */
  forget(tenant: TenantRef, id: string): Promise<ConversationForgetResult>;
  /** Erases every conversation of exactly this subject kind and reference in this tenant. */
  forgetSubject(tenant: TenantRef, subject: ConversationSubject): Promise<ConversationForgetResult>;
  /** Physically removes expired items, then expired conversations; returns rows removed. */
  purgeExpired(input: { readonly limit?: number }): Promise<number>;
}

/**
 * What the business chose, bounded by its plan. `conversationDays` is absent until an Owner/Admin opts
 * in, so existing workspaces keep today's short-lived behaviour (ADR 0241 decision 8).
 */
export interface ConversationPolicy {
  readonly maximumDays: number;
  readonly conversationDays?: number;
  readonly sources?: Partial<Record<ConversationSource, boolean>>;
}

export type ConversationPolicySource = (
  tenant: TenantRef,
) => Promise<ConversationPolicy | undefined>;

/** Days to keep a new item from this source; 0 means capture nothing. */
export function effectiveConversationDays(
  policy: ConversationPolicy | undefined,
  source: ConversationSource,
): number {
  if (policy?.conversationDays === undefined || policy.sources?.[source] === false) return 0;
  return Math.max(0, Math.min(policy.conversationDays, policy.maximumDays));
}

export function conversationTenantKey(tenant: TenantRef): string {
  return `${tenant.org}/${tenant.app}/${tenant.env}`;
}
