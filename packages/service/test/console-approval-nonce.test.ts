import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InMemoryAssistantStore } from '@noodle-borg/assistant-gateway';
import { bearerToken } from '@noodle-borg/control-plane/portable';
import { describe, expect, it } from 'vitest';
import { ServerRegistry } from '../src/registry.js';
import { createServiceHandler } from '../src/service.js';

describe('console approval nonce consumption', () => {
  it('atomically accepts a nonce once across callers sharing the store', async () => {
    const store = new InMemoryAssistantStore();
    const now = new Date('2026-07-12T12:00:00Z');
    const expiresAt = new Date(now.getTime() + 60_000);
    const attempts = await Promise.all([
      store.consumeConsoleApprovalNonce('nonce-1', 'user-1', expiresAt, now),
      store.consumeConsoleApprovalNonce('nonce-1', 'user-1', expiresAt, now),
    ]);
    expect(attempts.sort()).toEqual([false, true]);
  });

  it('rejects an already-expired nonce', async () => {
    const store = new InMemoryAssistantStore();
    expect(
      await store.consumeConsoleApprovalNonce(
        'nonce-expired',
        'user-1',
        new Date('2026-07-12T11:59:59Z'),
        new Date('2026-07-12T12:00:00Z'),
      ),
    ).toBe(false);
  });

  it('requires identity and atomically consumes through the internal service route', async () => {
    const store = new InMemoryAssistantStore();
    const server = createServer(
      createServiceHandler(new ServerRegistry(), {
        assistantStore: store,
        clock: () => new Date('2026-07-12T12:00:00Z'),
        deployGate: {
          authorize: (req) =>
            bearerToken(req) === 'console-token'
              ? {
                  ok: true,
                  identity: {
                    subject: 'user-1',
                    email: 'user@example.com',
                    superAdmin: false,
                  },
                }
              : { ok: false, status: 401, message: 'unauthorized' },
        },
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${port}/v1/console/approval-nonces/consume`;
      const body = JSON.stringify({
        nonce: 'abcdefghijklmnop',
        expiresAt: '2026-07-12T12:05:00.000Z',
      });
      expect((await fetch(url, { method: 'POST', body })).status).toBe(401);
      const init = {
        method: 'POST',
        headers: { authorization: 'Bearer console-token', 'content-type': 'application/json' },
        body,
      };
      expect((await fetch(url, init)).status).toBe(201);
      expect((await fetch(url, init)).status).toBe(409);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
