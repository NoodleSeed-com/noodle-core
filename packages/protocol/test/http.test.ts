import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  handleStatelessHttp,
  type ProtocolRequestContext,
  type ServedArtifact,
} from '../src/index.js';
import { goldenTarget } from './golden-target.js';
import { servedArtifact } from './harness.js';

/**
 * The stateless Streamable-HTTP path: {@link handleStatelessHttp} builds a fresh SDK server + transport
 * per request. This proves version negotiation and that a tool call works on a server that never saw an
 * initialize on its (per-request) connection — the property that makes the stateless deployment valid.
 */
async function withHttp<T>(
  fn: (url: string) => Promise<T>,
  options: {
    failing?: boolean;
    context?: ProtocolRequestContext;
    target?: ServedArtifact;
  } = {},
): Promise<T> {
  const http = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      void handleStatelessHttp(
        options.target ?? servedArtifact(options),
        req,
        res,
        JSON.parse(body),
        options.context,
      );
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}/mcp`);
  } finally {
    await new Promise<void>((resolve, reject) => http.close((e) => (e ? reject(e) : resolve())));
  }
}

const HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
} as const;

async function rpc(url: string, body: unknown, extra: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...HEADERS, ...extra },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

const init = (protocolVersion: string) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion, capabilities: {}, clientInfo: { name: 't', version: '1' } },
});

describe('stateless Streamable HTTP', () => {
  it('answers initialize with the negotiated version, tools capability, and server info', async () => {
    await withHttp(async (url) => {
      const { status, json } = await rpc(url, init('2025-11-25'));
      expect(status).toBe(200);
      expect(json.result.protocolVersion).toBe('2025-11-25');
      expect(json.result.capabilities.tools).toBeDefined();
      expect(json.result.serverInfo).toMatchObject({ name: 'acme_support', version: '1.0.0' });
    });
  });

  it('keeps the temporary v1 rollback seam on the legacy negotiated version', async () => {
    await withHttp(async (url) => {
      const { json } = await rpc(url, init('2026-07-28'));
      expect(json.result.protocolVersion).toBe('2025-11-25');
    });
  });

  it('answers tools/call on a fresh stateless server (no prior initialize on this connection)', async () => {
    await withHttp(async (url) => {
      const { status, json } = await rpc(
        url,
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'get_order', arguments: { order_id: 'Z9' } },
        },
        { 'mcp-protocol-version': '2025-11-25' },
      );
      expect(status).toBe(200);
      expect(json.result.structuredContent).toEqual({ order: { id: 'Z9', status: 'open' } });
    });
  });

  it('applies widget-domain projection on the temporary v1 rollback seam', async () => {
    const base = goldenTarget();
    const target: ServedArtifact = {
      ...base,
      artifact: {
        ...base.artifact,
        resources: base.artifact.resources?.map((resource) => ({
          ...resource,
          _meta: {
            ...resource._meta,
            ui: {
              ...(resource._meta?.ui as Record<string, unknown>),
              domain: 'https://widgets.example.com',
            },
          },
        })),
      },
    };
    await withHttp(
      async (url) => {
        const { json } = await rpc(
          url,
          {
            jsonrpc: '2.0',
            id: 4,
            method: 'resources/read',
            params: { uri: 'ui://golden_server/ticket_card' },
          },
          { 'mcp-protocol-version': '2025-11-25' },
        );
        expect(json.result.contents[0]._meta).toMatchObject({
          ui: { domain: expect.stringMatching(/^[a-f0-9]{32}\.claudemcpcontent\.com$/) },
          'openai/widgetDomain': 'https://widgets.example.com',
        });
      },
      {
        target,
        context: {
          widgetDomain: { host: 'claude', mcpServerUrl: 'https://mcp.test/endpoint' },
        },
      },
    );
  });

  it('rejects a malformed tools/call (missing name) with a JSON-RPC error', async () => {
    await withHttp(async (url) => {
      const { json } = await rpc(
        url,
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: {} },
        { 'mcp-protocol-version': '2025-11-25' },
      );
      expect(json.error).toBeDefined();
      expect(json.error.code).toBeLessThan(0);
    });
  });
});
