import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RuntimeArtifact } from '@noodle-borg/compiler';
import type { ServedArtifact } from '@noodle-borg/protocol';
import { InMemoryConnectorRegistry, StaticServiceBroker } from '@noodle-borg/runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpHttpHandler, createMcpRouter, type HttpHandlerOptions } from '../src/index.js';
import { widgetDomainProjectionForRequest } from '../src/widget-host.js';

const here = dirname(fileURLToPath(import.meta.url));
const artifactPath = join(
  here,
  '..',
  '..',
  'compiler',
  'fixtures',
  'valid',
  'minimal.resolved.artifact.json',
);
const WIDGET_URI = 'ui://acme_support/ticket_card';
const CONFIGURED_DOMAIN = 'https://widgets.example.com';

function target(): ServedArtifact {
  const base = JSON.parse(readFileSync(artifactPath, 'utf8')) as RuntimeArtifact;
  return {
    artifact: {
      ...base,
      resources: [
        {
          name: 'ticket_card',
          uri: WIDGET_URI,
          isTemplate: false,
          mimeType: 'text/html;profile=mcp-app',
          fulfilment: {
            kind: 'flow',
            steps: [],
            output: { value: { kind: 'literal', value: '<main>Ticket</main>' } },
          },
          _meta: { ui: { domain: CONFIGURED_DOMAIN, prefersBorder: true } },
        },
      ],
      capabilities: { ...base.capabilities, resources: ['ticket_card'] },
    },
    deps: {
      connectors: new InMemoryConnectorRegistry([]),
      broker: new StaticServiceBroker({ token: 'svc' }),
    },
  };
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error === undefined ? resolve() : reject(error))),
          ),
      ),
  );
});

async function start(options: HttpHandlerOptions = {}): Promise<string> {
  const server = createServer(createMcpHttpHandler(target(), options));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/mcp`;
}

function modernBody(clientName: string): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'resources/read',
    params: {
      uri: WIDGET_URI,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': {},
        'io.modelcontextprotocol/clientInfo': { name: clientName, version: '1' },
      },
    },
  };
}

async function readWidget(
  url: string,
  options: {
    clientName?: string;
    userAgent?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; meta?: Record<string, unknown> }> {
  const modern = options.clientName !== undefined;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': modern ? '2026-07-28' : '2025-11-25',
      ...(modern ? { 'mcp-method': 'resources/read', 'mcp-name': WIDGET_URI } : {}),
      ...(options.userAgent === undefined ? {} : { 'user-agent': options.userAgent }),
      ...options.headers,
    },
    body: JSON.stringify(
      modern
        ? modernBody(options.clientName as string)
        : {
            jsonrpc: '2.0',
            id: 1,
            method: 'resources/read',
            params: { uri: WIDGET_URI },
          },
    ),
  });
  const json = (await response.json()) as {
    result?: { contents?: Array<{ _meta?: Record<string, unknown> }> };
  };
  return { status: response.status, meta: json.result?.contents?.[0]?._meta };
}

function expectedClaudeDomain(url: string): string {
  return `${createHash('sha256').update(url).digest('hex').slice(0, 32)}.claudemcpcontent.com`;
}

function uiDomain(meta: Record<string, unknown> | undefined): unknown {
  return (meta?.ui as Record<string, unknown> | undefined)?.domain;
}

const requestWithUserAgent = (userAgent?: string): IncomingMessage =>
  ({ headers: userAgent === undefined ? {} : { 'user-agent': userAgent } }) as IncomingMessage;

describe('widget host classification', () => {
  it.each([
    ['Claude', true],
    ['claude-ai', true],
    ['Anthropic MCP', true],
    ['ChatGPT', false],
    ['notclaude', false],
  ])('classifies client name %s', (name, isClaude) => {
    const projection = widgetDomainProjectionForRequest(
      requestWithUserAgent(),
      modernBody(name),
      'https://mcp.example.com/mcp',
    );
    expect(projection?.host === 'claude').toBe(isClaude);
  });

  it('uses the first request in a JSON-RPC batch', () => {
    expect(
      widgetDomainProjectionForRequest(
        requestWithUserAgent(),
        [modernBody('Claude'), modernBody('ChatGPT')],
        'https://mcp.example.com/mcp',
      ),
    ).toEqual({ host: 'claude', mcpServerUrl: 'https://mcp.example.com/mcp' });
  });
});

describe('host-specific widget domains at the HTTP seam', () => {
  it('hashes the direct MCP endpoint for a modern Claude request', async () => {
    const url = await start();
    const result = await readWidget(url, { clientName: 'claude-ai' });

    expect(result.status).toBe(200);
    expect(uiDomain(result.meta)).toBe(expectedClaudeDomain(url));
    expect(result.meta?.['openai/widgetDomain']).toBe(CONFIGURED_DOMAIN);
  });

  it('uses the User-Agent fallback for a stateless legacy Claude request', async () => {
    const url = await start();
    const result = await readWidget(url, { userAgent: 'Claude-Desktop/1' });

    expect(result.status).toBe(200);
    expect(uiDomain(result.meta)).toBe(expectedClaudeDomain(url));
  });

  it('preserves the configured domain and adds the ChatGPT alias for generic clients', async () => {
    const url = await start();
    const result = await readWidget(url, { clientName: 'ChatGPT' });

    expect(uiDomain(result.meta)).toBe(CONFIGURED_DOMAIN);
    expect(result.meta?.['openai/widgetDomain']).toBe(CONFIGURED_DOMAIN);
  });

  it('applies the same projection when the origin-wide gate is legacy-only', async () => {
    const url = await start({ protocolMode: 'legacy-only' });
    const result = await readWidget(url, { userAgent: 'Anthropic-MCP/1' });

    expect(result.status).toBe(200);
    expect(uiDomain(result.meta)).toBe(expectedClaudeDomain(url));
  });

  it('hashes the trusted public edge URL rather than the internal router URL', async () => {
    const publicUrl = 'https://saad-apps.cloud.noodleseed.dev/todoist/v1/mcp';
    const server = createServer(
      createMcpRouter(() => Promise.resolve(undefined), {
        publicTenantRouting: {
          allowedBaseDomains: ['cloud.noodleseed.dev'],
          edgeToken: 'edge-secret',
          resolveTenant: async (ref) => ({
            org: 'saad-apps-internal',
            app: ref.app,
            env: ref.env,
            ...(ref.serverVersion === undefined ? {} : { serverVersion: ref.serverVersion }),
          }),
        },
        tenantLookup: async () => ({ served: target() }),
      }),
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const result = await readWidget(`http://127.0.0.1:${port}/todoist/v1/mcp`, {
      clientName: 'Claude',
      headers: {
        'x-app-host': publicUrl,
        'x-noodle-edge-token': 'edge-secret',
      },
    });

    expect(result.status).toBe(200);
    expect(uiDomain(result.meta)).toBe(expectedClaudeDomain(publicUrl));
  });

  it('rejects a denied origin before protocol projection', async () => {
    const url = await start({ allowedOrigins: ['https://allowed.example'] });
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://denied.example',
      },
      body: JSON.stringify(modernBody('Claude')),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: -32600 } });
  });
});
