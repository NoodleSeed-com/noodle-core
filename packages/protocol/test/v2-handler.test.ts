import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProtocolObservation, ProtocolRequestContext } from '../src/index.js';
import { SERVED_MCP_PROTOCOL_VERSIONS } from '../src/v2/versions.js';
import { goldenTarget } from './golden-target.js';
import {
  connectV2Client,
  createTestDualEraHandler,
  legacyRpc,
  modernRequestBody,
  modernRpc,
  testServedArtifact,
} from './v2-harness.js';

const handlers: Array<ReturnType<typeof createTestDualEraHandler>> = [];

function handler(
  target: Parameters<typeof createTestDualEraHandler>[0] = testServedArtifact(),
  context: ProtocolRequestContext = {},
): ReturnType<typeof createTestDualEraHandler> {
  const value = createTestDualEraHandler(target, context);
  handlers.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(handlers.splice(0).map((item) => item.close()));
});

describe('MCP 2026-07-28 dual-era handler', () => {
  it('owns the exact newest-first served-version set', () => {
    expect(SERVED_MCP_PROTOCOL_VERSIONS).toEqual([
      '2026-07-28',
      '2025-11-25',
      '2025-06-18',
      '2025-03-26',
      '2024-11-05',
      '2024-10-07',
    ]);
  });

  it('supports legacy, automatic, and pinned-modern v2 clients', async () => {
    const legacy = await connectV2Client(handler(), 'legacy');
    expect(legacy.client.getProtocolEra()).toBe('legacy');
    expect(legacy.client.getNegotiatedProtocolVersion()).toBe('2025-11-25');
    await legacy.close();

    const automatic = await connectV2Client(handler(), 'automatic');
    expect(automatic.client.getProtocolEra()).toBe('modern');
    expect(automatic.client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    await automatic.close();

    const pinned = await connectV2Client(handler(), 'pinned-modern');
    expect(pinned.client.getProtocolEra()).toBe('modern');
    expect(pinned.client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    await pinned.close();
  });

  it('discovers the platform versions, conditional capabilities, identity, instructions, and Apps', async () => {
    const target = testServedArtifact((artifact) => ({
      ...artifact,
      server: { ...artifact.server, instructions: 'Use this app carefully.' },
      resources: [
        {
          name: 'card',
          uri: 'ui://test/card',
          isTemplate: false,
          mimeType: 'text/html;profile=mcp-app',
          fulfilment: { kind: 'value', value: '<main>Card</main>' },
          _meta: { ui: { prefersBorder: true } },
        },
      ],
      prompts: [
        {
          name: 'review',
          description: 'Review an order.',
          arguments: [],
          fulfilment: { kind: 'value', value: 'Review it.' },
        },
      ],
    }));
    const response = await modernRpc(
      handler(target, { oauthClientCredentialsReady: true }),
      'server/discover',
    );

    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({
      result: {
        supportedVersions: [...SERVED_MCP_PROTOCOL_VERSIONS],
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
          extensions: {
            'io.modelcontextprotocol/ui': {
              mimeTypes: ['text/html;profile=mcp-app'],
            },
            'io.modelcontextprotocol/oauth-client-credentials': {},
          },
        },
        instructions: 'Use this app carefully.',
        resultType: 'complete',
        ttlMs: 0,
        cacheScope: 'private',
        _meta: {
          'io.modelcontextprotocol/serverInfo': {
            name: target.artifact.server.name,
            title: target.artifact.server.title,
            version: target.artifact.server.version,
          },
        },
      },
    });
  });

  it('advertises OAuth client credentials only for a ready modern origin', async () => {
    const unavailable = await modernRpc(handler(), 'server/discover');
    expect(unavailable.json).not.toMatchObject({
      result: {
        capabilities: {
          extensions: {
            'io.modelcontextprotocol/oauth-client-credentials': {},
          },
        },
      },
    });

    const ready = await modernRpc(
      handler(testServedArtifact(), { oauthClientCredentialsReady: true }),
      'server/discover',
    );
    expect(ready.json).toMatchObject({
      result: {
        capabilities: {
          extensions: {
            'io.modelcontextprotocol/oauth-client-credentials': {},
          },
        },
      },
    });

    const legacy = await legacyRpc(
      handler(testServedArtifact(), { oauthClientCredentialsReady: true }),
      'initialize',
      {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'legacy-test', version: '1' },
      },
    );
    expect(legacy.json).not.toMatchObject({
      result: {
        capabilities: {
          extensions: {
            'io.modelcontextprotocol/oauth-client-credentials': {},
          },
        },
      },
    });
  });

  it('derives unsupported-version errors from the same served-version constant', async () => {
    const response = await modernRpc(handler(), 'tools/list', {}, { version: '2099-01-01' });

    expect(response.status).toBe(400);
    expect(response.json).toMatchObject({
      error: {
        code: -32022,
        data: {
          supported: [...SERVED_MCP_PROTOCOL_VERSIONS],
          requested: '2099-01-01',
        },
      },
    });
  });

  it('enforces required metadata and body-mirroring headers', async () => {
    const target = handler();
    const missingMetaBody = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {
        _meta: {
          [CLIENT_INFO_META_KEY]: { name: 'test', version: '1' },
        },
      },
    };
    const missingMeta = await target.fetch(
      new Request('https://mcp.test/endpoint', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': 'tools/list',
        },
        body: JSON.stringify(missingMetaBody),
      }),
    );
    const missingMetaJson = await missingMeta.json();
    expect(missingMeta.status).toBe(400);
    expect(missingMetaJson).toMatchObject({ error: { code: -32602 } });

    const mismatched = await modernRpc(target, 'tools/list', {}, { methodHeader: 'prompts/list' });
    expect(mismatched.status).toBe(400);
    expect(mismatched.json).toMatchObject({ error: { code: -32020 } });

    const missingName = await modernRpc(
      target,
      'tools/call',
      { name: 'get_order', arguments: { id: '1' } },
      { nameHeader: null },
    );
    expect(missingName.status).toBe(400);
    expect(missingName.json).toMatchObject({ error: { code: -32020 } });

    const listWithoutName = await modernRpc(target, 'tools/list', {}, { nameHeader: null });
    expect(listWithoutName.status).toBe(200);
  });

  it('observes an SDK-owned modern header rejection without header or payload values', async () => {
    const observations: ProtocolObservation[] = [];
    const target = handler(testServedArtifact(), {
      observe: (observation) => observations.push(observation),
    });

    const response = await modernRpc(
      target,
      'tools/call',
      { name: 'get_order', arguments: { order_id: 'private-order-id' } },
      { nameHeader: null },
    );

    expect(response.status).toBe(400);
    expect(observations).toEqual([
      {
        method: 'tools/call',
        toolName: 'get_order',
        outcome: 'mcp_error',
        errorKind: 'modern_header_mismatch',
      },
    ]);
    expect(JSON.stringify(observations)).not.toContain('private-order-id');
  });

  it('observes SDK-owned capability and version rejections distinctly', async () => {
    const observations: ProtocolObservation[] = [];
    const target = handler(goldenTarget(), {
      observe: (observation) => observations.push(observation),
    });

    const missingCapability = await modernRpc(target, 'tools/call', {
      name: 'choose_team',
      arguments: {},
    });
    const unsupportedVersion = await modernRpc(target, 'tools/list', {}, { version: '2099-01-01' });

    expect(missingCapability.status).toBe(400);
    expect(unsupportedVersion.status).toBe(400);
    expect(observations).toEqual([
      {
        method: 'tools/call',
        toolName: 'choose_team',
        outcome: 'mcp_error',
        errorKind: 'missing_required_client_capability',
      },
      {
        method: 'tools/list',
        outcome: 'mcp_error',
        errorKind: 'unsupported_protocol_version',
      },
    ]);
  });

  it('does not overwrite the handler-owned invalid-argument observation', async () => {
    const observations: ProtocolObservation[] = [];
    const target = handler(testServedArtifact(), {
      observe: (observation) => observations.push(observation),
    });

    const response = await modernRpc(target, 'tools/call', {
      name: 'get_order',
      arguments: { wrong: 'field' },
    });

    expect(response.json).toMatchObject({ error: { code: -32602 } });
    expect(observations).toEqual([
      {
        method: 'tools/call',
        toolName: 'get_order',
        outcome: 'mcp_error',
        errorKind: 'invalid_params',
      },
    ]);
  });

  it('does not duplicate the handler-owned legacy invalid-argument observation', async () => {
    const observations: ProtocolObservation[] = [];
    const target = handler(testServedArtifact(), {
      observe: (observation) => observations.push(observation),
    });

    const response = await legacyRpc(target, 'tools/call', {
      name: 'get_order',
      arguments: { wrong: 'field' },
    });

    expect(response.json).toMatchObject({ error: { code: -32602 } });
    expect(observations).toEqual([
      {
        method: 'tools/call',
        toolName: 'get_order',
        outcome: 'mcp_error',
        errorKind: 'invalid_params',
      },
    ]);
  });

  it('records only resolved resource names for SDK-owned rejections', async () => {
    const observations: ProtocolObservation[] = [];
    const target = handler(
      testServedArtifact((artifact) => ({
        ...artifact,
        resources: [
          {
            name: 'account_record',
            uri: 'customer://account/123?token=private-token',
            isTemplate: false,
            fulfilment: { kind: 'value', value: 'known' },
          },
        ],
      })),
      { observe: (observation) => observations.push(observation) },
    );

    const known = await modernRpc(
      target,
      'resources/read',
      { uri: 'customer://account/123?token=private-token' },
      { id: 20, nameHeader: null },
    );
    const unknown = await modernRpc(
      target,
      'resources/read',
      { uri: 'customer://account/456?token=other-private-token' },
      { id: 21, nameHeader: null },
    );

    expect(known.status).toBe(400);
    expect(unknown.status).toBe(400);
    expect(observations).toEqual([
      {
        method: 'resources/read',
        resourceName: 'account_record',
        outcome: 'mcp_error',
        errorKind: 'modern_header_mismatch',
      },
      {
        method: 'resources/read',
        outcome: 'mcp_error',
        errorKind: 'modern_header_mismatch',
      },
    ]);
    expect(JSON.stringify(observations)).not.toContain('private-token');
  });

  it('keeps response-observation precedence isolated across concurrent requests', async () => {
    const observations: ProtocolObservation[] = [];
    const target = handler(testServedArtifact(), {
      observe: (observation) => observations.push(observation),
    });

    const [headerRejected, argumentsRejected] = await Promise.all([
      modernRpc(
        target,
        'tools/call',
        { name: 'get_order', arguments: { order_id: 'one' } },
        { id: 10, nameHeader: null },
      ),
      modernRpc(
        target,
        'tools/call',
        { name: 'get_order', arguments: { wrong: 'two' } },
        { id: 11 },
      ),
    ]);

    expect(headerRejected.status).toBe(400);
    expect(argumentsRejected.json).toMatchObject({ error: { code: -32602 } });
    expect(observations).toHaveLength(2);
    expect(observations.map((observation) => observation.errorKind).sort()).toEqual([
      'invalid_params',
      'modern_header_mismatch',
    ]);
  });

  it('rejects modern-enveloped initialize and uses modern method/error semantics', async () => {
    const target = handler(
      testServedArtifact((artifact) => ({
        ...artifact,
        resources: [
          {
            name: 'known',
            uri: 'known://resource',
            isTemplate: false,
            fulfilment: { kind: 'value', value: 'known' },
          },
        ],
      })),
    );
    const modernInitialize = await modernRpc(target, 'initialize', {
      protocolVersion: '2026-07-28',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    expect(modernInitialize.status).toBe(400);
    expect(modernInitialize.json).toMatchObject({
      error: {
        code: -32022,
        data: { supported: [...SERVED_MCP_PROTOCOL_VERSIONS] },
      },
    });

    const unknown = await modernRpc(target, 'noodle/unknown');
    expect(unknown.status).toBe(404);
    expect(unknown.json).toMatchObject({ error: { code: -32601 } });

    const missingResource = await modernRpc(
      target,
      'resources/read',
      { uri: 'missing://resource' },
      { nameHeader: 'missing://resource' },
    );
    expect(missingResource.status).toBe(200);
    expect(missingResource.json).toMatchObject({ error: { code: -32602 } });
  });

  it('adds modern result envelopes and cache hints without changing legacy results', async () => {
    const target = handler();
    const modern = await modernRpc(target, 'tools/list');
    expect(modern.json).toMatchObject({
      result: {
        resultType: 'complete',
        ttlMs: 0,
        cacheScope: 'private',
      },
    });

    const legacy = await legacyRpc(target, 'tools/list', {});
    expect(legacy.status).toBe(200);
    expect(legacy.json).toHaveProperty('result.tools');
    expect(legacy.text).not.toContain('resultType');
    expect(legacy.text).not.toContain('ttlMs');
    expect(legacy.text).not.toContain('cacheScope');
  });

  it('projects, strips, and observes intent on the modern tools path', async () => {
    const observations: ProtocolObservation[] = [];
    const target = handler(testServedArtifact(), {
      intentCapture: { enabled: true },
      observe: (observation) => observations.push(observation),
    });
    const listed = await modernRpc(target, 'tools/list');
    expect(listed.text).toContain('__noodleIntent');

    const called = await modernRpc(target, 'tools/call', {
      name: 'get_order',
      arguments: {
        order_id: 'A1',
        __noodleIntent: {
          category: 'support',
          match: 'direct',
          goal: 'Check the current status of an order',
        },
      },
    });
    expect(called.status).toBe(200);
    expect(called.json).toMatchObject({ result: { structuredContent: { order: { id: 'A1' } } } });
    expect(observations).toContainEqual(
      expect.objectContaining({
        method: 'tools/call',
        toolName: 'get_order',
        outcome: 'ok',
        intent: {
          category: 'support',
          match: 'direct',
          goal: 'Check the current status of an order',
        },
      }),
    );
  });

  it('keeps authored tool order, strips only the legacy retry field, and preserves Apps metadata', async () => {
    const listed = await modernRpc(handler(goldenTarget()), 'tools/list');
    const result = listed.json.result as { tools?: Array<Record<string, unknown>> };
    expect(result.tools?.map((tool) => tool.name)).toEqual(['open_ticket', 'choose_team']);
    expect(result.tools?.[0]).toMatchObject({
      _meta: { ui: { resourceUri: 'ui://golden_server/ticket_card' } },
    });
    expect(JSON.stringify(result.tools?.[1])).not.toContain('__noodleInteraction');

    const resource = await modernRpc(
      handler(goldenTarget()),
      'resources/read',
      { uri: 'ui://golden_server/ticket_card' },
      { nameHeader: 'ui://golden_server/ticket_card' },
    );
    expect(resource.json).toMatchObject({
      result: {
        contents: [
          {
            mimeType: 'text/html;profile=mcp-app',
            _meta: {
              ui: {
                csp: { connectDomains: ['https://api.example.com'] },
                permissions: { clipboardWrite: {} },
              },
            },
          },
        ],
      },
    });
  });

  it('projects widget domains identically through legacy and modern resource reads', async () => {
    const base = goldenTarget();
    const target = {
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
    const targetHandler = handler(target, {
      widgetDomain: { host: 'claude', mcpServerUrl: 'https://mcp.test/endpoint' },
    });
    const params = { uri: 'ui://golden_server/ticket_card' };
    const legacy = await legacyRpc(targetHandler, 'resources/read', params);
    const modern = await modernRpc(targetHandler, 'resources/read', params);

    for (const response of [legacy, modern]) {
      expect(response.json).toMatchObject({
        result: {
          contents: [
            {
              _meta: {
                ui: {
                  domain: expect.stringMatching(/^[a-f0-9]{32}\.claudemcpcontent\.com$/),
                },
                'openai/widgetDomain': 'https://widgets.example.com',
              },
            },
          ],
        },
      });
    }
    expect(modern.json).toHaveProperty('result.resultType', 'complete');
    expect(legacy.json).not.toHaveProperty('result.resultType');
  });

  it('treats the body as authoritative after decoding a Base64 sentinel', async () => {
    const target = handler();
    const accepted = await modernRpc(
      target,
      'tools/call',
      { name: '日本語', arguments: {} },
      { nameHeader: '=?base64?5pel5pys6Kqe?=' },
    );
    expect(accepted.status).toBe(200);
    expect(accepted.json).toMatchObject({ error: { code: -32602 } });

    const rejected = await modernRpc(
      target,
      'tools/call',
      { name: '日本語', arguments: {} },
      { nameHeader: '=?base64?d3Jvbmc=?=' },
    );
    expect(rejected.status).toBe(400);
    expect(rejected.json).toMatchObject({ error: { code: -32020 } });
  });

  it('does not accept a header-only modern claim without the required body envelope', async () => {
    const target = handler();
    const response = await target.fetch(
      new Request('https://mcp.test/endpoint', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': 'tools/list',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {
            _meta: {
              [PROTOCOL_VERSION_META_KEY]: undefined,
              [CLIENT_CAPABILITIES_META_KEY]: {},
            },
          },
        }),
      }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: -32602 } });
  });

  it('keeps the modern request helper aligned with SDK-reserved metadata keys', () => {
    expect(modernRequestBody('tools/list')).toMatchObject({
      params: {
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
          [CLIENT_CAPABILITIES_META_KEY]: {},
        },
      },
    });
  });
});
