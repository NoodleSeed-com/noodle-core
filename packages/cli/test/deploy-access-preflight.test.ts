// `--access customers` requires `server.auth`. The service enforces this at deploy time
// (packages/service/src/registry.ts, code `server_auth_required`); this preflight surfaces the same
// error author-side before any network call, so authors never discover it as an opaque HTTP 400
// (docs/roadmap/embedded-assistant-hardening.md S4).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { deploy } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const withoutAuth = join(here, 'fixtures', 'embedded-assistant', 'server.ts');
const withAuth = join(here, 'fixtures', 'embedded-assistant-auth', 'server.ts');

describe('deploy --access customers preflight', () => {
  it('fails locally with server_auth_required before any network call', async () => {
    const fetchSpy = vi.fn<typeof fetch>(() => {
      throw new Error('preflight must not reach the network');
    });
    const outcome = await deploy({
      manifestPath: withoutAuth,
      accessMode: 'customers',
      serviceUrl: 'http://127.0.0.1:1',
      fetchImpl: fetchSpy,
      serverVersion: '1',
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // Wording parity with the service-side rule so the two layers can never disagree.
    expect(outcome.message).toBe('customers access mode requires server.auth');
    expect(outcome.errors).toEqual([
      {
        code: 'server_auth_required',
        path: 'server.auth',
        message: 'customers access mode requires server.auth',
      },
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('lets a customerAuth-configured server proceed to the service', async () => {
    const fetchSpy = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ error: 'stub' }), { status: 503 }));
    const outcome = await deploy({
      manifestPath: withAuth,
      accessMode: 'customers',
      serviceUrl: 'http://127.0.0.1:1',
      fetchImpl: fetchSpy,
      serverVersion: '1',
    });
    expect(fetchSpy).toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(503); // reached the (stubbed) service — preflight passed
  });

  it('does not preflight other access modes', async () => {
    const fetchSpy = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ error: 'stub' }), { status: 503 }));
    const outcome = await deploy({
      manifestPath: withoutAuth,
      accessMode: 'owner-only',
      serviceUrl: 'http://127.0.0.1:1',
      fetchImpl: fetchSpy,
      serverVersion: '1',
    });
    expect(fetchSpy).toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
  });

  it('fails delegated exchange without a customer identity source before any network call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noodle-dte-preflight-'));
    const manifestPath = join(dir, 'server.ts');
    const connectorsPath = join(dir, 'connectors.yaml');
    writeFileSync(
      manifestPath,
      `
import { server, tool, z } from '@noodleseed/one';
export default server('no_identity', { title: 'No Identity', version: '1.0.0' }, [
  tool('ping', { description: 'Return readiness.', input: z.object({}), fulfil: () => ({ ok: true }) })
]);
`,
    );
    writeFileSync(
      connectorsPath,
      `
connectors:
  - id: acmehr_api
    version: 1.0.0
    http:
      baseUrl: https://app.acmehr.example/api/v1
      allowedOrigins: [https://app.acmehr.example]
      auth:
        kind: delegatedTokenExchange
        tokenUrl: https://app.acmehr.example/oauth/token
        clientId: deleg-client-id
        clientSecret: ACMEHR_DELEG_CLIENT_SECRET
    operations:
      list_time_off:
        type: read
        method: GET
        path: /time-off
        output: { type: object, properties: { days: { type: number } }, additionalProperties: false }
`,
    );
    const fetchSpy = vi.fn<typeof fetch>(() => {
      throw new Error('preflight must not reach the network');
    });
    try {
      const outcome = await deploy({
        manifestPath,
        connectorsPath,
        serviceUrl: 'http://127.0.0.1:1',
        fetchImpl: fetchSpy,
        serverVersion: '1',
      });

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.errors).toEqual([
        expect.objectContaining({
          code: 'delegated_token_exchange_identity_required',
          path: 'server.auth',
        }),
      ]);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not trust a malformed raw auth object as a customer identity source', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noodle-dte-malformed-auth-'));
    const manifestPath = join(dir, 'server.mjs');
    const connectorsPath = join(dir, 'connectors.yaml');
    writeFileSync(
      manifestPath,
      `
export default {
  async toManifest() {
    return {
      manifestVersion: '1',
      server: { name: 'malformed_auth', version: '1.0.0', title: 'Malformed Auth', auth: {} },
      tools: [{
        name: 'ping', description: 'Return readiness.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        fulfilment: { steps: [{ id: 'ready', map: { ok: true } }], output: { ok: '\${steps.ready.ok}' } }
      }]
    };
  }
};
`,
    );
    writeFileSync(
      connectorsPath,
      `
connectors:
  - id: acmehr_api
    version: 1.0.0
    http:
      baseUrl: https://app.acmehr.example/api/v1
      allowedOrigins: [https://app.acmehr.example]
      auth:
        kind: delegatedTokenExchange
        tokenUrl: https://app.acmehr.example/oauth/token
        clientId: deleg-client-id
        clientSecret: ACMEHR_DELEG_CLIENT_SECRET
    operations:
      list_time_off:
        type: read
        method: GET
        path: /time-off
        output: { type: object, properties: { days: { type: number } }, additionalProperties: false }
`,
    );
    const fetchSpy = vi.fn<typeof fetch>(() => {
      throw new Error('invalid compiled auth must not reach the network');
    });
    try {
      const outcome = await deploy({
        manifestPath,
        connectorsPath,
        serviceUrl: 'http://127.0.0.1:1',
        fetchImpl: fetchSpy,
        serverVersion: '1',
      });

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.errors).toEqual([
        expect.objectContaining({ code: 'invalid_shape', path: 'server.auth' }),
      ]);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('compresses the complete deploy request so repeated widget runtimes deduplicate on the wire', async () => {
    let request: RequestInit | undefined;
    const fetchSpy = vi.fn<typeof fetch>(async (_url, init) => {
      request = init;
      return new Response(JSON.stringify({ error: 'stub' }), { status: 503 });
    });
    await deploy({
      manifestPath: withoutAuth,
      accessMode: 'owner-only',
      serviceUrl: 'http://127.0.0.1:1',
      fetchImpl: fetchSpy,
      serverVersion: '1',
      idempotencyKey: `sha256:${'a'.repeat(64)}`,
    });

    expect(request?.headers).toMatchObject({ 'content-encoding': 'gzip' });
    expect(request?.headers).toMatchObject({
      'idempotency-key': expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    const compressed = Buffer.from(request?.body as Uint8Array);
    const body = JSON.parse(gunzipSync(compressed).toString('utf8')) as { manifest: string };
    expect(JSON.parse(body.manifest)).toMatchObject({ server: { name: 'embedded_assistant' } });
  });
});

describe('noodle deploy --access customers (command surface)', () => {
  it('prints a repairable server_auth_required envelope naming customerAuth', async () => {
    const { run } = await import('../src/index.js');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const home = mkdtempSync(join(tmpdir(), 'noodle-cli-preflight-'));
    const lines: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const code = await run(
        [
          'deploy',
          withoutAuth,
          '--access',
          'customers',
          '--service',
          'http://127.0.0.1:1',
          '--version',
          '1',
          '--no-prompt',
          '--json',
        ],
        {},
        home,
      );
      expect(code).not.toBe(0);
      const envelope = JSON.parse(lines.join('\n')) as {
        error: { code: string; fix: string };
      };
      expect(envelope.error.code).toBe('server_auth_required');
      expect(envelope.error.fix).toContain('customerAuth');
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
