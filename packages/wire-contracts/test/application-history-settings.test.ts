import { describe, expect, it } from 'vitest';
import {
  ApplicationHistorySettingsClientResponseSchema,
  ApplicationHistorySettingsResponseSchema,
} from '../src/application-history-settings.js';

const settings = (conversations: Record<string, unknown>) => ({
  ok: true,
  data: {
    revision: 'a'.repeat(64),
    canEdit: true,
    activity: { retentionDays: 30, maximumDays: 30, defaultDays: 30 },
    conversations: {
      state: 'on',
      retentionDays: 30,
      sources: { websiteVisitors: true, signedInCustomers: true, whatsapp: true },
      ...conversations,
    },
  },
});

describe('history settings: surfaces disabled by the application (ADR 0241 decision 11)', () => {
  it('names only authored surface kinds and is absent rather than empty', () => {
    const optedOut = settings({
      disabledByApplication: ['authenticatedWebsite', 'publicMessaging'],
    });
    expect(ApplicationHistorySettingsResponseSchema.parse(optedOut)).toEqual(optedOut);
    expect(ApplicationHistorySettingsResponseSchema.parse(settings({}))).toEqual(settings({}));
    for (const invalid of [[], ['authenticated'], ['websiteVisitors']]) {
      expect(() =>
        ApplicationHistorySettingsResponseSchema.parse(
          settings({ disabledByApplication: invalid }),
        ),
      ).toThrow();
    }
  });

  it('lets a client read the field beside additive data', () => {
    const parsed = ApplicationHistorySettingsClientResponseSchema.parse(
      settings({ disabledByApplication: ['publicWebsite'], future: true }),
    );
    expect(parsed.data.conversations.disabledByApplication).toEqual(['publicWebsite']);
  });
});
