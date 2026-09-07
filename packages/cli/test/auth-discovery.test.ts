import { describe, expect, it } from 'vitest';
import { getAuthMetadata } from '../src/auth-discovery.js';

const BASE_METADATA = {
  ok: true,
  service: 'https://svc.example.test',
  authType: 'open-dev',
};

describe('Console URL discovery', () => {
  it.each([
    'https://console.example.test',
    'https://console.example.test/',
    'https://console.example.test/console',
  ])('preserves an accepted HTTPS Console base exactly: %s', async (consoleUrl) => {
    const metadata = await getAuthMetadata('https://svc.example.test', async () =>
      Response.json({ ...BASE_METADATA, consoleUrl }),
    );

    expect(metadata.consoleUrl).toBe(consoleUrl);
  });

  it.each([
    'http://console.example.test',
    'https://user:password@console.example.test',
    'https://console.example.test/#fragment',
    '/relative-console',
    'https:console.example.test',
    'https:///console.example.test',
    'https://console.example.test/a/../b',
    'https://console.example.test/%2e/child',
    'https://console.example.test/%2E%2E/child',
    'https://console.example.test/a//b',
    'https://console.example.test/bad%',
    'https://console.example.test:443',
  ])('rejects an unsafe Console URL: %s', async (consoleUrl) => {
    await expect(
      getAuthMetadata('https://svc.example.test', async () =>
        Response.json({ ...BASE_METADATA, consoleUrl }),
      ),
    ).rejects.toThrow('service auth metadata is invalid');
  });

  it('remains compatible with discovery responses that omit Console metadata', async () => {
    await expect(
      getAuthMetadata('https://svc.example.test', async () => Response.json(BASE_METADATA)),
    ).resolves.toEqual(BASE_METADATA);
  });
});
