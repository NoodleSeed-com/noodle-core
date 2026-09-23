import { createHmac } from 'node:crypto';
import { canonicalJson } from '@noodle-borg/compiler';
import {
  ConversationExportResponseSchema,
  ConversationForgetRequestSchema,
  ConversationForgetResponseSchema,
  ConversationIdSchema,
  ConversationListResponseSchema,
  ConversationReviewRequestSchema,
  ConversationReviewStatusSchema,
  ConversationShowResponseSchema,
} from '@noodle-borg/wire-contracts';
import type { InstallationScope } from '../business-information/contracts.js';
import { maskPaymentCards } from '../payment-card.js';
import type { TenantRef } from '../store.js';
import {
  CONVERSATION_DAY_MS,
  CONVERSATION_NOTE_LIMIT,
  type ConversationChannel,
  type ConversationHistoryStore,
  type ConversationListPosition,
  type ConversationPolicy,
  type ConversationPolicySource,
  type ConversationReviewStatus,
  type ConversationSummary,
  type StoredConversation,
} from './contracts.js';

/** Fence each local store effect with current staff authority. */
type ConversationLocalOperation = <T>(operation: () => Promise<T>) => Promise<T>;
const runLocal: ConversationLocalOperation = (operation) => operation();

export interface ApplicationConversationsOptions {
  readonly store: ConversationHistoryStore;
  /**
   * The live business policy (setting under the current plan allowance). Reads show only items inside
   * its window, so a downgrade narrows access at once; absent or failing policy fails closed.
   */
  readonly policy: ConversationPolicySource;
  /** Binds opaque cursors to their purpose, installation, page size and channel. */
  readonly identityKey: string;
  readonly now?: () => number;
}

export type ConversationProjectionAction = 'list' | 'show' | 'review' | 'export' | 'forget';

const MESSAGES = {
  conversation_invalid: 'Invalid conversation request.',
  conversation_not_found: 'Conversation not found.',
  conversation_unavailable: 'Conversation history is unavailable.',
} as const;
export class ConversationHistoryError extends Error {
  constructor(readonly code: keyof typeof MESSAGES) {
    super(MESSAGES[code]);
  }
}

const PAGE = { list: { default: 50, maximum: 100 }, export: { default: 25, maximum: 25 } } as const;

/**
 * The staff projection of conversation history (ADR 0241). Callers authorize before and after, and every
 * read, review, note, export and forget returns identifier-only audit details; message and note text
 * never reach audit.
 */
export class ApplicationConversations {
  constructor(readonly options: ApplicationConversationsOptions) {}

  async project(
    scope: InstallationScope,
    action: ConversationProjectionAction,
    input: {
      readonly parameters: readonly (readonly [string, string])[];
      readonly conversationId?: string;
      readonly body?: unknown;
      /** The staff subject a note is written by. */
      readonly actor?: string;
    },
    local: ConversationLocalOperation = runLocal,
  ) {
    const tenant: TenantRef = { org: scope.org, app: scope.app, env: scope.env };
    const allowed =
      action === 'list' || action === 'export' ? ['limit', 'cursor', 'channel', 'status'] : [];
    const parameters = new Map<string, string>();
    for (const [key, value] of input.parameters) {
      if (!allowed.includes(key) || parameters.has(key)) throw invalid();
      parameters.set(key, value);
    }
    const audit = (eventType: string, details: Readonly<Record<string, string | number>>) => ({
      eventType,
      details,
    });
    if (action === 'review') {
      const id = ConversationIdSchema.safeParse(input.conversationId);
      if (!id.success) throw new ConversationHistoryError('conversation_not_found');
      const parsed = ConversationReviewRequestSchema.safeParse(input.body);
      if (!parsed.success || (parsed.data.note !== undefined && !input.actor)) throw invalid();
      const { reviewStatus, note } = parsed.data;
      const now = this.#now();
      const notBefore = await this.#notBefore(tenant, now);
      const conversation = await local(async () => {
        const current = await this.options.store.read(tenant, id.data, now, notBefore);
        if (!current) throw new ConversationHistoryError('conversation_not_found');
        if (note !== undefined && current.notes.length >= CONVERSATION_NOTE_LIMIT) throw invalid();
        if (reviewStatus !== undefined)
          await this.options.store.setReviewStatus(tenant, id.data, reviewStatus);
        if (note !== undefined)
          await this.options.store.addNote(tenant, id.data, {
            author: String(input.actor),
            text: maskPaymentCards(note),
            at: now,
          });
        return this.options.store.read(tenant, id.data, now, notBefore);
      });
      if (!conversation) throw new ConversationHistoryError('conversation_not_found');
      return {
        response: ConversationShowResponseSchema.parse({
          ok: true,
          data: { conversation: shown(conversation, now - notBefore) },
        }),
        audits: [
          ...(reviewStatus === undefined
            ? []
            : [audit('conversation.reviewed', { conversationId: id.data, reviewStatus })]),
          ...(note === undefined ? [] : [audit('conversation.noted', { conversationId: id.data })]),
        ],
      };
    }
    if (action === 'forget') {
      const parsed = ConversationForgetRequestSchema.safeParse(input.body);
      if (!parsed.success) throw invalid();
      const request = parsed.data;
      const forgotten = await local(() =>
        'conversationId' in request
          ? this.options.store.forget(tenant, request.conversationId)
          : this.options.store.forgetSubject(tenant, request.subject),
      );
      return {
        response: ConversationForgetResponseSchema.parse({ ok: true, data: { forgotten } }),
        audits: [
          audit('conversation.forgotten', {
            conversations: forgotten.conversations,
            items: forgotten.items,
            kind: 'conversationId' in request ? 'conversation' : request.subject.kind,
          }),
        ],
      };
    }
    if (action === 'show') {
      const id = ConversationIdSchema.safeParse(input.conversationId);
      if (!id.success) throw new ConversationHistoryError('conversation_not_found');
      const now = this.#now();
      const notBefore = await this.#notBefore(tenant, now);
      const conversation = await local(() =>
        this.options.store.read(tenant, id.data, now, notBefore),
      );
      if (!conversation) throw new ConversationHistoryError('conversation_not_found');
      return {
        response: ConversationShowResponseSchema.parse({
          ok: true,
          data: { conversation: shown(conversation, now - notBefore) },
        }),
        audits: [audit('conversation.read', { conversationId: id.data })],
      };
    }
    const page = await this.#page(scope, tenant, action, parameters, local);
    if (action === 'list')
      return {
        response: ConversationListResponseSchema.parse({
          ok: true,
          data: {
            conversations: page.summaries.map(summary),
            ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
          },
        }),
        audits: [],
      };
    const conversations = await local(async () => {
      const read = await Promise.all(
        page.summaries.map((row) =>
          this.options.store.read(tenant, row.id, page.now, page.notBefore),
        ),
      );
      return read
        .filter((row) => row !== undefined)
        .map((row) => detail(row, page.now - page.notBefore));
    });
    return {
      response: ConversationExportResponseSchema.parse({
        ok: true,
        data: {
          conversations,
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        },
      }),
      audits: [audit('conversation.exported', { count: conversations.length })],
    };
  }

  async #page(
    scope: InstallationScope,
    tenant: TenantRef,
    purpose: 'list' | 'export',
    parameters: ReadonlyMap<string, string>,
    local: ConversationLocalOperation,
  ) {
    const bounds = PAGE[purpose];
    const limit = parameters.has('limit') ? Number(parameters.get('limit')) : bounds.default;
    const channel = parameters.get('channel');
    const status = parameters.get('status');
    const cursor = parameters.get('cursor');
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > bounds.maximum ||
      (channel !== undefined && channel !== 'website' && channel !== 'whatsapp') ||
      (status !== undefined && !ConversationReviewStatusSchema.safeParse(status).success) ||
      (cursor !== undefined && (!cursor || cursor.length > 2048))
    )
      throw invalid();
    const binding = this.#hash({
      purpose: `conversations-${purpose}-v1`,
      scope,
      limit,
      channel: channel ?? null,
      status: status ?? null,
    });
    const after = decodeConversationCursor(cursor, binding);
    const now = this.#now();
    const notBefore = await this.#notBefore(tenant, now);
    const rows = await local(() =>
      this.options.store.list(tenant, {
        now,
        notBefore,
        limit: limit + 1,
        ...(after ? { after } : {}),
        ...(channel ? { channel: channel as ConversationChannel } : {}),
        ...(status ? { reviewStatus: status as ConversationReviewStatus } : {}),
      }),
    );
    const summaries = rows.slice(0, limit);
    const last = summaries.at(-1);
    return {
      now,
      notBefore,
      summaries,
      nextCursor: rows.length > limit && last ? encodeConversationCursor(binding, last) : undefined,
    };
  }

  #now() {
    return this.options.now?.() ?? Date.now();
  }

  /**
   * Oldest visible item time under the live window. Items the window hides are not deleted: they purge
   * at their stamped expiry, so restoring a longer plan before then shows them again. That recovers
   * nothing deleted, which is all the business history contract forbids.
   */
  async #notBefore(tenant: TenantRef, now: number): Promise<number> {
    const policy = await this.options.policy(tenant).catch(() => undefined);
    if (!policy || !Number.isInteger(policy.maximumDays))
      throw new ConversationHistoryError('conversation_unavailable');
    return conversationReadBound(policy, now);
  }

  #hash(value: unknown) {
    return createHmac('sha256', this.options.identityKey)
      .update(canonicalJson(value))
      .digest('hex');
  }
}

function invalid() {
  return new ConversationHistoryError('conversation_invalid');
}

function summary(row: ConversationSummary) {
  return {
    id: row.id,
    channel: row.channel,
    subject: row.subject.kind === 'anonymous' ? { kind: 'anonymous' } : row.subject,
    startedAt: new Date(row.startedAt).toISOString(),
    lastMessageAt: new Date(row.lastMessageAt).toISOString(),
    itemCount: row.itemCount,
    reviewStatus: row.reviewStatus,
  };
}

/**
 * The last visible item's effective removal: its stored expiry, or sooner where the live window of
 * `windowMs` hides it first.
 */
function removalAt(conversation: StoredConversation, windowMs: number): number {
  return Math.max(
    ...conversation.items.map((item) => Math.min(item.expiresAt, item.at + windowMs)),
  );
}

function shown(conversation: StoredConversation, windowMs: number) {
  return {
    ...detail(conversation, windowMs),
    notes: conversation.notes.map((note) => ({
      author: note.author,
      text: note.text,
      at: new Date(note.at).toISOString(),
    })),
  };
}

function detail(conversation: StoredConversation, windowMs: number) {
  return {
    ...summary({ ...conversation, itemCount: conversation.items.length }),
    expiresAt: new Date(removalAt(conversation, windowMs)).toISOString(),
    items: conversation.items.map((item) =>
      item.kind === 'message'
        ? { kind: item.kind, role: item.role, text: item.text, at: new Date(item.at).toISOString() }
        : {
            kind: item.kind,
            interactionId: item.interactionId,
            tool: item.tool,
            status: item.status,
            at: new Date(item.at).toISOString(),
          },
    ),
  };
}

/** Oldest visible item time under a policy's live window; Off hides every item. */
export function conversationReadBound(policy: ConversationPolicy, now: number): number {
  const days = Math.max(0, Math.min(policy.conversationDays ?? 0, policy.maximumDays));
  return days === 0 ? now + 1 : now - days * CONVERSATION_DAY_MS;
}

/** An opaque keyset position bound to the purpose, scope and page shape that `binding` hashes. */
export function encodeConversationCursor(binding: string, last: ConversationListPosition): string {
  return Buffer.from(
    JSON.stringify({ binding, lastMessageAt: last.lastMessageAt, id: last.id }),
  ).toString('base64url');
}

export function decodeConversationCursor(
  raw: string | undefined,
  binding: string,
): ConversationListPosition | undefined {
  if (raw === undefined) return undefined;
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString());
    if (
      value.binding !== binding ||
      !Number.isSafeInteger(value.lastMessageAt) ||
      value.lastMessageAt < 0 ||
      !ConversationIdSchema.safeParse(value.id).success
    )
      throw new Error();
    return { lastMessageAt: value.lastMessageAt, id: value.id };
  } catch {
    throw invalid();
  }
}
