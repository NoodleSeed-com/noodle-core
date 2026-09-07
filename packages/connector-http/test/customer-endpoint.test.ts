import type { CustomerEndpointRef } from '@noodle-borg/compiler';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpConnector } from '../src/index.js';

const routedBase: CustomerEndpointRef = {
  kind: 'customerEndpoint',
  name: 'customer_api',
  policy: {
    allowedHttpsHostSuffixes: ['noodleseed.dev'],
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('HttpConnector customer endpoint construction seam', () => {
  it('constructs without a sentinel URL and fails before auth, DNS, or fetch', async () => {
    const lookup = vi.fn();
    const authHeader = vi.fn(() => ({ authorization: 'Bearer must-not-be-used' }));
    const fetch = vi.spyOn(globalThis, 'fetch');
    const connector = new HttpConnector({
      id: 'customer_records',
      version: '1.0.0',
      baseUrl: routedBase,
      lookup,
      authHeader,
      operations: {
        list_records: {
          path: '/records',
          signature: {
            type: 'read',
            input: { type: 'object', properties: {}, additionalProperties: false },
            output: { type: 'object', properties: {}, additionalProperties: false },
          },
        },
      },
    });

    await expect(
      connector.invoke({
        operation: 'list_records',
        args: {},
        credential: { kind: 'token', token: 'must-not-be-used' },
      }),
    ).rejects.toThrow('connector route unavailable');

    expect(authHeader).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
