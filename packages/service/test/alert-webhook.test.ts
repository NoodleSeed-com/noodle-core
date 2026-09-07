import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AlertWebhookPayload,
  deliverAlertWebhook,
  validateAlertWebhookUrl,
} from '../src/index.js';

/**
 * Webhook delivery unit tests (analytics alerting E2): URL policy validation (https-only, loopback
 * carve-out, no embedded credentials, no private literal IPs), SSRF egress blocking via the pinned
 * DNS lookup, the single-attempt timeout, the payload wire shape, and the invariant that the
 * webhook URL never appears in any outcome the caller could log.
 */

const PAYLOAD: AlertWebhookPayload = {
  schemaVersion: 1,
  event: 'test',
  org: 'acme',
  app: 'support',
  env: 'prod',
  rule: {
    id: '11111111-2222-4333-8444-555555555555',
    name: 'error spike',
    metric: 'error_share',
    threshold: 0.2,
    windowMinutes: 15,
    comparison: '>=',
  },
  observed: 0.5,
  firedAt: '2026-07-06T00:00:00.000Z',
};

describe('validateAlertWebhookUrl', () => {
  it('accepts an https DNS-name URL without the loopback carve-out', () => {
    const result = validateAlertWebhookUrl('https://hooks.example.com/T/secret', {
      allowLoopback: false,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects plain http to a non-loopback host even with the carve-out enabled', () => {
    for (const allowLoopback of [false, true]) {
      const result = validateAlertWebhookUrl('http://evil.example.com/x', { allowLoopback });
      expect(result.ok).toBe(false);
    }
  });

  it('allows http loopback targets only under the explicit carve-out', () => {
    for (const url of ['http://127.0.0.1:9999/hook', 'http://localhost:9999/hook']) {
      expect(validateAlertWebhookUrl(url, { allowLoopback: true }).ok).toBe(true);
      expect(validateAlertWebhookUrl(url, { allowLoopback: false }).ok).toBe(false);
    }
  });

  it('rejects literal private/link-local/reserved IPs (they carry no DNS step to guard)', () => {
    for (const url of [
      'https://10.0.0.1/hook',
      'https://192.168.1.10/hook',
      'https://169.254.169.254/hook',
      'https://[::1]/hook',
    ]) {
      expect(validateAlertWebhookUrl(url, { allowLoopback: false }).ok).toBe(false);
    }
  });

  it('rejects URLs with embedded credentials and unparseable URLs', () => {
    expect(
      validateAlertWebhookUrl('https://user:pass@example.com/x', { allowLoopback: false }).ok,
    ).toBe(false);
    expect(validateAlertWebhookUrl('not a url', { allowLoopback: false }).ok).toBe(false);
  });

  it('never echoes the URL back in a policy error message', () => {
    for (const raw of [
      'http://evil.example.com/super-secret-path',
      'https://10.0.0.1/super-secret-path',
      'https://user:hunter2@example.com/x',
    ]) {
      const result = validateAlertWebhookUrl(raw, { allowLoopback: false });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).not.toContain('super-secret-path');
        expect(result.error).not.toContain('hunter2');
        expect(result.error).not.toContain('evil.example.com');
        expect(result.error).not.toContain('10.0.0.1');
      }
    }
  });
});

describe('deliverAlertWebhook', () => {
  let server: Server;
  let port: number;
  let received: { method?: string; contentType?: string; body?: string }[] = [];
  let behavior: 'ok' | 'fail' | 'hang' = 'ok';

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push({
          method: req.method ?? '',
          contentType: String(req.headers['content-type'] ?? ''),
          body: Buffer.concat(chunks).toString('utf8'),
        });
        if (behavior === 'hang') return; // never respond — the caller's timeout must fire
        res.statusCode = behavior === 'ok' ? 200 : 500;
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  });

  it('POSTs the JSON payload and reports the HTTP status', async () => {
    behavior = 'ok';
    received = [];
    const outcome = await deliverAlertWebhook(`http://127.0.0.1:${port}/hook/tok`, PAYLOAD, {
      allowLoopback: true,
    });
    expect(outcome).toEqual({ delivered: true, status: 200 });
    expect(received).toHaveLength(1);
    expect(received[0]?.method).toBe('POST');
    expect(received[0]?.contentType).toContain('application/json');
    const body = JSON.parse(received[0]?.body ?? '{}') as AlertWebhookPayload;
    expect(body).toEqual(PAYLOAD);
  });

  it('reports a non-2xx response as undelivered with the status attached', async () => {
    behavior = 'fail';
    const outcome = await deliverAlertWebhook(`http://127.0.0.1:${port}/hook/tok`, PAYLOAD, {
      allowLoopback: true,
    });
    expect(outcome).toEqual({ delivered: false, status: 500, reason: 'http_error' });
  });

  it('gives up after the single-attempt timeout', async () => {
    behavior = 'hang';
    const outcome = await deliverAlertWebhook(`http://127.0.0.1:${port}/hook/tok`, PAYLOAD, {
      allowLoopback: true,
      timeoutMs: 150,
    });
    expect(outcome.delivered).toBe(false);
    expect(outcome.reason).toBe('timeout');
    behavior = 'ok';
  });

  it('blocks DNS names that resolve only to private addresses (SSRF rebinding guard)', async () => {
    const outcome = await deliverAlertWebhook('https://internal.example.com/hook/tok', PAYLOAD, {
      allowLoopback: false,
      lookup: (_hostname, _options, callback) =>
        callback(null, [{ address: '10.0.0.7', family: 4 }]),
    });
    expect(outcome).toEqual({ delivered: false, reason: 'egress_blocked' });
    expect(JSON.stringify(outcome)).not.toContain('internal.example.com');
  });

  it('refuses a policy-violating URL without touching the network', async () => {
    const outcome = await deliverAlertWebhook('http://evil.example.com/hook', PAYLOAD, {
      allowLoopback: true,
    });
    expect(outcome).toEqual({ delivered: false, reason: 'invalid_url' });
  });

  it('rejects http loopback delivery when the carve-out is off (defense in depth for stored rules)', async () => {
    const outcome = await deliverAlertWebhook(`http://127.0.0.1:${port}/hook/tok`, PAYLOAD, {
      allowLoopback: false,
    });
    expect(outcome).toEqual({ delivered: false, reason: 'invalid_url' });
  });

  it('never includes the URL in any outcome shape', async () => {
    behavior = 'fail';
    const outcomes = [
      await deliverAlertWebhook(`http://127.0.0.1:${port}/hook/secret-path-42`, PAYLOAD, {
        allowLoopback: true,
      }),
      await deliverAlertWebhook('http://evil.example.com/secret-path-42', PAYLOAD, {
        allowLoopback: true,
      }),
    ];
    expect(JSON.stringify(outcomes)).not.toContain('secret-path-42');
    behavior = 'ok';
  });
});
