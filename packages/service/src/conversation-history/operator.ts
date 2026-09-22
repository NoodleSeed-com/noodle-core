import { createHmac } from 'node:crypto';
import { canonicalJson } from '@noodle-borg/compiler';
import {
  ConversationExportResponseSchema,
  ConversationForgetRequestSchema,
  ConversationForgetResponseSchema,
  ConversationIdSchema,
  ConversationListResponseSchema,
  ConversationShowResponseSchema,
} from '@noodle-borg/wire-contracts';
import type { InstallationScope } from '../business-information/contracts.js';
import type { TenantRef } from '../store.js';
import type {
  ConversationChannel,
  ConversationHistoryStore,
  ConversationListPosition,
  ConversationSummary,
  StoredConversation,
} from './contracts.js';

/** Fence each local store effect with current staff authority. */
type ConversationLocalOperation = <T>(operation: () => Promise<T>) => Promise<T>;
const runLocal: ConversationLocalOperation = (operation) => operation();

export interface ApplicationConversationsOptions {
  readonly store: ConversationHistoryStore;
  /** Binds opaque cursors to their purpose, installation, page size and channel. */
  readonly identityKey: string;
  readonly now?: () => number;
}

export type ConversationProjectionAction = 'list' | 'show' | 'export' | 'forget';

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
 * read, export and forget returns identifier-only audit details; message text never reaches audit.
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
    },
    local: ConversationLocalOperation = runLocal,
  ) {
    const tenant: TenantRef = { org: scope.org, app: scope.app, env: scope.env };
    const allowed = action === 'list' || action === 'export' ? ['limit', 'cursor', 'channel'] : [];
    const parameters = new Map<string, string>();
    for (const [key, value] of input.parameters) {
      if (!allowed.includes(key) || parameters.has(key)) throw invalid();
      parameters.set(key, value);
    }
    const audit = (eventType: string, details: Readonly<Record<string, string | number>>) => ({
      eventType,
      details,
    });
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
        audit: audit('conversation.forgotten', {
          conversations: forgotten.conversations,
          items: forgotten.items,
          kind: 'conversationId' in request ? 'conversation' : request.subject.kind,
        }),
      };
    }
    if (action === 'show') {
      const id = ConversationIdSchema.safeParse(input.conversationId);
      if (!id.success) throw new ConversationHistoryError('conversation_not_found');
      const conversation = await local(() => this.options.store.read(tenant, id.data, this.#now()));
      if (!conversation) throw new ConversationHistoryError('conversation_not_found');
      return {
        response: ConversationShowResponseSchema.parse({
          ok: true,
          data: { conversation: detail(conversation) },
        }),
        audit: audit('conversation.read', { conversationId: id.data }),
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
      };
    const conversations = await local(async () => {
      const now = this.#now();
      const read = await Promise.all(
        page.summaries.map((row) => this.options.store.read(tenant, row.id, now)),
      );
      return read.filter((row) => row !== undefined).map(detail);
    });
    return {
      response: ConversationExportResponseSchema.parse({
        ok: true,
        data: {
          conversations,
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        },
      }),
      audit: audit('conversation.exported', { count: conversations.length }),
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
    const cursor = parameters.get('cursor');
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > bounds.maximum ||
      (channel !== undefined && channel !== 'website' && channel !== 'whatsapp') ||
      (cursor !== undefined && (!cursor || cursor.length > 2048))
    )
      throw invalid();
    const binding = this.#hash({
      purpose: `conversations-${purpose}-v1`,
      scope,
      limit,
      channel: channel ?? null,
    });
    const after = decodeConversationCursor(cursor, binding);
    const rows = await local(() =>
      this.options.store.list(tenant, {
        now: this.#now(),
        limit: limit + 1,
        ...(after ? { after } : {}),
        ...(channel ? { channel: channel as ConversationChannel } : {}),
      }),
    );
    const summaries = rows.slice(0, limit);
    const last = summaries.at(-1);
    return {
      summaries,
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(
              JSON.stringify({ binding, lastMessageAt: last.lastMessageAt, id: last.id }),
            ).toString('base64url')
          : undefined,
    };
  }

  #now() {
    return this.options.now?.() ?? Date.now();
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
  };
}

function detail(conversation: StoredConversation) {
  return {
    ...summary({ ...conversation, itemCount: conversation.items.length }),
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

function decodeConversationCursor(
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
