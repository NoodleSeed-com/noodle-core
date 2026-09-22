import { beforeEach, describe, expect, it } from 'vitest';
import {
  CONVERSATION_DAY_MS,
  type ConversationHeader,
  type ConversationHistoryStore,
} from '../src/conversation-history/contracts.js';

export const T0 = 1_900_000_000_000;
export const TENANT = { org: 'crumb', app: 'bakery', env: 'prod' } as const;
const OTHER = { org: 'other', app: 'bakery', env: 'prod' } as const;

const anonymous: ConversationHeader = {
  id: 'cv_web_1',
  tenant: TENANT,
  channel: 'website',
  subject: { kind: 'anonymous', ref: 'anon_9f' },
};

/** Store parity: every ConversationHistoryStore implementation runs these (ADR 0241). */
export function describeConversationHistoryStore(
  name: string,
  create: (clock: { now: number }) => Promise<ConversationHistoryStore>,
): void {
  describe(`${name} conversation history store`, () => {
    const clock = { now: T0 };
    let store: ConversationHistoryStore;
    beforeEach(async () => {
      clock.now = T0;
      store = await create(clock);
    });

    it('appends items in order with an expiry measured from each item', async () => {
      await store.append(
        anonymous,
        [
          { kind: 'message', role: 'user', text: 'Gluten-free cakes?', at: T0 },
          { kind: 'message', role: 'assistant', text: 'Yes, 48 hours notice.', at: T0 + 1_000 },
        ],
        7,
      );
      await store.append(
        anonymous,
        [
          {
            kind: 'outcome',
            interactionId: 'int_1',
            tool: 'create_order',
            status: 'succeeded',
            at: T0 + 2_000,
          },
        ],
        7,
      );
      const read = await store.read(TENANT, anonymous.id, T0 + 3_000);
      expect(read?.subject).toEqual(anonymous.subject);
      expect(read?.startedAt).toBe(T0);
      expect(read?.lastMessageAt).toBe(T0 + 2_000);
      expect(read?.items.map((item) => [item.seq, item.kind, item.expiresAt])).toEqual([
        [1, 'message', T0 + 7 * CONVERSATION_DAY_MS],
        [2, 'message', T0 + 1_000 + 7 * CONVERSATION_DAY_MS],
        [3, 'outcome', T0 + 2_000 + 7 * CONVERSATION_DAY_MS],
      ]);
      expect(read?.items[2]).toMatchObject({ tool: 'create_order', status: 'succeeded' });
    });

    it('hides an item exactly at its expiry and purges it physically', async () => {
      await store.append(
        anonymous,
        [
          { kind: 'message', role: 'user', text: 'old', at: T0 },
          { kind: 'message', role: 'user', text: 'new', at: T0 + CONVERSATION_DAY_MS },
        ],
        7,
      );
      const boundary = T0 + 7 * CONVERSATION_DAY_MS;
      const read = await store.read(TENANT, anonymous.id, boundary);
      expect(read?.items.map((item) => item.kind === 'message' && item.text)).toEqual(['new']);
      clock.now = boundary;
      expect(await store.purgeExpired({ limit: 100 })).toBe(1);
      clock.now = boundary + CONVERSATION_DAY_MS;
      expect(await store.purgeExpired({ limit: 100 })).toBe(2);
      expect(await store.read(TENANT, anonymous.id, 0)).toBeUndefined();
    });

    it('never reads or finds another tenant’s conversation', async () => {
      await store.append(anonymous, [{ kind: 'message', role: 'user', text: 'hi', at: T0 }], 7);
      expect(await store.read(OTHER, anonymous.id, T0)).toBeUndefined();
      expect(await store.findRecent(OTHER, 'website', anonymous.subject, T0 - 1)).toBeUndefined();
    });

    it('moves an anonymous conversation to a verified customer without copying or re-dating it', async () => {
      await store.append(anonymous, [{ kind: 'message', role: 'user', text: 'hi', at: T0 }], 7);
      const customer = { kind: 'customer', ref: 'sara_91' } as const;
      expect(await store.reown(TENANT, anonymous.id, customer)).toBe(true);
      expect(await store.reown(TENANT, anonymous.id, { kind: 'customer', ref: 'other' })).toBe(
        false,
      );
      const read = await store.read(TENANT, anonymous.id, T0);
      expect(read?.subject).toEqual(customer);
      expect(read?.items[0]?.at).toBe(T0);
      expect(await store.findRecent(TENANT, 'website', anonymous.subject, 0)).toBeUndefined();
    });

    it('re-owns on the first verified write to an anonymous conversation', async () => {
      await store.append(anonymous, [{ kind: 'message', role: 'user', text: 'hi', at: T0 }], 7);
      await store.append(
        { ...anonymous, subject: { kind: 'customer', ref: 'sara_91' } },
        [{ kind: 'message', role: 'user', text: 'signed in', at: T0 + 1 }],
        7,
      );
      const read = await store.read(TENANT, anonymous.id, T0 + 2);
      expect(read?.subject).toEqual({ kind: 'customer', ref: 'sara_91' });
      expect(read?.items).toHaveLength(2);
    });

    it('finds the newest conversation of a subject active since a cutoff', async () => {
      const participant = { kind: 'participant', ref: 'wa_4821' } as const;
      const whatsapp = { ...anonymous, channel: 'whatsapp', subject: participant } as const;
      await store.append(
        { ...whatsapp, id: 'cv_wa_old' },
        [{ kind: 'message', role: 'user', text: 'Monday', at: T0 }],
        7,
      );
      await store.append(
        { ...whatsapp, id: 'cv_wa_new' },
        [{ kind: 'message', role: 'user', text: 'Friday', at: T0 + 4 * CONVERSATION_DAY_MS }],
        7,
      );
      expect(await store.findRecent(TENANT, 'whatsapp', participant, T0 - 1)).toBe('cv_wa_new');
      expect(
        await store.findRecent(TENANT, 'whatsapp', participant, T0 + 5 * CONVERSATION_DAY_MS),
      ).toBeUndefined();
    });
  });
}
