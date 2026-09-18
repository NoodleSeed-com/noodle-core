import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { type ChannelStore, InMemoryChannelStore } from '../src/channel-store.js';
import { PostgresChannelStore } from '../src/postgres-channel-store.js';
import { isolatedPostgres } from './isolated-postgres.js';

function parity(create: () => ChannelStore) {
  it('serializes concurrent claims and rolls back failed transactions', async () => {
    const store = create();
    const scope = randomUUID();
    await Promise.all(
      Array.from({ length: 12 }, () =>
        store.transaction([scope], async (tx) => {
          const old = await tx.get(scope, 'count');
          await tx.put(scope, {
            id: 'count',
            kind: 'counter',
            updatedAt: 1,
            value: Number(old?.value ?? 0) + 1,
          });
        }),
      ),
    );
    expect((await store.transaction([scope], (tx) => tx.get(scope, 'count')))?.value).toBe(12);
    await expect(
      store.transaction([scope], async (tx) => {
        await tx.remove(scope, 'count');
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect((await store.transaction([scope], (tx) => tx.get(scope, 'count')))?.value).toBe(12);
  });
  it('isolates bindings and requires a lock before writing', async () => {
    const store = create();
    const a = randomUUID();
    const b = randomUUID();
    await store.transaction([a], (tx) =>
      tx.put(a, { id: 'one', kind: 'event', updatedAt: 10, value: { text: 'private' } }),
    );
    expect(await store.transaction([b], (tx) => tx.get(b, 'one'))).toBeUndefined();
    await expect(store.transaction([a], (tx) => tx.remove(b, 'one'))).rejects.toThrow(/lock/i);
  });
  it('filters bounded scans, enforces expiry and preserves unexpired authority', async () => {
    const store = create();
    const scope = randomUUID();
    await store.transaction([scope], async (tx) => {
      for (let index = 0; index < 3; index++)
        await tx.put(scope, {
          id: String(index),
          kind: 'event',
          state: index === 2 ? 'done' : 'queued',
          updatedAt: index,
          expiresAt: index === 0 ? 5 : 100,
          value: { index },
        });
    });
    expect(
      await store.transaction([scope], (tx) =>
        tx.list(scope, { kind: 'event', state: 'queued', limit: 1 }),
      ),
    ).toHaveLength(1);
    await store.prune(5, 100);
    expect(
      (await store.transaction([scope], (tx) => tx.list(scope, { kind: 'event', limit: 100 }))).map(
        (row) => row.id,
      ),
    ).toEqual(['1', '2']);
  });
}

describe('memory channel store', () => parity(() => new InMemoryChannelStore()));
const url = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
describe.skipIf(!url)('Postgres channel store', () => {
  const pool = isolatedPostgres(url);
  // Transport-neutral cipher port: production composition supplies the deployment SecretBox.
  const cipher = {
    seal: async (scope: string, id: string, value: unknown) => ({ scope, id, value }),
    open: async (scope: string, id: string, sealed: unknown) => {
      const envelope = sealed as { scope: string; id: string; value: unknown };
      if (scope !== envelope.scope || id !== envelope.id)
        throw new Error('cipher context mismatch');
      return envelope.value;
    },
  };
  const store = new PostgresChannelStore(pool, cipher);
  beforeAll(async () => {
    await store.ensureSchema();
    await store.ensureSchema();
  });
  parity(() => store);
  it('uses logged records and survives construction of a new adapter', async () => {
    const scope = randomUUID();
    await store.transaction([scope], (tx) =>
      tx.put(scope, { id: 'restart', kind: 'event', updatedAt: 1, value: { ok: true } }),
    );
    const restarted = new PostgresChannelStore(pool, cipher);
    expect((await restarted.transaction([scope], (tx) => tx.get(scope, 'restart')))?.value).toEqual(
      { ok: true },
    );
    const result = await pool.query(
      "SELECT relpersistence FROM pg_class WHERE oid='assistant_channel_records'::regclass",
    );
    expect(result.rows[0].relpersistence).toBe('p');
  });
});
