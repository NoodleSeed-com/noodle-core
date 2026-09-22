import { randomUUID } from 'node:crypto';
import { SecretBox, staticMasterKeyProvider } from '@noodle-borg/runtime';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresConversationHistoryStore } from '../src/conversation-history/postgres-store.js';
import { describeConversationHistoryStore, T0, TENANT } from './conversation-history-suite.js';

const databaseUrl = process.env.DATABASE_URL_TEST;
describe.skipIf(databaseUrl === undefined)('PostgreSQL conversation history', () => {
  const schema = `conversation_history_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 4,
    options: `-c search_path=${schema}`,
  });
  const box = new SecretBox(staticMasterKeyProvider(Buffer.alloc(32, 13).toString('base64')));
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await new PostgresConversationHistoryStore(pool, box).ensureSchema();
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  describeConversationHistoryStore('postgres', async (clock) => {
    await pool.query('TRUNCATE assistant_conversation_items, assistant_conversations');
    return new PostgresConversationHistoryStore(pool, box, () => clock.now);
  });

  it('keeps history in logged tables that survive a restart, with content sealed', async () => {
    const { rows } = await pool.query<{ relname: string; relpersistence: string }>(
      `SELECT relname, relpersistence FROM pg_class JOIN pg_namespace ON pg_namespace.oid = relnamespace
       WHERE nspname = $1 AND relname IN ('assistant_conversations','assistant_conversation_items')`,
      [schema],
    );
    expect(rows.map((row) => row.relpersistence)).toEqual(['p', 'p']);
    await new PostgresConversationHistoryStore(pool, box).append(
      {
        id: 'cv_restart',
        tenant: TENANT,
        channel: 'website',
        subject: { kind: 'anonymous', ref: 'a' },
      },
      [{ kind: 'message', role: 'user', text: 'secret-ish text', at: T0 }],
      7,
    );
    const raw = await pool.query(
      "SELECT sealed::text AS sealed FROM assistant_conversation_items WHERE conversation_id = 'cv_restart'",
    );
    expect(raw.rows[0]?.sealed).not.toContain('secret-ish');
    const reopened = new PostgresConversationHistoryStore(pool, box);
    expect((await reopened.read(TENANT, 'cv_restart', T0))?.items[0]).toMatchObject({
      text: 'secret-ish text',
    });
  });

  it('refuses a sealed row copied into another conversation', async () => {
    const store = new PostgresConversationHistoryStore(pool, box);
    const header = {
      tenant: TENANT,
      channel: 'website',
      subject: { kind: 'anonymous', ref: 'a' },
    } as const;
    await store.append(
      { ...header, id: 'cv_source' },
      [{ kind: 'message', role: 'user', text: 'x', at: T0 }],
      7,
    );
    await store.append(
      { ...header, id: 'cv_target' },
      [{ kind: 'message', role: 'user', text: 'y', at: T0 }],
      7,
    );
    await pool.query(
      `UPDATE assistant_conversation_items SET sealed = (SELECT sealed FROM assistant_conversation_items WHERE conversation_id = 'cv_source')
       WHERE conversation_id = 'cv_target'`,
    );
    await expect(store.read(TENANT, 'cv_target', T0)).rejects.toThrow('context mismatch');
  });
});
