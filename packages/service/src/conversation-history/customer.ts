import { createHmac } from 'node:crypto';
import { canonicalJson } from '@noodle-borg/compiler';
import {
  ASSISTANT_CONVERSATION_PREVIEW_MAXIMUM,
  AssistantConversationForgetUserRequestSchema,
  AssistantConversationListRequestSchema,
  AssistantConversationListResponseSchema,
  ConversationForgetResponseSchema,
} from '@noodle-borg/wire-contracts';
import type { TenantRef } from '../store.js';
import type {
  ConversationHistoryStore,
  ConversationPolicySource,
  ConversationSubject,
  StoredConversation,
} from './contracts.js';
import {
  ConversationHistoryError,
  conversationReadBound,
  decodeConversationCursor,
  encodeConversationCursor,
} from './operator.js';

export interface CustomerConversationsOptions {
  readonly store: ConversationHistoryStore;
  readonly policy: ConversationPolicySource;
  readonly identityKey: string;
  readonly now?: () => number;
}

/** The authenticated embed client; its tenant is the only tenant these calls ever touch. */
export interface CustomerConversationClient {
  readonly id: string;
  readonly tenant: TenantRef;
}

const DEFAULT_PAGE = 20;

/**
 * The customer-backend projection of conversation history (ADR 0241 decision 12). An embed client lists
 * or forgets one of its own verified users by the `user.id` its session exchange sent, which capture
 * stored as the customer subject reference. Audit details are counts only, never text or the user id.
 */
export class CustomerConversations {
  constructor(readonly options: CustomerConversationsOptions) {}

  async list(client: CustomerConversationClient, body: unknown) {
    const parsed = AssistantConversationListRequestSchema.safeParse(body);
    if (!parsed.success) throw new ConversationHistoryError('conversation_invalid');
    const { user, cursor } = parsed.data;
    const limit = parsed.data.limit ?? DEFAULT_PAGE;
    const subject = customer(user.id);
    const binding = this.#hash({
      purpose: 'assistant-client-conversations-v1',
      client: client.id,
      tenant: client.tenant,
      ref: subject.ref,
      limit,
    });
    const after = decodeConversationCursor(cursor, binding);
    const now = this.options.now?.() ?? Date.now();
    const policy = await this.options.policy(client.tenant).catch(() => {
      throw new ConversationHistoryError('conversation_unavailable');
    });
    // A business that has not opted in records nothing, so it has nothing to list.
    if (policy !== undefined && !Number.isInteger(policy.maximumDays))
      throw new ConversationHistoryError('conversation_unavailable');
    const notBefore = policy === undefined ? now + 1 : conversationReadBound(policy, now);
    const rows = await this.options.store.list(client.tenant, {
      now,
      notBefore,
      limit: limit + 1,
      channel: 'website',
      subject,
      ...(after ? { after } : {}),
    });
    const page = rows.slice(0, limit);
    const read = await Promise.all(
      page.map((row) => this.options.store.read(client.tenant, row.id, now, notBefore)),
    );
    // A conversation purged or forgotten between list and read simply drops out of the page.
    const conversations = read
      .filter(
        (conversation): conversation is StoredConversation =>
          conversation?.subject.kind === 'customer' && conversation.subject.ref === subject.ref,
      )
      .map(row);
    const last = page.at(-1);
    return {
      response: AssistantConversationListResponseSchema.parse({
        ok: true,
        data: {
          conversations,
          ...(rows.length > limit && last
            ? { nextCursor: encodeConversationCursor(binding, last) }
            : {}),
        },
      }),
      audit: { eventType: 'conversation.listed', details: { count: conversations.length } },
    };
  }

  /** Erasure never consults the recording policy: a business that stopped recording can still forget. */
  async forgetUser(client: CustomerConversationClient, body: unknown) {
    const parsed = AssistantConversationForgetUserRequestSchema.safeParse(body);
    if (!parsed.success) throw new ConversationHistoryError('conversation_invalid');
    const forgotten = await this.options.store.forgetSubject(
      client.tenant,
      customer(parsed.data.user.id),
    );
    return {
      response: ConversationForgetResponseSchema.parse({ ok: true, data: { forgotten } }),
      audit: {
        eventType: 'conversation.forgotten',
        details: {
          conversations: forgotten.conversations,
          items: forgotten.items,
          kind: 'customer',
        },
      },
    };
  }

  #hash(value: unknown) {
    return createHmac('sha256', this.options.identityKey)
      .update(canonicalJson(value))
      .digest('hex');
  }
}

function customer(ref: string): ConversationSubject {
  return { kind: 'customer', ref };
}

function row(conversation: StoredConversation) {
  const preview = previewOf(conversation);
  return {
    id: conversation.id,
    channel: conversation.channel,
    startedAt: new Date(conversation.startedAt).toISOString(),
    lastMessageAt: new Date(conversation.lastMessageAt).toISOString(),
    ...(preview ? { preview } : {}),
  };
}

/** The first visible question, whitespace-collapsed and cut without splitting a surrogate pair. */
function previewOf(conversation: StoredConversation): string | undefined {
  const first = conversation.items.find((item) => item.kind === 'message' && item.role === 'user');
  if (first?.kind !== 'message') return undefined;
  let text = first.text.replace(/\s+/g, ' ').trim();
  if (text.length > ASSISTANT_CONVERSATION_PREVIEW_MAXIMUM) {
    text = text.slice(0, ASSISTANT_CONVERSATION_PREVIEW_MAXIMUM);
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
    text = text.trimEnd();
  }
  return text || undefined;
}
