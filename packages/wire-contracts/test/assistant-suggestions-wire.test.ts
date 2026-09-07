import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assistantSessionResponseSchema } from '../src/index.js';

const valid = JSON.parse(
  readFileSync(
    new URL('../../../contract/v1/assistant-session-response.json', import.meta.url),
    'utf8',
  ),
) as Record<string, unknown>;

describe('assistant suggestions wire contract', () => {
  it('keeps the endpoint additive and requires an absolute URL when present', () => {
    const endpoints = valid.endpoints as Record<string, unknown>;
    expect(typeof endpoints.suggestions).toBe('string');
    const { suggestions: _suggestions, ...legacyEndpoints } = endpoints;
    expect(
      assistantSessionResponseSchema.safeParse({ ...valid, endpoints: legacyEndpoints }).success,
    ).toBe(true);
    expect(
      assistantSessionResponseSchema.safeParse({
        ...valid,
        endpoints: { ...endpoints, suggestions: '/v1/assistant/suggestions' },
      }).success,
    ).toBe(false);
  });
});
