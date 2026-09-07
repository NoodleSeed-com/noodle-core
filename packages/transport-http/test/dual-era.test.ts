import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OperationSignature, RuntimeArtifact } from '@noodle-borg/compiler';
import { SERVED_MCP_PROTOCOL_VERSIONS, type ServedArtifact } from '@noodle-borg/protocol';
import {
  InMemoryConnector,
  InMemoryConnectorRegistry,
  StaticServiceBroker,
} from '@noodle-borg/runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpHttpHandler, type HttpHandlerOptions } from '../src/index.js';

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
const signature: OperationSignature = {
  type: 'read',
  input: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  output: {
    type: 'object',
    properties: { order: { type: 'object' } },
    additionalProperties: false,
  },
};

function target(): ServedArtifact {
  const connector = new InMemoryConnector('acme_orders', '1.2.0', {
    get_order: {
      signature,
      handler: (args) => ({ order: { id: args.id, status: 'open' } }),
    },
  });
  return {
    artifact: JSON.parse(readFileSync(artifactPath, 'utf8')) as RuntimeArtifact,
    deps: {
      connectors: new InMemoryConnectorRegistry([connector]),
      broker: new StaticServiceBroker({ token: 'svc' }),
    },
  };
}

const servers: Server[] = [];

async function start(
  protocolMode: 'dual' | 'legacy-only' = 'dual',
  oauthClientCredentialsReady = false,
  options: Pick<HttpHandlerOptions, 'resolveInvocationContext'> = {},
): Promise<string> {
  const server = createServer(
    createMcpHttpHandler(target(), { protocolMode, oauthClientCredentialsReady, ...options }),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/mcp`;
}

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

function modernBody(method: string, params: Record<string, unknown> = {}, id = 1) {
  const requestMeta =
    typeof params._meta === 'object' && params._meta !== null && !Array.isArray(params._meta)
      ? (params._meta as Record<string, unknown>)
      : {};
  const { _meta: _ignored, ...bodyParams } = params;
  return {
    jsonrpc: '2.0',
    id,
    method,
    params: {
      ...bodyParams,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': {},
        'io.modelcontextprotocol/clientInfo': { name: 'transport-test', version: '1' },
        ...requestMeta,
      },
    },
  };
}

async function modernPost(
  url: string,
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Promise<Response> {
  const targetName =
    method === 'tools/call' || method === 'prompts/get'
      ? params.name
      : method === 'resources/read'
        ? params.uri
        : undefined;
  return fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': method,
      ...(typeof targetName === 'string' ? { 'mcp-name': targetName } : {}),
      ...headers,
    },
    body: JSON.stringify(modernBody(method, params)),
  });
}

describe('raw Node hosted dual-era lane', () => {
  it('normalizes the same bounded client location hint before both era adapters', async () => {
    const seen: unknown[] = [];
    const url = await start('dual', false, {
      resolveInvocationContext: async (input) => {
        seen.push(input.clientHint);
        return undefined;
      },
    });
    const location = {
      latitude: 43.6532,
      longitude: -79.3832,
      city: ' Toronto ',
      region: 'Ontario',
      country: 'CA',
      timezone: 'America/Toronto',
      ignored: { nested: 'value' },
    };

    const legacy = await fetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-11-25',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'get_order',
          arguments: { order_id: 'legacy' },
          _meta: { 'openai/userLocation': location },
        },
      }),
    });
    expect(legacy.status).toBe(200);

    const modern = await modernPost(url, 'tools/call', {
      name: 'get_order',
      arguments: { order_id: 'modern' },
      _meta: { 'openai/userLocation': location },
    });
    expect(modern.status).toBe(200);

    expect(seen).toEqual([
      {
        location: {
          latitude: 43.6532,
          longitude: -79.3832,
          city: 'Toronto',
          region: 'Ontario',
          country: 'CA',
          timeZone: 'America/Toronto',
        },
      },
      {
        location: {
          latitude: 43.6532,
          longitude: -79.3832,
          city: 'Toronto',
          region: 'Ontario',
          country: 'CA',
          timeZone: 'America/Toronto',
        },
      },
    ]);
  });

  it('serves byte-compatible legacy initialize and modern discovery/calls from one endpoint', async () => {
    const url = await start();
    const legacy = await fetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-11-25',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'legacy-test', version: '1' },
        },
      }),
    });
    const legacyText = await legacy.text();
    expect(legacy.status).toBe(200);
    expect(legacy.headers.get('content-type')).toBe('application/json');
    expect(legacyText).not.toContain('resultType');
    expect(JSON.parse(legacyText)).toMatchObject({
      result: { protocolVersion: '2025-11-25' },
    });

    const discovered = await modernPost(url, 'server/discover');
    expect(await discovered.json()).toMatchObject({
      result: {
        supportedVersions: [...SERVED_MCP_PROTOCOL_VERSIONS],
        resultType: 'complete',
      },
    });

    const called = await modernPost(url, 'tools/call', {
      name: 'get_order',
      arguments: { order_id: 'A-1' },
    });
    expect(await called.json()).toMatchObject({
      result: {
        resultType: 'complete',
        structuredContent: { order: { id: 'A-1', status: 'open' } },
      },
    });
  });

  it('distinguishes method errors from unknown paths and validates mirrored headers', async () => {
    const url = await start();
    const mismatch = await modernPost(url, 'tools/list', {}, { 'mcp-method': 'prompts/list' });
    expect(mismatch.status).toBe(400);
    await expect(mismatch.json()).resolves.toMatchObject({ error: { code: -32020 } });

    const unknownMethod = await modernPost(url, 'noodle/unknown');
    expect(unknownMethod.status).toBe(404);
    await expect(unknownMethod.json()).resolves.toMatchObject({ error: { code: -32601 } });

    const unknownPath = await fetch(new URL('/not-mcp', url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(unknownPath.status).toBe(404);
    await expect(unknownPath.json()).resolves.toMatchObject({ error: { code: -32600 } });
  });

  it.each(['GET', 'DELETE'])('keeps %s session operations disabled', async (method) => {
    const url = await start();
    const response = await fetch(url, { method });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });

  it('ignores session/resume headers and rejects origin before era dispatch', async () => {
    const url = await start();
    const response = await modernPost(
      url,
      'tools/list',
      {},
      {
        'mcp-session-id': 'attacker-session',
        'last-event-id': 'resume-me',
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('mcp-session-id')).toBeNull();

    const denied = await modernPost(url, 'tools/list', {}, { origin: 'https://denied.example' });
    expect(denied.status).toBe(200);

    const restrictedServer = createServer(
      createMcpHttpHandler(target(), {
        protocolMode: 'dual',
        allowedOrigins: ['https://allowed.example'],
      }),
    );
    servers.push(restrictedServer);
    await new Promise<void>((resolve) => restrictedServer.listen(0, '127.0.0.1', resolve));
    const { port } = restrictedServer.address() as AddressInfo;
    const restrictedUrl = `http://127.0.0.1:${port}/mcp`;
    const rejected = await modernPost(
      restrictedUrl,
      'tools/list',
      {},
      {
        origin: 'https://denied.example',
      },
    );
    expect(rejected.status).toBe(403);
    await expect(rejected.json()).resolves.toMatchObject({ error: { code: -32600 } });
  });

  it('can revert the entire origin to the legacy-only lane', async () => {
    const url = await start('legacy-only');
    const modern = await modernPost(url, 'server/discover');
    expect(modern.status).toBe(400);
    await expect(modern.json()).resolves.toMatchObject({ error: { code: -32000 } });
  });

  it('threads one origin-wide OAuth client credentials readiness fact into discovery', async () => {
    const unavailableUrl = await start('dual', false);
    const unavailable = await (await modernPost(unavailableUrl, 'server/discover')).json();
    expect(unavailable.result.capabilities.extensions ?? {}).not.toHaveProperty(
      'io.modelcontextprotocol/oauth-client-credentials',
    );

    const readyUrl = await start('dual', true);
    const ready = await (await modernPost(readyUrl, 'server/discover')).json();
    expect(ready.result.capabilities.extensions).toMatchObject({
      'io.modelcontextprotocol/oauth-client-credentials': {},
    });
  });
});
