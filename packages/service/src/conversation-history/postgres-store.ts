import type { SealedSecret, SecretBox } from '@noodle-borg/runtime';
import type { Pool } from 'pg';
import { withPostgresTransaction } from '../store/postgres-transaction.js';
import type { TenantRef } from '../store.js';
import {
  CONVERSATION_DAY_MS,
  type ConversationChannel,
  type ConversationHeader,
  type ConversationHistoryStore,
  type ConversationItem,
  type ConversationSubject,
  conversationTenantKey,
  type StoredConversation,
  type StoredConversationItem,
} from './contracts.js';

const PURPOSE = 'assistant-conversation-v1';

interface HeaderRow {
  readonly channel: ConversationChannel;
  readonly subject_kind: ConversationSubject['kind'];
  readonly subject_ref: string;
  readonly started_at: string;
  readonly last_message_at: string;
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
           subject_ref = CASE WHEN subject_kind = 'anonymous' AND $5 = 'customer' THEN $6 ELSE subject_ref END
         WHERE tenant_key = $1 AND id = $2`,
        [
          key,
          header.id,
          Math.max(...items.map((item) => item.at)),
          Math.max(...expiries),
          header.subject.kind,
          header.subject.ref,
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

  async read(tenant: TenantRef, id: string, now: number): Promise<StoredConversation | undefined> {
    const key = conversationTenantKey(tenant);
    const header = await this.pool.query<HeaderRow>(
      'SELECT channel,subject_kind,subject_ref,started_at,last_message_at FROM assistant_conversations WHERE tenant_key = $1 AND id = $2',
      [key, id],
    );
    const row = header.rows[0];
    if (!row) return undefined;
    const { rows } = await this.pool.query<{
      seq: number;
      expires_at: string;
      sealed: SealedSecret;
    }>(
      'SELECT seq,expires_at,sealed FROM assistant_conversation_items WHERE tenant_key = $1 AND conversation_id = $2 AND expires_at > $3 ORDER BY seq',
      [key, id, now],
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
      items,
    };
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
