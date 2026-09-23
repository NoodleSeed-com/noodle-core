import { describe, expect, it } from 'vitest';
import {
  AssistantConversationForgetUserRequestSchema,
  AssistantConversationListClientResponseSchema,
  AssistantConversationListRequestSchema,
  AssistantConversationListResponseSchema,
} from '../src/conversation-history.js';

/** The customer-backend projection (ADR 0241 decision 12): one verified user, never a tenant scan. */
const row = {
  id: 'cv_0123456789abcdef',
  channel: 'website',
  startedAt: '2026-09-07T00:00:00.000Z',
  lastMessageAt: '2026-09-07T00:01:00.000Z',
  preview: 'Do you bake gluten-free cakes?',
};

describe('assistant customer-backend conversation wire', () => {
  it('takes only a bounded verified user id, page size and cursor', () => {
    const request = { user: { id: 'user_42' }, limit: 50, cursor: 'opaque' };
    expect(AssistantConversationListRequestSchema.parse(request)).toEqual(request);
    expect(AssistantConversationForgetUserRequestSchema.parse({ user: { id: 'user_42' } })).toEqual(
      { user: { id: 'user_42' } },
    );
    for (const invalid of [
      {},
      { user: {} },
      { user: { id: '' } },
      { user: { id: 'x'.repeat(241) } },
      { user: { id: 'user_42', email: 'a@b.test' } },
      { user: { id: 'user_42' }, limit: 51 },
      { user: { id: 'user_42' }, limit: 0 },
      { user: { id: 'user_42' }, cursor: '' },
      { user: { id: 'user_42' }, tenant: { org: 'other' } },
    ])
      expect(
        AssistantConversationListRequestSchema.safeParse(invalid).success,
        JSON.stringify(invalid),
      ).toBe(false);
    expect(
      AssistantConversationForgetUserRequestSchema.safeParse({
        user: { id: 'user_42' },
        subject: { kind: 'participant', ref: 'wa' },
      }).success,
    ).toBe(false);
  });

  it('keeps server rows strict, previews bounded, and never carries the subject', () => {
    const list = { ok: true, data: { conversations: [row], nextCursor: 'next' } };
    expect(AssistantConversationListResponseSchema.parse(list)).toEqual(list);
    const { preview: _preview, ...withoutPreview } = row;
    expect(
      AssistantConversationListResponseSchema.safeParse({
        ok: true,
        data: { conversations: [withoutPreview] },
      }).success,
    ).toBe(true);
    for (const invalid of [
      { ...row, subject: { kind: 'customer', ref: 'user_42' } },
      { ...row, preview: 'x'.repeat(121) },
      { ...row, itemCount: 2 },
    ])
      expect(
        AssistantConversationListResponseSchema.safeParse({
          ok: true,
          data: { conversations: [invalid] },
        }).success,
      ).toBe(false);
    expect(
      AssistantConversationListResponseSchema.safeParse({
        ok: true,
        data: { conversations: Array.from({ length: 51 }, () => row) },
      }).success,
    ).toBe(false);
  });

  it('lets clients ignore additive fields', () => {
    expect(
      AssistantConversationListClientResponseSchema.parse({
        ok: true,
        data: { conversations: [{ ...row, future: 1 }], future: 2 },
      }).data.conversations[0],
    ).toEqual(row);
  });
});
