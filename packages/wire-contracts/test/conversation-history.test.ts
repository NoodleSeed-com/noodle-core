import { describe, expect, it } from 'vitest';
import {
  ConversationExportResponseSchema,
  ConversationForgetRequestSchema,
  ConversationForgetResponseSchema,
  ConversationListClientResponseSchema,
  ConversationListResponseSchema,
  ConversationShowClientResponseSchema,
  ConversationShowResponseSchema,
} from '../src/conversation-history.js';

const summary = {
  id: 'cv_0123456789abcdef',
  channel: 'website',
  subject: { kind: 'customer', ref: 'sara_91' },
  startedAt: '2026-09-07T00:00:00.000Z',
  lastMessageAt: '2026-09-07T00:01:00.000Z',
  itemCount: 2,
};
const items = [
  { kind: 'message', role: 'user', text: 'Gluten-free cakes?', at: '2026-09-07T00:00:00.000Z' },
  {
    kind: 'outcome',
    interactionId: 'int_1',
    tool: 'create_order',
    status: 'succeeded',
    at: '2026-09-07T00:01:00.000Z',
  },
];

describe('conversation history operator wire', () => {
  it('keeps server output strict and lets clients ignore additive fields', () => {
    const list = { ok: true, data: { conversations: [summary], nextCursor: 'opaque' } };
    expect(ConversationListResponseSchema.parse(list)).toEqual(list);
    expect(() =>
      ConversationListResponseSchema.parse({
        ok: true,
        data: { conversations: [{ ...summary, raw: 'x' }] },
      }),
    ).toThrow();
    expect(
      ConversationListClientResponseSchema.parse({
        ok: true,
        data: { conversations: [{ ...summary, future: 1 }], future: 2 },
      }).data.conversations[0],
    ).toEqual(summary);
    const show = { ok: true, data: { conversation: { ...summary, items } } };
    expect(ConversationShowResponseSchema.parse(show)).toEqual(show);
    expect(
      ConversationShowClientResponseSchema.parse({
        ok: true,
        data: { conversation: { ...summary, items: [{ ...items[0], extra: true }] } },
      }).data.conversation.items[0],
    ).toEqual(items[0]);
  });

  it('never carries an anonymous handle and rejects malformed ids', () => {
    expect(() =>
      ConversationListResponseSchema.parse({
        ok: true,
        data: { conversations: [{ ...summary, subject: { kind: 'anonymous', ref: 'anon' } }] },
      }),
    ).toThrow();
    expect(
      ConversationListResponseSchema.parse({
        ok: true,
        data: { conversations: [{ ...summary, subject: { kind: 'anonymous' } }] },
      }).data.conversations[0]?.subject,
    ).toEqual({ kind: 'anonymous' });
    expect(() =>
      ConversationListResponseSchema.parse({
        ok: true,
        data: { conversations: [{ ...summary, id: 'cv_short' }] },
      }),
    ).toThrow();
  });

  it('bounds export pages to 25 conversations', () => {
    const conversation = { ...summary, items };
    expect(
      ConversationExportResponseSchema.safeParse({
        ok: true,
        data: { conversations: Array.from({ length: 26 }, () => conversation) },
      }).success,
    ).toBe(false);
  });

  it('accepts exactly one forget selector for a customer or participant', () => {
    expect(ConversationForgetRequestSchema.parse({ conversationId: summary.id })).toEqual({
      conversationId: summary.id,
    });
    expect(
      ConversationForgetRequestSchema.parse({ subject: { kind: 'participant', ref: 'wa_1' } }),
    ).toEqual({ subject: { kind: 'participant', ref: 'wa_1' } });
    for (const invalid of [
      {},
      { conversationId: summary.id, subject: { kind: 'customer', ref: 'a' } },
      { subject: { kind: 'anonymous', ref: 'a' } },
      { subject: { kind: 'customer', ref: '' } },
      { conversationId: 'not-a-conversation' },
    ])
      expect(
        ConversationForgetRequestSchema.safeParse(invalid).success,
        JSON.stringify(invalid),
      ).toBe(false);
    const forgotten = { ok: true, data: { forgotten: { conversations: 2, items: 5 } } };
    expect(ConversationForgetResponseSchema.parse(forgotten)).toEqual(forgotten);
  });
});
