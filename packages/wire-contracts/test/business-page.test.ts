import { describe, expect, it } from 'vitest';
import {
  BusinessPageClientResponseSchema,
  BusinessPageContentSchema,
  BusinessPagePublishRequestSchema,
  BusinessPageResponseSchema,
  BusinessPageSaveRequestSchema,
} from '../src/business-page.js';

const content = {
  introduction: 'Welcome to Acme.',
  sections: [{ title: 'How we help', text: 'Ask about our services.' }],
};
describe('hosted business-page contracts', () => {
  it('keeps bounded plain content separate from publication', () => {
    expect(BusinessPageSaveRequestSchema.parse({ expectedRevision: 0, content })).toEqual({
      expectedRevision: 0,
      content,
    });
    for (const extra of [{ published: true }, { html: '<script />' }, { theme: 'custom' }])
      expect(
        BusinessPageSaveRequestSchema.safeParse({ expectedRevision: 0, content, ...extra }).success,
      ).toBe(false);
    expect(BusinessPagePublishRequestSchema.safeParse({ expectedRevision: 0 }).success).toBe(false);
    expect(BusinessPagePublishRequestSchema.parse({ expectedRevision: 1 })).toEqual({
      expectedRevision: 1,
    });
  });
  it('rejects oversized content, invisible controls, and unknown nested fields', () => {
    for (const invalid of [
      { ...content, introduction: 'x'.repeat(1201) },
      { ...content, introduction: 'hello\u0000world' },
      { ...content, sections: Array.from({ length: 9 }, () => content.sections[0]) },
      { ...content, sections: [{ title: 'Info', text: 'x'.repeat(4001) }] },
      { ...content, sections: [{ ...content.sections[0], privateNotes: 'hidden' }] },
    ])
      expect(BusinessPageContentSchema.safeParse(invalid).success).toBe(false);
    expect(
      BusinessPageSaveRequestSchema.safeParse({ expectedRevision: 2 ** 31, content }).success,
    ).toBe(false);
  });
  it('uses strict server output and recursively additive client readers', () => {
    const data = { revision: 1, draft: content, published: null, canEdit: true };
    expect(
      BusinessPageResponseSchema.safeParse({ ok: true, data: { ...data, privateSecret: 'no' } })
        .success,
    ).toBe(false);
    expect(
      BusinessPageClientResponseSchema.parse({
        ok: true,
        data: {
          ...data,
          future: true,
          draft: { ...content, future: true, sections: [{ ...content.sections[0], future: true }] },
        },
        future: true,
      }),
    ).toEqual({ ok: true, data });
  });
});
