import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { type ChannelStore, InMemoryChannelStore } from '../src/channel-store.js';
import { applyCapture } from '../src/collection-ledger.js';
import { deleteCollection, loadCollection, saveCollection } from '../src/collection-store.js';
import { PostgresChannelStore } from '../src/postgres-channel-store.js';
import { leadSpec, NOW, openLead } from './collection-fixture.js';
import { isolatedPostgres } from './isolated-postgres.js';

function parity(create: () => ChannelStore) {
  it('keeps one sealed open collection per participant and binding', async () => {
    const store = create();
    const bindingId = randomUUID();
    const ledger = { ...openLead(), bindingId };
    const captured = applyCapture(
      leadSpec,
      ledger,
      { email: { status: 'captured', value: 'maya@example.com' } },
      NOW + 1,
    );
    await store.transaction([bindingId], async (tx) => {
      await saveCollection(tx, ledger);
      await saveCollection(tx, captured);
    });
    const rows = await store.transaction([bindingId], (tx) =>
      tx.list(bindingId, { kind: 'interaction', limit: 10 }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      state: 'collecting',
      updatedAt: NOW + 1,
      expiresAt: Date.parse(captured.expiresAt),
    });
    expect(
      await store.transaction([bindingId], (tx) => loadCollection(tx, bindingId, 'p_1')),
    ).toEqual(captured);
    expect(
      await store.transaction([bindingId], (tx) => loadCollection(tx, bindingId, 'p_other')),
    ).toBeUndefined();
    await store.transaction([bindingId], (tx) => deleteCollection(tx, bindingId, 'p_1'));
    expect(
      await store.transaction([bindingId], (tx) => loadCollection(tx, bindingId, 'p_1')),
    ).toBeUndefined();
  });
  it('is pruned with the channel retention window', async () => {
    const store = create();
    const bindingId = randomUUID();
    const ledger = { ...openLead(), bindingId };
    await store.transaction([bindingId], (tx) => saveCollection(tx, ledger));
    expect(await store.prune(Date.parse(ledger.expiresAt) - 1, 100)).toBe(0);
    expect(await store.prune(Date.parse(ledger.expiresAt), 100)).toBe(1);
    expect(
      await store.transaction([bindingId], (tx) => loadCollection(tx, bindingId, 'p_1')),
    ).toBeUndefined();
  });
}

describe('memory collection store', () => parity(() => new InMemoryChannelStore()));
const url = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
describe.skipIf(!url)('Postgres collection store', () => {
  const pool = isolatedPostgres(url);
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
  });
  parity(() => store);
});
