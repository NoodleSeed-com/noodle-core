import { describe, expect, it } from 'vitest';
import { ApplicationConnectionCallbackRequestSchema } from '../src/application-connections.js';

const callback = { code: 'opaque-code', state: 's'.repeat(43), sessionBinding: 'b'.repeat(43) };
describe('provider callback issuer wire', () => {
  it('preserves optional issuer for the authoritative OAuth validator', () => {
    expect(ApplicationConnectionCallbackRequestSchema.parse(callback)).toEqual(callback);
    expect(
      ApplicationConnectionCallbackRequestSchema.parse({
        ...callback,
        iss: 'https://accounts.google.com',
      }).iss,
    ).toBe('https://accounts.google.com');
  });
  it.each([
    '',
    'x'.repeat(2049),
    ['https://one.test', 'https://two.test'],
  ])('rejects invalid issuer input %s', (iss) => {
    expect(ApplicationConnectionCallbackRequestSchema.safeParse({ ...callback, iss }).success).toBe(
      false,
    );
  });
});
