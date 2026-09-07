import { describe, expect, it } from 'vitest';
import { dispatchConfigValueRequest } from '../src/routes/config-values-dispatch.js';

describe('managed config dispatcher', () => {
  it('leaves non-config paths for subsequent dispatchers', () => {
    expect(
      dispatchConfigValueRequest(
        undefined as never,
        undefined as never,
        new URL('http://service.test/v1/health'),
        undefined as never,
      ),
    ).toBe(false);
  });
});
