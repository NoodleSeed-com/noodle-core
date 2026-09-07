import { describe, expect, it } from 'vitest';
import {
  BusinessNoticeSchema,
  OrganizationAgreementAcceptRequestSchema,
  OrganizationAgreementClientResponseSchema,
  OrganizationAgreementResponseSchema,
} from '../src/solution-onboarding.js';

describe('solution onboarding wire authority', () => {
  it('accepts an exact version and digest without accepting browser authority fields', () => {
    const value = { version: 'beta-2026-09', documentDigest: 'a'.repeat(64), accepted: true };
    expect(OrganizationAgreementAcceptRequestSchema.safeParse(value).success).toBe(true);
    for (const extra of [
      { acceptedAt: '2026-09-07' },
      { actorSubject: 'someone' },
      { org: 'other' },
      { documents: {} },
    ]) {
      expect(
        OrganizationAgreementAcceptRequestSchema.safeParse({ ...value, ...extra }).success,
      ).toBe(false);
    }
    expect(
      OrganizationAgreementAcceptRequestSchema.safeParse({ ...value, accepted: false }).success,
    ).toBe(false);
  });
  it('permits bounded business display fields and safe contact links only', () => {
    const value = {
      displayName: 'Example Travel',
      privacyUrl: 'https://example.com/privacy',
      supportUrl: 'mailto:support@example.com',
    };
    expect(BusinessNoticeSchema.safeParse(value).success).toBe(true);
    for (const supportUrl of [
      'javascript:alert(1)',
      'mailto:support@example.com?bcc=hidden@example.com',
      'https://user:pass@example.com',
      'http://example.com',
      'mailto:support@example.com\r\nX:injected',
    ]) {
      expect(BusinessNoticeSchema.safeParse({ ...value, supportUrl }).success).toBe(false);
    }
    expect(
      BusinessNoticeSchema.safeParse({ ...value, privacyUrl: 'mailto:privacy@example.com' })
        .success,
    ).toBe(false);
    expect(BusinessNoticeSchema.safeParse({ ...value, displayName: 'a'.repeat(121) }).success).toBe(
      false,
    );
    expect(
      BusinessNoticeSchema.safeParse({ ...value, settings: { privateKey: 'hidden' } }).success,
    ).toBe(false);
  });
  it('keeps server outputs strict and client response readers additive at every object layer', () => {
    const value = { ok: true, data: { canAccept: false, accepted: false, required: null } };
    expect(OrganizationAgreementResponseSchema.safeParse(value).success).toBe(true);
    const additive = { ...value, future: true, data: { ...value.data, future: true } };
    expect(OrganizationAgreementResponseSchema.safeParse(additive).success).toBe(false);
    expect(OrganizationAgreementClientResponseSchema.parse(additive)).toEqual(value);
  });
});
