import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryChannelStore } from '@noodle-borg/assistant-gateway/portable';
import { ChannelWorkerLoop, createServiceHandler, ServerRegistry } from '@noodle-borg/service';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runChannels } from '../src/commands/whatsapp-ops.js';

const manifest = `manifestVersion: "2"
server:
  name: cli_channel
  version: 1.0.0
  title: CLI Channel
  assistant:
    model: { kind: noodle-managed }
    allowedOrigins: []
    surfaces:
      - { kind: messaging, channel: whatsapp, mode: public, capabilities: [{kind: tool, name: identity}] }
tools:
  - name: identity
    description: Identify this business.
    inputSchema: { type: object, properties: {}, additionalProperties: false }
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    fulfilment: { steps: [], output: { name: Business } }
`;
describe('WhatsApp CLI against the real operator HTTP routes', () => {
  const home = mkdtempSync(join(tmpdir(), 'whatsapp-cli-'));
  const worker = new ChannelWorkerLoop();
  let http: Server, base: string;
  beforeAll(async () => {
    const registry = new ServerRegistry();
    const deployed = await registry.deploy({ org: 'acme', app: 'site', env: 'prod' }, manifest, {
      accessMode: 'public',
    });
    expect(deployed.ok).toBe(true);
    http = createServer(
      createServiceHandler(registry, {
        publicBaseUrl: 'https://service.example',
        deployGate: {
          authorize: async () => ({
            ok: true,
            identity: { subject: 'operator', email: '', superAdmin: true },
          }),
        },
        whatsapp: { store: new InMemoryChannelStore(), worker },
      }),
    );
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await worker.stop();
    if (http) await new Promise<void>((resolve) => http.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  });
  it('configures paused, operates limits and blocks, erases context, and fails unavailable readiness', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const command = (args: string[]) =>
      runChannels(
        [
          'whatsapp',
          ...args,
          '--service',
          base,
          '--auth-token',
          'test-only',
          '--org',
          'acme',
          '--app',
          'site',
          '--env',
          'prod',
          '--json',
        ],
        {},
        home,
      );
    try {
      expect(await command(['status'])).toBe(0);
      expect(
        await command([
          'configure',
          '--phone-number-id',
          'owned',
          '--api-key-secret',
          'WHATSAPP_API_KEY',
          '--webhook-secret',
          'WHATSAPP_WEBHOOK_SECRET',
          '--capabilities',
          'tool:identity',
          '--support-email',
          'hello@noodleseed.com',
          '--expected-revision',
          '0',
        ]),
      ).toBe(0);
      expect(
        await command(['limits', 'set', '--per-minute', '2', '--expected-revision', '1']),
      ).toBe(0);
      expect(await command(['usage'])).toBe(0);
      const id = `p_${'a'.repeat(64)}`;
      expect(await command(['block', '--participant-id', id, '--indefinite'])).toBe(0);
      expect(await command(['blocks', 'list'])).toBe(0);
      expect(JSON.stringify(log.mock.calls.at(-1))).toContain(id);
      expect(await command(['unblock', '--participant-id', id])).toBe(0);
      expect(await command(['cooldown', 'clear', '--participant-id', id])).toBe(0);
      expect(await command(['conversation', 'forget', '--participant-id', id])).toBe(0);
      expect(await command(['events', 'list'])).toBe(0);
      expect(await command(['doctor'])).toBe(2);
      expect(JSON.stringify(log.mock.calls.at(-1))).toContain('durable_storage_required');
      expect(await command(['enable', '--expected-revision', '2'])).toBe(1);
      expect(await command(['disconnect', '--expected-revision', '2'])).toBe(0);
      expect(JSON.stringify(log.mock.calls)).not.toContain('test-only');
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});
