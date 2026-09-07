import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { isAuthServerPath } from '../src/oauth/paths.js';
import { ServerRegistry } from '../src/registry.js';
import { createServiceHandler } from '../src/service.js';

describe('auth discovery Console handoff metadata', () => {
  let service: ReturnType<typeof createServer> | undefined;

  afterEach(async () => {
    if (service === undefined) return;
    await new Promise<void>((resolve, reject) =>
      service?.close((error) => (error === undefined ? resolve() : reject(error))),
    );
    service = undefined;
  });

  async function discover(consoleUrl?: string): Promise<Record<string, unknown>> {
    service = createServer(
      createServiceHandler(new ServerRegistry(), {
        ...(consoleUrl !== undefined ? { invitationConsoleBaseUrl: consoleUrl } : {}),
      }),
    );
    await new Promise<void>((resolve) => service?.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
    return (await fetch(`${base}/v1/auth`).then((response) => response.json())) as Record<
      string,
      unknown
    >;
  }

  it.each([
    'https://console.example.test',
    'https://console.example.test/',
    'https://console.example.test/console',
  ])('preserves an accepted configured Console base exactly: %s', async (consoleUrl) => {
    expect((await discover(consoleUrl)).consoleUrl).toBe(consoleUrl);
  });

  it.each([
    'https:console.example.test',
    'https:///console.example.test',
    'https://console.example.test/a/../b',
    'https://console.example.test/%2e/child',
    'https://console.example.test/%2E%2E/child',
    'https://console.example.test/a//b',
    'https://console.example.test/bad%',
    'https://console.example.test:443',
  ])('omits a malformed or canonicalized configured Console base: %s', async (consoleUrl) => {
    expect(await discover(consoleUrl)).not.toHaveProperty('consoleUrl');
  });

  it('keeps Console discovery backward compatible when no base is configured', async () => {
    expect(await discover()).not.toHaveProperty('consoleUrl');
  });

  it('keeps provider-neutral and compatibility discovery byte-identical with Console metadata', async () => {
    service = createServer(
      createServiceHandler(new ServerRegistry(), {
        invitationConsoleBaseUrl: 'https://console.example.test/managed/',
      }),
    );
    await new Promise<void>((resolve) => service?.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;

    const [canonical, compatibility] = await Promise.all([
      fetch(`${base}/v1/auth`),
      fetch(`${base}/v1/auth/google`),
    ]);

    expect((await canonical.json()).consoleUrl).toBe('https://console.example.test/managed/');
    expect(await compatibility.text()).toBe(await fetch(`${base}/v1/auth`).then((r) => r.text()));
  });

  it('delegates the fixed WorkOS logout bridge to the authorization-server app', () => {
    expect(isAuthServerPath('/oauth/workos/logout')).toBe(true);
    expect(isAuthServerPath('/oauth/workos/logout/attacker')).toBe(false);
  });
});
