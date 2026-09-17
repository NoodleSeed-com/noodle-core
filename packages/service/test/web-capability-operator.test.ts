import { InMemoryDailyCounterStore } from '@noodle-borg/admission-limits/portable';
import {
  CapabilityService,
  InMemoryCapabilityPolicyStore,
} from '@noodle-borg/managed-capabilities';
import { describe, expect, it, vi } from 'vitest';
import { serveLocalService } from '../src/serve-local.js';

describe('capability operator HTTP path', () => {
  it('inspects, revision-configures, fixture-tests and live-tests the exact deployed declaration', async () => {
    const read = vi.fn(async ({ url }: { url: string }) => ({
      url,
      title: 'Source',
      text: 'DO_NOT_PERSIST_OR_DISPLAY_THIS_BODY',
      links: [],
      retrievedAt: new Date().toISOString(),
    }));
    const capabilities = new CapabilityService({
      profile: 'development',
      policies: new InMemoryCapabilityPolicyStore(),
      counters: new InMemoryDailyCounterStore(),
      reader: { read },
    });
    const local = await serveLocalService({ runtime: { capabilities } });
    try {
      const deployment = await local.registry.deploy(
        { org: 'local', app: 'web', env: 'dev' },
        JSON.stringify({
          manifestVersion: '2',
          server: {
            name: 'web',
            title: 'Web',
            version: '1.0.0',
            capabilities: [
              {
                name: 'pages',
                class: 'web.extract.v1',
                title: 'Read pages',
                description: 'Read public pages.',
                provider: { kind: 'noodle-managed' },
              },
            ],
          },
          tools: [],
        }),
        { accessMode: 'public' },
      );
      expect(deployment.ok).toBe(true);
      const base = local.url + '/v1/orgs/local/apps/web/envs/dev/capabilities';
      expect(await (await fetch(base)).json()).toMatchObject({
        capabilities: [{ name: 'pages', available: false, revision: 0 }],
      });
      const policy = {
        expectedRevision: 0,
        mutationId: 'first',
        policy: { enabled: true, dailyCalls: 10 },
      };
      const put = (body: unknown) =>
        fetch(base + '/pages/policy', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      expect(await (await put(policy)).json()).toMatchObject({ available: true, revision: 1 });
      expect((await put(policy)).status).toBe(200);
      expect((await put({ ...policy, mutationId: 'stale' })).status).toBe(409);
      for (const mode of ['fixture', 'live']) {
        const response = await fetch(base + '/pages/test', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode, request: { urls: ['https://example.com/'] } }),
        });
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(JSON.parse(text)).toMatchObject({ mode, status: 'complete', pages: 1 });
        expect(text).not.toContain('DO_NOT_PERSIST_OR_DISPLAY_THIS_BODY');
        expect(read).toHaveBeenCalledTimes(mode === 'fixture' ? 0 : 1);
      }
      expect((await fetch(base.replace('/dev/', '/other/'))).status).toBe(404);
      for (const era of ['2025-11-25', '2026-07-28']) {
        const response = await fetch(`${local.url}/o/local/web/dev/mcp`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': era,
            'mcp-method': 'tools/call',
            'mcp-name': 'extract_pages',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: era,
            method: 'tools/call',
            params: {
              name: 'extract_pages',
              arguments: { urls: ['https://example.com/'] },
              ...(era === '2026-07-28'
                ? {
                    _meta: {
                      'io.modelcontextprotocol/protocolVersion': era,
                      'io.modelcontextprotocol/clientInfo': {
                        name: 'capability-test',
                        version: '1.0.0',
                      },
                      'io.modelcontextprotocol/clientCapabilities': {},
                    },
                  }
                : {}),
            },
          }),
        });
        const text = await response.text();
        expect(response.status, text).toBe(200);
        expect(text).toContain('DO_NOT_PERSIST_OR_DISPLAY_THIS_BODY');
        expect(text).not.toContain('"isError":true');
      }
      expect(read).toHaveBeenCalledTimes(3);
    } finally {
      await local.close();
    }
  });
});
