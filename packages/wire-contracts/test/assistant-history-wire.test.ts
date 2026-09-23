import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assistantSessionResponseSchema } from '../src/index.js';

const valid = JSON.parse(
  readFileSync(
    new URL('../../../contract/v1/assistant-session-response.json', import.meta.url),
    'utf8',
  ),
) as Record<string, unknown>;

describe('assistant session retention notice wire contract (ADR 0241 decision 17)', () => {
  it('is an additive top-level field, absent whenever the caller is not recorded', () => {
    expect(valid.history).toEqual({ retentionDays: 30, notice: 'Los chats se guardan 30 días' });
    const { history: _history, ...unrecorded } = valid;
    expect(assistantSessionResponseSchema.safeParse(unrecorded).success).toBe(true);
  });

  it.each([0, 366, 1.5, '30'])('never states a window of %j days', (retentionDays) => {
    expect(
      assistantSessionResponseSchema.safeParse({ ...valid, history: { retentionDays } }).success,
    ).toBe(false);
  });

  it('carries an optional localized notice, bounded like the authored template', () => {
    const history = (notice: unknown) =>
      assistantSessionResponseSchema.safeParse({ ...valid, history: { retentionDays: 30, notice } })
        .success;
    expect(history('Los chats se guardan 30 días')).toBe(true);
    expect(history('')).toBe(false);
    expect(history('x'.repeat(161))).toBe(false);
    expect(history(30)).toBe(false);
  });
});
