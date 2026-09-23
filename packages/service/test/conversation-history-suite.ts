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

    it('lists unexpired conversations newest first with a stable id tie-break and keyset paging', async () => {
      const web = (id: string, at: number, days = 7) =>
        store.append({ ...anonymous, id }, [{ kind: 'message', role: 'user', text: id, at }], days);
      await web('cv_list_a', T0);
      await web('cv_list_b', T0 + 1_000);
      await web('cv_list_c', T0 + 1_000);
      await web('cv_list_old', T0 - 10 * CONVERSATION_DAY_MS);
      await store.append(
        {
          id: 'cv_list_wa',
          tenant: TENANT,
          channel: 'whatsapp',
          subject: { kind: 'participant', ref: 'wa_1' },
        },
        [
          { kind: 'message', role: 'user', text: 'hi', at: T0 + 500 },
          { kind: 'message', role: 'assistant', text: 'hello', at: T0 + 600 },
        ],
        7,
      );
      await store.append(
        { ...anonymous, id: 'cv_other' },
        [{ kind: 'message', role: 'user', text: 'x', at: T0 + 2_000 }],
        7,
      );
      const now = T0 + 3_000;
      const all = await store.list(TENANT, { now, limit: 10 });
      expect(all.map((row) => row.id)).toEqual([
        'cv_other',
        'cv_list_c',
        'cv_list_b',
        'cv_list_wa',
        'cv_list_a',
      ]);
      expect(all[3]).toEqual({
        id: 'cv_list_wa',
        channel: 'whatsapp',
        subject: { kind: 'participant', ref: 'wa_1' },
        startedAt: T0 + 500,
        lastMessageAt: T0 + 600,
        itemCount: 2,
        reviewStatus: 'new',
      });
      const first = await store.list(TENANT, { now, limit: 2 });
      expect(first.map((row) => row.id)).toEqual(['cv_other', 'cv_list_c']);
      const last = first.at(-1);
      const next = await store.list(TENANT, {
        now,
        limit: 2,
        after: { lastMessageAt: last?.lastMessageAt ?? 0, id: last?.id ?? '' },
      });
      expect(next.map((row) => row.id)).toEqual(['cv_list_b', 'cv_list_wa']);
      expect(
        (await store.list(TENANT, { now, limit: 10, channel: 'whatsapp' })).map((row) => row.id),
      ).toEqual(['cv_list_wa']);
      expect(await store.list(OTHER, { now, limit: 10 })).toEqual([]);
    });

    it('counts only unexpired items and drops a conversation at its last expiry', async () => {
      await store.append(
        anonymous,
        [
          { kind: 'message', role: 'user', text: 'old', at: T0 },
          { kind: 'message', role: 'user', text: 'new', at: T0 + CONVERSATION_DAY_MS },
        ],
        7,
      );
      const boundary = T0 + 7 * CONVERSATION_DAY_MS;
      expect((await store.list(TENANT, { now: boundary, limit: 10 }))[0]?.itemCount).toBe(1);
      expect(await store.list(TENANT, { now: boundary + CONVERSATION_DAY_MS, limit: 10 })).toEqual(
        [],
      );
    });

    it('counts unexpired history outside a shorter window, and everything for Off', async () => {
      const day = CONVERSATION_DAY_MS;
      const now = T0 + 20 * day;
      const message = (text: string, at: number) =>
        ({ kind: 'message', role: 'user', text, at }) as const;
      // Entirely older than ten days: the whole conversation leaves the window.
      await store.append(
        { ...anonymous, id: 'cv_window_old' },
        [message('a', T0 + 2 * day), message('b', T0 + 3 * day)],
        30,
      );
      // Straddles the cutoff: one item leaves, the conversation stays.
      await store.append(
        { ...anonymous, id: 'cv_window_mixed' },
        [message('c', T0 + 5 * day), message('d', T0 + 15 * day)],
        30,
      );
      // Already expired at `now`: no longer visible, so never counted.
      await store.append({ ...anonymous, id: 'cv_window_gone' }, [message('e', T0)], 7);
      await store.append(
        { ...anonymous, id: 'cv_window_other', tenant: OTHER },
        [message('f', T0 + 2 * day)],
        30,
      );
      expect(await store.countOutsideWindow(TENANT, { now, days: 10 })).toEqual({
        conversations: 1,
        items: 3,
      });
      expect(await store.countOutsideWindow(TENANT, { now, days: 0 })).toEqual({
        conversations: 2,
        items: 4,
      });
      expect(await store.countOutsideWindow(TENANT, { now, days: 30 })).toEqual({
        conversations: 0,
        items: 0,
      });
      expect(await store.countOutsideWindow(OTHER, { now, days: 0 })).toEqual({
        conversations: 1,
        items: 1,
      });
    });

    it('hides items older than a read bound without touching stored expiry', async () => {
      const day = CONVERSATION_DAY_MS;
      const now = T0 + 20 * day;
      const message = (text: string, at: number) =>
        ({ kind: 'message', role: 'user', text, at }) as const;
      await store.append(
        { ...anonymous, id: 'cv_bound_old' },
        [message('a', T0 + 2 * day), message('b', T0 + 3 * day)],
        30,
      );
      await store.append(
        { ...anonymous, id: 'cv_bound_mixed' },
        [message('c', T0 + 5 * day), message('d', T0 + 15 * day)],
        30,
      );
      await store.append(
        { ...anonymous, id: 'cv_bound_other', tenant: OTHER },
        [message('e', T0 + 2 * day)],
        30,
      );
      const notBefore = now - 7 * day;
      const listed = await store.list(TENANT, { now, limit: 10, notBefore });
      expect(listed.map((row) => [row.id, row.itemCount])).toEqual([['cv_bound_mixed', 1]]);
      expect(await store.read(TENANT, 'cv_bound_old', now, notBefore)).toBeUndefined();
      const mixed = await store.read(TENANT, 'cv_bound_mixed', now, notBefore);
      expect(mixed?.items.map((item) => item.kind === 'message' && item.text)).toEqual(['d']);
      // The item exactly at the bound stays visible; the bound never rewrites stored expiry.
      expect((await store.read(TENANT, 'cv_bound_mixed', now, T0 + 5 * day))?.items).toHaveLength(
        2,
      );
      expect((await store.read(TENANT, 'cv_bound_old', now))?.items[0]?.expiresAt).toBe(
        T0 + 32 * day,
      );
      expect(await store.list(TENANT, { now, limit: 10 })).toHaveLength(2);
      expect(await store.list(OTHER, { now, limit: 10, notBefore })).toEqual([]);
    });

    it('caps stored expiry to a shorter window, never lengthens it, and matches the count', async () => {
      const day = CONVERSATION_DAY_MS;
      const now = T0 + 20 * day;
      const message = (text: string, at: number) =>
        ({ kind: 'message', role: 'user', text, at }) as const;
      await store.append(
        { ...anonymous, id: 'cv_cap_old' },
        [message('a', T0 + 2 * day), message('b', T0 + 3 * day)],
        30,
      );
      await store.append(
        { ...anonymous, id: 'cv_cap_mixed' },
        [message('c', T0 + 5 * day), message('d', T0 + 15 * day)],
        30,
      );
      await store.append({ ...anonymous, id: 'cv_cap_short' }, [message('e', T0 + 19.5 * day)], 1);
      await store.append(
        { ...anonymous, id: 'cv_cap_other', tenant: OTHER },
        [message('f', T0 + 2 * day)],
        30,
      );
      const preview = await store.countOutsideWindow(TENANT, { now, days: 10 });
      expect(await store.capExpiry(TENANT, { now, days: 10 })).toEqual(preview);
      expect(preview).toEqual({ conversations: 1, items: 3 });
      expect(await store.read(TENANT, 'cv_cap_old', now)).toBeUndefined();
      const mixed = await store.read(TENANT, 'cv_cap_mixed', now);
      expect(
        mixed?.items.map((item) => [item.kind === 'message' && item.text, item.expiresAt]),
      ).toEqual([['d', T0 + 25 * day]]);
      // Already shorter than the window: untouched.
      expect((await store.read(TENANT, 'cv_cap_short', now))?.items[0]?.expiresAt).toBe(
        T0 + 20.5 * day,
      );
      expect((await store.list(TENANT, { now, limit: 10 })).map((row) => row.id).sort()).toEqual([
        'cv_cap_mixed',
        'cv_cap_short',
      ]);
      // A longer window never raises an expiry or resurfaces capped history.
      expect(await store.capExpiry(TENANT, { now, days: 60 })).toEqual({
        conversations: 0,
        items: 0,
      });
      expect(await store.read(TENANT, 'cv_cap_old', now)).toBeUndefined();
      expect((await store.read(TENANT, 'cv_cap_mixed', now))?.items).toHaveLength(1);
      // The conversation expiry follows its items, so the capped conversation purges.
      clock.now = now;
      expect(await store.purgeExpired({ limit: 100 })).toBe(4);
      expect(await store.read(TENANT, 'cv_cap_old', 0)).toBeUndefined();
      expect((await store.read(OTHER, 'cv_cap_other', now))?.items[0]?.expiresAt).toBe(
        T0 + 32 * day,
      );
    });

    it('Off hides every item immediately and purge removes the conversations', async () => {
      const now = T0 + CONVERSATION_DAY_MS;
      await store.append(
        { ...anonymous, id: 'cv_off_a' },
        [
          { kind: 'message', role: 'user', text: 'a', at: T0 },
          { kind: 'message', role: 'assistant', text: 'b', at: now },
        ],
        30,
      );
      await store.append(
        { ...anonymous, id: 'cv_off_other', tenant: OTHER },
        [{ kind: 'message', role: 'user', text: 'c', at: T0 }],
        30,
      );
      expect(await store.countOutsideWindow(TENANT, { now, days: 0 })).toEqual({
        conversations: 1,
        items: 2,
      });
      expect(await store.capExpiry(TENANT, { now, days: 0 })).toEqual({
        conversations: 1,
        items: 2,
      });
      expect(await store.list(TENANT, { now, limit: 10 })).toEqual([]);
      clock.now = now;
      expect(await store.purgeExpired({ limit: 100 })).toBe(3);
      expect(await store.list(OTHER, { now, limit: 10 })).toHaveLength(1);
    });

    it('forgets one conversation with all its items, only in its own tenant', async () => {
      await store.append(
        anonymous,
        [
          { kind: 'message', role: 'user', text: 'a', at: T0 },
          { kind: 'message', role: 'assistant', text: 'b', at: T0 + 1 },
        ],
        7,
      );
      await store.append(
        { ...anonymous, tenant: OTHER },
        [{ kind: 'message', role: 'user', text: 'a', at: T0 }],
        7,
      );
      expect(await store.forget(OTHER, 'cv_missing')).toEqual({ conversations: 0, items: 0 });
      expect(await store.forget(TENANT, anonymous.id)).toEqual({ conversations: 1, items: 2 });
      expect(await store.read(TENANT, anonymous.id, T0)).toBeUndefined();
      expect(await store.forget(TENANT, anonymous.id)).toEqual({ conversations: 0, items: 0 });
      expect(await store.read(OTHER, anonymous.id, T0)).toBeDefined();
    });

    it('forgets every conversation of one exact subject and nothing else', async () => {
      const customer = { kind: 'customer', ref: 'sara_91' } as const;
      const message = (text: string) => [{ kind: 'message', role: 'user', text, at: T0 }] as const;
      await store.append({ ...anonymous, id: 'cv_sara_1', subject: customer }, message('1'), 7);
      await store.append(
        { ...anonymous, id: 'cv_sara_2', subject: customer },
        [...message('2'), { kind: 'message', role: 'assistant', text: '3', at: T0 + 1 }],
        7,
      );
      await store.append(
        {
          id: 'cv_sara_wa',
          tenant: TENANT,
          channel: 'whatsapp',
          subject: { kind: 'participant', ref: 'sara_91' },
        },
        message('wa'),
        7,
      );
      await store.append(
        { ...anonymous, id: 'cv_omar', subject: { kind: 'customer', ref: 'omar' } },
        message('o'),
        7,
      );
      await store.append(
        { ...anonymous, id: 'cv_sara_elsewhere', tenant: OTHER, subject: customer },
        message('x'),
        7,
      );
      expect(await store.forgetSubject(TENANT, customer)).toEqual({ conversations: 2, items: 3 });
      expect(
        (await store.list(TENANT, { now: T0, limit: 10 })).map((row) => row.id).sort(),
      ).toEqual(['cv_omar', 'cv_sara_wa']);
      expect(await store.read(OTHER, 'cv_sara_elsewhere', T0)).toBeDefined();
      expect(await store.forgetSubject(TENANT, customer)).toEqual({ conversations: 0, items: 0 });
    });

    it('lists only one exact subject on one channel when asked, keeping the keyset', async () => {
      const customer = { kind: 'customer', ref: 'sara_91' } as const;
      const message = (at: number) => [{ kind: 'message', role: 'user', text: 'hi', at }] as const;
      await store.append({ ...anonymous, id: 'cv_sara_1', subject: customer }, message(T0), 7);
      await store.append({ ...anonymous, id: 'cv_sara_2', subject: customer }, message(T0 + 2), 7);
      await store.append(
        { ...anonymous, id: 'cv_sara_prefix', subject: { kind: 'customer', ref: 'sara_9' } },
        message(T0 + 3),
        7,
      );
      await store.append(
        { ...anonymous, id: 'cv_sara_wa', channel: 'whatsapp', subject: { ...customer } },
        message(T0 + 4),
        7,
      );
      await store.append(
        { ...anonymous, id: 'cv_sara_part', subject: { kind: 'participant', ref: 'sara_91' } },
        message(T0 + 5),
        7,
      );
      await store.append(
        { ...anonymous, id: 'cv_sara_other', tenant: OTHER, subject: customer },
        message(T0 + 6),
        7,
      );
      const page = (after?: { lastMessageAt: number; id: string }) =>
        store.list(TENANT, {
          now: T0 + 10,
          limit: 1,
          channel: 'website',
          subject: customer,
          ...(after ? { after } : {}),
        });
      const first = await page();
      expect(first.map((row) => row.id)).toEqual(['cv_sara_2']);
      const second = await page(first[0]);
      expect(second.map((row) => [row.id, row.subject])).toEqual([['cv_sara_1', customer]]);
      expect(await page(second[0])).toEqual([]);
    });

    it('keeps a review status that filters the list and never re-dates the conversation', async () => {
      const message = [{ kind: 'message', role: 'user', text: 'Order status?', at: T0 }] as const;
      await store.append(anonymous, message, 7);
      await store.append({ ...anonymous, id: 'cv_web_2' }, message, 7);
      expect((await store.read(TENANT, anonymous.id, T0))?.reviewStatus).toBe('new');
      expect(await store.setReviewStatus(TENANT, anonymous.id, 'reviewed')).toBe(true);
      expect(await store.setReviewStatus(OTHER, anonymous.id, 'reviewed')).toBe(false);
      expect(await store.setReviewStatus(TENANT, 'cv_missing', 'reviewed')).toBe(false);
      const reviewed = await store.list(TENANT, { now: T0, limit: 10, reviewStatus: 'reviewed' });
      expect(reviewed.map((row) => [row.id, row.reviewStatus, row.lastMessageAt])).toEqual([
        [anonymous.id, 'reviewed', T0],
      ]);
      expect(
        (await store.list(TENANT, { now: T0, limit: 10, reviewStatus: 'new' })).map(
          (row) => row.id,
        ),
      ).toEqual(['cv_web_2']);
    });

    it('marks a conversation Needs attention when a failed outcome is appended, even after review', async () => {
      const outcome = (status: 'succeeded' | 'failed', at: number) =>
        [
          { kind: 'outcome', interactionId: `int_${at}`, tool: 'create_order', status, at },
        ] as const;
      await store.append(anonymous, outcome('succeeded', T0), 7);
      expect((await store.read(TENANT, anonymous.id, T0))?.reviewStatus).toBe('new');
      await store.append(anonymous, outcome('failed', T0 + 1), 7);
      expect((await store.read(TENANT, anonymous.id, T0))?.reviewStatus).toBe('needs_attention');
      await store.setReviewStatus(TENANT, anonymous.id, 'reviewed');
      await store.append(anonymous, outcome('succeeded', T0 + 2), 7);
      expect((await store.read(TENANT, anonymous.id, T0))?.reviewStatus).toBe('reviewed');
      await store.append(anonymous, outcome('failed', T0 + 3), 7);
      expect((await store.read(TENANT, anonymous.id, T0))?.reviewStatus).toBe('needs_attention');
    });

    it('keeps private notes in order without extending retention or counting them as items', async () => {
      await store.append(
        anonymous,
        [{ kind: 'message', role: 'user', text: 'Refund please', at: T0 }],
        7,
      );
      const later = T0 + 6 * CONVERSATION_DAY_MS;
      expect(
        await store.addNote(TENANT, anonymous.id, {
          author: 'operator',
          text: 'Call back',
          at: later,
        }),
      ).toBe(true);
      expect(
        await store.addNote(TENANT, anonymous.id, { author: 'owner', text: 'Done', at: later + 1 }),
      ).toBe(true);
      expect(
        await store.addNote(OTHER, anonymous.id, { author: 'owner', text: 'x', at: later }),
      ).toBe(false);
      expect(
        await store.addNote(TENANT, 'cv_missing', { author: 'owner', text: 'x', at: later }),
      ).toBe(false);
      const read = await store.read(TENANT, anonymous.id, later + 2);
      expect(read?.notes).toEqual([
        { seq: 1, author: 'operator', text: 'Call back', at: later },
        { seq: 2, author: 'owner', text: 'Done', at: later + 1 },
      ]);
      expect(read?.lastMessageAt).toBe(T0);
      expect(read?.items).toHaveLength(1);
      expect((await store.list(TENANT, { now: later + 2, limit: 10 }))[0]?.itemCount).toBe(1);
      expect(await store.read(OTHER, anonymous.id, later + 2)).toBeUndefined();
      const expiry = T0 + 7 * CONVERSATION_DAY_MS;
      expect(await store.read(TENANT, anonymous.id, expiry)).toBeUndefined();
      expect(await store.list(TENANT, { now: expiry, limit: 10 })).toEqual([]);
      clock.now = expiry;
      expect(await store.purgeExpired({ limit: 100 })).toBe(2);
      expect(
        await store.addNote(TENANT, anonymous.id, { author: 'owner', text: 'x', at: expiry }),
      ).toBe(false);
    });

    it('erases notes with their conversation and never counts them as items', async () => {
      await store.append(anonymous, [{ kind: 'message', role: 'user', text: 'a', at: T0 }], 7);
      await store.addNote(TENANT, anonymous.id, { author: 'owner', text: 'note', at: T0 + 1 });
      expect(await store.countOutsideWindow(TENANT, { now: T0 + 1, days: 0 })).toEqual({
        conversations: 1,
        items: 1,
      });
      expect(await store.forget(TENANT, anonymous.id)).toEqual({ conversations: 1, items: 1 });
      await store.append(anonymous, [{ kind: 'message', role: 'user', text: 'b', at: T0 + 2 }], 7);
      expect((await store.read(TENANT, anonymous.id, T0 + 2))?.notes).toEqual([]);
    });
  });
}
