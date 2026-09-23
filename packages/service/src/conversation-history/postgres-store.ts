import type { SealedSecret, SecretBox } from '@noodle-borg/runtime';
import type { Pool } from 'pg';
import { withPostgresTransaction } from '../store/postgres-transaction.js';
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
  conversationTenantKey,
  type StoredConversation,
  type StoredConversationItem,
  type StoredConversationNote,
} from './contracts.js';

const PURPOSE = 'assistant-conversation-v1';
const NOTE_PURPOSE = 'assistant-conversation-note-v1';
/** SQL twin of `conversationExpiryBound` over ($2 now, $3 days). */
const BOUND = `CASE WHEN $3::bigint = 0 THEN $2::bigint ELSE at + $3::bigint * ${CONVERSATION_DAY_MS} END`;

interface HeaderRow {
  readonly channel: ConversationChannel;
  readonly subject_kind: ConversationSubject['kind'];
  readonly subject_ref: string;
  readonly started_at: string;
  readonly last_message_at: string;
  readonly review_status: ConversationReviewStatus;
}

/**
 * Authoritative, logged PostgreSQL history. Item content is sealed and bound to its tenant, conversation
 * and sequence, so a copied row never opens elsewhere; subject references stay queryable for erasure.
 */
export class PostgresConversationHistoryStore implements ConversationHistoryStore {
  constructor(
    private readonly pool: Pool,
    private readonly box: SecretBox,
    private readonly now: () => number = Date.now,
  ) {}

  async ensureSchema(): Promise<void> {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS assistant_conversations (
      tenant_key text NOT NULL, id text NOT NULL,
      channel text NOT NULL CHECK (channel IN ('website','whatsapp')),
      subject_kind text NOT NULL CHECK (subject_kind IN ('anonymous','customer','participant')),
      subject_ref text NOT NULL, started_at bigint NOT NULL, last_message_at bigint NOT NULL,
      expires_at bigint NOT NULL, PRIMARY KEY (tenant_key, id)
    )`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS assistant_conversation_items (
      tenant_key text NOT NULL, conversation_id text NOT NULL, seq integer NOT NULL,
      at bigint NOT NULL, expires_at bigint NOT NULL, sealed jsonb NOT NULL,
      PRIMARY KEY (tenant_key, conversation_id, seq),
      FOREIGN KEY (tenant_key, conversation_id)
        REFERENCES assistant_conversations (tenant_key, id) ON DELETE CASCADE
    )`);
    await this.pool.query(
      `ALTER TABLE assistant_conversations ADD COLUMN IF NOT EXISTS review_status text NOT NULL DEFAULT 'new'
         CHECK (review_status IN ('new','needs_attention','reviewed'))`,
    );
    // Notes have no expiry of their own: they cascade with their conversation and never extend it.
    await this.pool.query(`CREATE TABLE IF NOT EXISTS assistant_conversation_notes (
      tenant_key text NOT NULL, conversation_id text NOT NULL, seq integer NOT NULL,
      at bigint NOT NULL, sealed jsonb NOT NULL,
      PRIMARY KEY (tenant_key, conversation_id, seq),
      FOREIGN KEY (tenant_key, conversation_id)
        REFERENCES assistant_conversations (tenant_key, id) ON DELETE CASCADE
    )`);
    await this.pool.query(
      'CREATE INDEX IF NOT EXISTS assistant_conversations_subject ON assistant_conversations (tenant_key, channel, subject_kind, subject_ref, last_message_at DESC)',
    );
    await this.pool.query(
      'CREATE INDEX IF NOT EXISTS assistant_conversations_expiry ON assistant_conversations (expires_at)',
    );
    await this.pool.query(
      'CREATE INDEX IF NOT EXISTS assistant_conversation_items_expiry ON assistant_conversation_items (expires_at)',
    );
  }

  async append(
    header: ConversationHeader,
    items: readonly ConversationItem[],
    days: number,
  ): Promise<void> {
    if (items.length === 0) return;
    const key = conversationTenantKey(header.tenant);
    const expiries = items.map((item) => item.at + days * CONVERSATION_DAY_MS);
    await withPostgresTransaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO assistant_conversations
          (tenant_key,id,channel,subject_kind,subject_ref,started_at,last_message_at,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$6,$7) ON CONFLICT DO NOTHING`,
        [key, header.id, header.channel, header.subject.kind, header.subject.ref, items[0]?.at, 0],
      );
      await client.query(
        `UPDATE assistant_conversations SET
           last_message_at = GREATEST(last_message_at, $3), expires_at = GREATEST(expires_at, $4),
           subject_kind = CASE WHEN subject_kind = 'anonymous' AND $5 = 'customer' THEN $5 ELSE subject_kind END,
           subject_ref = CASE WHEN subject_kind = 'anonymous' AND $5 = 'customer' THEN $6 ELSE subject_ref END,
           review_status = CASE WHEN $7::boolean THEN 'needs_attention' ELSE review_status END
         WHERE tenant_key = $1 AND id = $2`,
        [
          key,
          header.id,
          Math.max(...items.map((item) => item.at)),
          Math.max(...expiries),
          header.subject.kind,
          header.subject.ref,
          items.some((item) => item.kind === 'outcome' && item.status === 'failed'),
        ],
      );
      const { rows } = await client.query<{ seq: number }>(
        'SELECT COALESCE(MAX(seq), 0)::int AS seq FROM assistant_conversation_items WHERE tenant_key = $1 AND conversation_id = $2',
        [key, header.id],
      );
      let seq = rows[0]?.seq ?? 0;
      for (const [index, item] of items.entries()) {
        seq += 1;
        const sealed = await this.box.seal(
          JSON.stringify({ purpose: PURPOSE, tenant: key, id: header.id, seq, item }),
        );
        await client.query(
          'INSERT INTO assistant_conversation_items (tenant_key,conversation_id,seq,at,expires_at,sealed) VALUES ($1,$2,$3,$4,$5,$6)',
          [key, header.id, seq, item.at, expiries[index], JSON.stringify(sealed)],
        );
      }
    });
  }

  async findRecent(
    tenant: TenantRef,
    channel: ConversationChannel,
    subject: ConversationSubject,
    since: number,
  ): Promise<string | undefined> {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT id FROM assistant_conversations WHERE tenant_key = $1 AND channel = $2
         AND subject_kind = $3 AND subject_ref = $4 AND last_message_at >= $5
       ORDER BY last_message_at DESC LIMIT 1`,
      [conversationTenantKey(tenant), channel, subject.kind, subject.ref, since],
    );
    return rows[0]?.id;
  }

  async reown(tenant: TenantRef, id: string, subject: ConversationSubject): Promise<boolean> {
    if (subject.kind !== 'customer') return false;
    const { rowCount } = await this.pool.query(
      `UPDATE assistant_conversations SET subject_kind = 'customer', subject_ref = $3
       WHERE tenant_key = $1 AND id = $2 AND subject_kind = 'anonymous'`,
      [conversationTenantKey(tenant), id, subject.ref],
    );
    return rowCount === 1;
  }

  async read(
    tenant: TenantRef,
    id: string,
    now: number,
    notBefore?: number,
  ): Promise<StoredConversation | undefined> {
    const key = conversationTenantKey(tenant);
    const header = await this.pool.query<HeaderRow>(
      'SELECT channel,subject_kind,subject_ref,started_at,last_message_at,review_status FROM assistant_conversations WHERE tenant_key = $1 AND id = $2',
      [key, id],
    );
    const row = header.rows[0];
    if (!row) return undefined;
    const { rows } = await this.pool.query<{
      seq: number;
      expires_at: string;
      sealed: SealedSecret;
    }>(
      `SELECT seq,expires_at,sealed FROM assistant_conversation_items WHERE tenant_key = $1
         AND conversation_id = $2 AND expires_at > $3 AND ($4::bigint IS NULL OR at >= $4) ORDER BY seq`,
      [key, id, now, notBefore ?? null],
    );
    if (rows.length === 0) return undefined;
    const items: StoredConversationItem[] = [];
    for (const item of rows) {
      const opened = JSON.parse(await this.box.open(item.sealed)) as {
        purpose?: unknown;
        tenant?: unknown;
        id?: unknown;
        seq?: unknown;
        item: ConversationItem;
      };
      if (
        opened.purpose !== PURPOSE ||
        opened.tenant !== key ||
        opened.id !== id ||
        opened.seq !== item.seq
      ) {
        throw new Error('conversation item context mismatch');
      }
      items.push({ ...opened.item, seq: item.seq, expiresAt: Number(item.expires_at) });
    }
    return {
      id,
      tenant,
      channel: row.channel,
      subject: { kind: row.subject_kind, ref: row.subject_ref },
      startedAt: Number(row.started_at),
      lastMessageAt: Number(row.last_message_at),
      reviewStatus: row.review_status,
      items,
      notes: await this.#notes(key, id),
    };
  }

  async #notes(key: string, id: string): Promise<StoredConversationNote[]> {
    const { rows } = await this.pool.query<{ seq: number; sealed: SealedSecret }>(
      'SELECT seq,sealed FROM assistant_conversation_notes WHERE tenant_key = $1 AND conversation_id = $2 ORDER BY seq',
      [key, id],
    );
    const notes: StoredConversationNote[] = [];
    for (const row of rows) {
      const opened = JSON.parse(await this.box.open(row.sealed)) as {
        purpose?: unknown;
        tenant?: unknown;
        id?: unknown;
        seq?: unknown;
        note: ConversationNote;
      };
      if (
        opened.purpose !== NOTE_PURPOSE ||
        opened.tenant !== key ||
        opened.id !== id ||
        opened.seq !== row.seq
      )
        throw new Error('conversation note context mismatch');
      notes.push({ ...opened.note, seq: row.seq });
    }
    return notes;
  }

  async setReviewStatus(
    tenant: TenantRef,
    id: string,
    status: ConversationReviewStatus,
  ): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'UPDATE assistant_conversations SET review_status = $3 WHERE tenant_key = $1 AND id = $2',
      [conversationTenantKey(tenant), id, status],
    );
    return rowCount === 1;
  }

  /** Locks the conversation so concurrent notes take distinct sequence numbers. */
  addNote(tenant: TenantRef, id: string, note: ConversationNote): Promise<boolean> {
    const key = conversationTenantKey(tenant);
    return withPostgresTransaction(this.pool, async (client) => {
      const locked = await client.query(
        'SELECT 1 FROM assistant_conversations WHERE tenant_key = $1 AND id = $2 FOR UPDATE',
        [key, id],
      );
      if (locked.rowCount !== 1) return false;
      const { rows } = await client.query<{ seq: number }>(
        'SELECT COALESCE(MAX(seq), 0)::int + 1 AS seq FROM assistant_conversation_notes WHERE tenant_key = $1 AND conversation_id = $2',
        [key, id],
      );
      const seq = rows[0]?.seq ?? 1;
      const sealed = await this.box.seal(
        JSON.stringify({
          purpose: NOTE_PURPOSE,
          tenant: key,
          id,
          seq,
          note: { author: note.author, text: note.text, at: note.at },
        }),
      );
      await client.query(
        'INSERT INTO assistant_conversation_notes (tenant_key,conversation_id,seq,at,sealed) VALUES ($1,$2,$3,$4,$5)',
        [key, id, seq, note.at, JSON.stringify(sealed)],
      );
      return true;
    });
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
    // Ids compare in code-unit order ("C") so the keyset matches every other store.
    const { rows } = await this.pool.query<HeaderRow & { id: string; item_count: number }>(
      `SELECT c.id, c.channel, c.subject_kind, c.subject_ref, c.started_at, c.last_message_at,
              c.review_status, COUNT(*)::int AS item_count
       FROM assistant_conversations c JOIN assistant_conversation_items i
         ON i.tenant_key = c.tenant_key AND i.conversation_id = c.id AND i.expires_at > $2
           AND ($7::bigint IS NULL OR i.at >= $7)
       WHERE c.tenant_key = $1 AND ($3::text IS NULL OR c.channel = $3)
         AND ($8::text IS NULL OR c.review_status = $8)
         AND ($9::text IS NULL OR (c.subject_kind = $9 AND c.subject_ref = $10::text))
         AND ($4::bigint IS NULL OR c.last_message_at < $4
              OR (c.last_message_at = $4 AND c.id COLLATE "C" < $5::text COLLATE "C"))
       GROUP BY c.tenant_key, c.id
       ORDER BY c.last_message_at DESC, c.id COLLATE "C" DESC LIMIT $6`,
      [
        conversationTenantKey(tenant),
        input.now,
        input.channel ?? null,
        input.after?.lastMessageAt ?? null,
        input.after?.id ?? null,
        input.limit,
        input.notBefore ?? null,
        input.reviewStatus ?? null,
        input.subject?.kind ?? null,
        input.subject?.ref ?? null,
      ],
    );
    return rows.map((row) => ({
      id: row.id,
      channel: row.channel,
      subject: { kind: row.subject_kind, ref: row.subject_ref },
      startedAt: Number(row.started_at),
      lastMessageAt: Number(row.last_message_at),
      itemCount: row.item_count,
      reviewStatus: row.review_status,
    }));
  }

  forget(tenant: TenantRef, id: string): Promise<ConversationForgetResult> {
    return this.#erase('id = $2', [conversationTenantKey(tenant), id]);
  }

  forgetSubject(
    tenant: TenantRef,
    subject: ConversationSubject,
  ): Promise<ConversationForgetResult> {
    return this.#erase('subject_kind = $2 AND subject_ref = $3', [
      conversationTenantKey(tenant),
      subject.kind,
      subject.ref,
    ]);
  }

  /**
   * Items are deleted and counted before their conversations, whose cascade would hide the count;
   * notes go with the cascade and are not counted as history items.
   */
  #erase(match: string, values: readonly unknown[]): Promise<ConversationForgetResult> {
    return withPostgresTransaction(this.pool, async (client) => {
      const selected = `SELECT id FROM assistant_conversations WHERE tenant_key = $1 AND ${match} FOR UPDATE`;
      const items = await client.query(
        `DELETE FROM assistant_conversation_items WHERE tenant_key = $1 AND conversation_id IN (${selected})`,
        [...values],
      );
      const conversations = await client.query(
        `DELETE FROM assistant_conversations WHERE tenant_key = $1 AND ${match}`,
        [...values],
      );
      return { conversations: conversations.rowCount ?? 0, items: items.rowCount ?? 0 };
    });
  }

  countOutsideWindow(
    tenant: TenantRef,
    input: { readonly now: number; readonly days: number },
  ): Promise<ConversationForgetResult> {
    return this.#window(this.pool, tenant, input);
  }

  capExpiry(
    tenant: TenantRef,
    input: { readonly now: number; readonly days: number },
  ): Promise<ConversationForgetResult> {
    return withPostgresTransaction(this.pool, async (client) => {
      const values = [conversationTenantKey(tenant), input.now, input.days];
      await client.query(
        'SELECT 1 FROM assistant_conversations WHERE tenant_key = $1 FOR UPDATE',
        values.slice(0, 1),
      );
      const counts = await this.#window(client, tenant, input);
      await client.query(
        `UPDATE assistant_conversation_items SET expires_at = ${BOUND}
         WHERE tenant_key = $1 AND ${BOUND} < expires_at`,
        values,
      );
      await client.query(
        `UPDATE assistant_conversations c SET expires_at = LEAST(c.expires_at, latest.expires_at)
         FROM (SELECT conversation_id, MAX(expires_at) AS expires_at FROM assistant_conversation_items
               WHERE tenant_key = $1 GROUP BY conversation_id) AS latest
         WHERE c.tenant_key = $1 AND c.id = latest.conversation_id`,
        values.slice(0, 1),
      );
      return counts;
    });
  }

  /** Visible items whose bounded expiry is already past, as `capExpiry` would hide them. */
  async #window(
    executor: Pick<Pool, 'query'>,
    tenant: TenantRef,
    input: { readonly now: number; readonly days: number },
  ): Promise<ConversationForgetResult> {
    const { rows } = await executor.query<{ conversations: number; items: number }>(
      `SELECT COUNT(*) FILTER (WHERE hidden = visible)::int AS conversations,
              COALESCE(SUM(hidden), 0)::int AS items
       FROM (SELECT COUNT(*) AS visible, COUNT(*) FILTER (WHERE ${BOUND} <= $2) AS hidden
             FROM assistant_conversation_items WHERE tenant_key = $1 AND expires_at > $2
             GROUP BY conversation_id) AS window_counts`,
      [conversationTenantKey(tenant), input.now, input.days],
    );
    return { conversations: rows[0]?.conversations ?? 0, items: rows[0]?.items ?? 0 };
  }

  async purgeExpired(input: { readonly limit?: number }): Promise<number> {
    const now = this.now();
    const limit = input.limit ?? 500;
    const items = await this.pool.query(
      `DELETE FROM assistant_conversation_items WHERE ctid IN (
         SELECT ctid FROM assistant_conversation_items WHERE expires_at <= $1 LIMIT $2)`,
      [now, limit],
    );
    const removed = items.rowCount ?? 0;
    if (removed >= limit) return removed;
    const conversations = await this.pool.query(
      `DELETE FROM assistant_conversations WHERE ctid IN (
         SELECT ctid FROM assistant_conversations WHERE expires_at <= $1 LIMIT $2)`,
      [now, limit - removed],
    );
    return removed + (conversations.rowCount ?? 0);
  }
}
