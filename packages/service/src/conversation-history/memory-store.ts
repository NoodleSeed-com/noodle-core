import type { TenantRef } from '../store.js';
import {
  CONVERSATION_DAY_MS,
  type ConversationChannel,
  type ConversationForgetResult,
  type ConversationHeader,
  type ConversationHistoryStore,
  type ConversationItem,
  type ConversationListPosition,
  type ConversationNote,
  type ConversationReviewStatus,
  type ConversationSubject,
  type ConversationSummary,
  conversationExpiryBound,
  conversationTenantKey,
  type StoredConversation,
  type StoredConversationItem,
  type StoredConversationNote,
} from './contracts.js';

interface Row {
  header: ConversationHeader;
  startedAt: number;
  lastMessageAt: number;
  expiresAt: number;
  reviewStatus: ConversationReviewStatus;
  items: StoredConversationItem[];
  notes: StoredConversationNote[];
}

/** Process-local development/test profile; hosted history is the PostgreSQL store. */
export class InMemoryConversationHistoryStore implements ConversationHistoryStore {
  readonly #rows = new Map<string, Row>();
  constructor(private readonly now: () => number = Date.now) {}

  async append(
    header: ConversationHeader,
    items: readonly ConversationItem[],
    days: number,
  ): Promise<void> {
    if (items.length === 0) return;
    const key = rowKey(header.tenant, header.id);
    const row = this.#rows.get(key) ?? {
      header,
      startedAt: items[0]?.at ?? 0,
      lastMessageAt: 0,
      expiresAt: 0,
      reviewStatus: 'new',
      items: [],
      notes: [],
    };
    if (row.header.subject.kind === 'anonymous' && header.subject.kind === 'customer') {
      row.header = { ...row.header, subject: header.subject };
    }
    for (const item of items) {
      const expiresAt = item.at + days * CONVERSATION_DAY_MS;
      row.items.push({ ...item, seq: row.items.length + 1, expiresAt } as StoredConversationItem);
      row.lastMessageAt = Math.max(row.lastMessageAt, item.at);
      row.expiresAt = Math.max(row.expiresAt, expiresAt);
      if (item.kind === 'outcome' && item.status === 'failed') row.reviewStatus = 'needs_attention';
    }
    this.#rows.set(key, row);
  }

  async findRecent(
    tenant: TenantRef,
    channel: ConversationChannel,
    subject: ConversationSubject,
    since: number,
  ): Promise<string | undefined> {
    const tenantKey = conversationTenantKey(tenant);
    return [...this.#rows.values()]
      .filter(
        (row) =>
          conversationTenantKey(row.header.tenant) === tenantKey &&
          row.header.channel === channel &&
          row.header.subject.kind === subject.kind &&
          row.header.subject.ref === subject.ref &&
          row.lastMessageAt >= since,
      )
      .sort((left, right) => right.lastMessageAt - left.lastMessageAt)[0]?.header.id;
  }

  async reown(tenant: TenantRef, id: string, subject: ConversationSubject): Promise<boolean> {
    const row = this.#rows.get(rowKey(tenant, id));
    if (row?.header.subject.kind !== 'anonymous' || subject.kind !== 'customer') return false;
    row.header = { ...row.header, subject };
    return true;
  }

  async read(
    tenant: TenantRef,
    id: string,
    now: number,
    notBefore = Number.MIN_SAFE_INTEGER,
  ): Promise<StoredConversation | undefined> {
    const row = this.#rows.get(rowKey(tenant, id));
    const items = row?.items.filter((item) => visible(item, now, notBefore)) ?? [];
    if (!row || items.length === 0) return undefined;
    return {
      ...row.header,
      startedAt: row.startedAt,
      lastMessageAt: row.lastMessageAt,
      reviewStatus: row.reviewStatus,
      items,
      notes: [...row.notes],
    };
  }

  async list(
    tenant: TenantRef,
    input: {
      readonly now: number;
      readonly notBefore?: number;
      readonly limit: number;
      readonly after?: ConversationListPosition;
      readonly channel?: ConversationChannel;
      readonly subject?: ConversationSubject;
      readonly reviewStatus?: ConversationReviewStatus;
    },
  ): Promise<readonly ConversationSummary[]> {
    const tenantKey = conversationTenantKey(tenant);
    const notBefore = input.notBefore ?? Number.MIN_SAFE_INTEGER;
    const { after } = input;
    return [...this.#rows.values()]
      .filter(
        (row) =>
          conversationTenantKey(row.header.tenant) === tenantKey &&
          (input.channel === undefined || row.header.channel === input.channel) &&
          (input.subject === undefined ||
            (row.header.subject.kind === input.subject.kind &&
              row.header.subject.ref === input.subject.ref)) &&
          (input.reviewStatus === undefined || row.reviewStatus === input.reviewStatus) &&
          (after === undefined ||
            row.lastMessageAt < after.lastMessageAt ||
            (row.lastMessageAt === after.lastMessageAt && row.header.id < after.id)),
      )
      .map((row) => ({
        id: row.header.id,
        channel: row.header.channel,
        subject: row.header.subject,
        startedAt: row.startedAt,
        lastMessageAt: row.lastMessageAt,
        itemCount: row.items.filter((item) => visible(item, input.now, notBefore)).length,
        reviewStatus: row.reviewStatus,
      }))
      .filter((row) => row.itemCount > 0)
      .sort((left, right) =>
        left.lastMessageAt !== right.lastMessageAt
          ? right.lastMessageAt - left.lastMessageAt
          : left.id < right.id
            ? 1
            : -1,
      )
      .slice(0, input.limit);
  }

  async setReviewStatus(
    tenant: TenantRef,
    id: string,
    status: ConversationReviewStatus,
  ): Promise<boolean> {
    const row = this.#rows.get(rowKey(tenant, id));
    if (row) row.reviewStatus = status;
    return row !== undefined;
  }

  async addNote(tenant: TenantRef, id: string, note: ConversationNote): Promise<boolean> {
    const row = this.#rows.get(rowKey(tenant, id));
    row?.notes.push({ ...note, seq: row.notes.length + 1 });
    return row !== undefined;
  }

  async forget(tenant: TenantRef, id: string): Promise<ConversationForgetResult> {
    const key = rowKey(tenant, id);
    const row = this.#rows.get(key);
    if (!row) return { conversations: 0, items: 0 };
    this.#rows.delete(key);
    return { conversations: 1, items: row.items.length };
  }

  async forgetSubject(
    tenant: TenantRef,
    subject: ConversationSubject,
  ): Promise<ConversationForgetResult> {
    const tenantKey = conversationTenantKey(tenant);
    const removed = { conversations: 0, items: 0 };
    for (const [key, row] of this.#rows) {
      if (
        conversationTenantKey(row.header.tenant) !== tenantKey ||
        row.header.subject.kind !== subject.kind ||
        row.header.subject.ref !== subject.ref
      )
        continue;
      this.#rows.delete(key);
      removed.conversations += 1;
      removed.items += row.items.length;
    }
    return removed;
  }

  async countOutsideWindow(
    tenant: TenantRef,
    input: { readonly now: number; readonly days: number },
  ): Promise<ConversationForgetResult> {
    return this.#window(tenant, input, false);
  }

  async capExpiry(
    tenant: TenantRef,
    input: { readonly now: number; readonly days: number },
  ): Promise<ConversationForgetResult> {
    return this.#window(tenant, input, true);
  }

  #window(
    tenant: TenantRef,
    input: { readonly now: number; readonly days: number },
    apply: boolean,
  ): ConversationForgetResult {
    const tenantKey = conversationTenantKey(tenant);
    const counts = { conversations: 0, items: 0 };
    for (const row of this.#rows.values()) {
      if (conversationTenantKey(row.header.tenant) !== tenantKey) continue;
      const capped = row.items.map((item) => ({
        ...item,
        expiresAt: Math.min(item.expiresAt, conversationExpiryBound(item.at, input)),
      })) as StoredConversationItem[];
      const visible = row.items.filter((item) => item.expiresAt > input.now).length;
      const remaining = capped.filter((item) => item.expiresAt > input.now).length;
      counts.items += visible - remaining;
      if (visible > 0 && remaining === 0) counts.conversations += 1;
      if (!apply) continue;
      row.items = capped;
      row.expiresAt = Math.min(row.expiresAt, Math.max(0, ...capped.map((item) => item.expiresAt)));
    }
    return counts;
  }

  async purgeExpired(input: { readonly limit?: number }): Promise<number> {
    const now = this.now();
    let removed = 0;
    const limit = input.limit ?? 500;
    for (const [key, row] of this.#rows) {
      const kept = row.items.filter((item) => item.expiresAt > now || removed++ >= limit);
      row.items = kept;
      if (row.expiresAt <= now && removed < limit) {
        this.#rows.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}

function visible(item: StoredConversationItem, now: number, notBefore: number): boolean {
  return item.expiresAt > now && item.at >= notBefore;
}

function rowKey(tenant: TenantRef, id: string): string {
  return `${conversationTenantKey(tenant)}\u0000${id}`;
}
