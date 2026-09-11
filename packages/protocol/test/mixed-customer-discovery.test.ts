import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildMcpServer,
  filterAuthorizedTools,
  mapToolsList,
  type ProtocolRequestContext,
  type ServedArtifact,
  TOOL_AUTHORIZATION_DENIED,
} from '../src/index.js';
import { createDualEraMcpHandler } from '../src/v2/handler.js';
import { servedArtifact } from './harness.js';
import { legacyRpc, modernRpc } from './v2-harness.js';

const handlers: Array<ReturnType<typeof createDualEraMcpHandler>> = [];
afterEach(async () => {
  await Promise.all(handlers.splice(0).map((handler) => handler.close()));
});

function target(): ServedArtifact {
  const served = servedArtifact();
  const base = served.artifact.tools[0];
  if (base === undefined) throw new Error('fixture tool missing');
  return {
    ...served,
    artifact: {
      ...served.artifact,
      tools: [
        { ...base, name: 'help' },
        {
          ...base,
          name: 'fieldiq',
          authorization: {
            requiredScopes: ['fieldiq.read', 'fieldiq.details'],
            allowedRoles: ['technician', 'supervisor'],
            discovery: 'public' as const,
          },
          _meta: { securitySchemes: [{ type: 'noauth' }], ui: { visibility: ['app', 'model'] } },
        },
        {
          ...base,
          name: 'roles_only',
          authorization: { allowedRoles: ['supervisor'], discovery: 'public' as const },
        },
        { ...base, name: 'hidden', authorization: { requiredScopes: ['internal.read'] } },
      ],
    },
  };
}

describe.each(['legacy', 'modern'] as const)('mixed customer discovery on the %s wire', (era) => {
  const rpc = era === 'legacy' ? legacyRpc : modernRpc;
  function handler(caller?: ProtocolRequestContext['caller']) {
    const result = createDualEraMcpHandler(target(), {
      toolAuthentication: 'mixed-customer',
      ...(caller === undefined ? {} : { caller }),
    });
    handlers.push(result);
    return result;
  }

  it('advertises opt-in protected tools anonymously with derived OAuth schemes', async () => {
    const response = await rpc(handler(), 'tools/list', {});
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({
      result: {
        tools: [
          {
            name: 'help',
            securitySchemes: [{ type: 'noauth' }],
            _meta: { securitySchemes: [{ type: 'noauth' }] },
          },
          {
            name: 'fieldiq',
            securitySchemes: [{ type: 'oauth2', scopes: ['fieldiq.read', 'fieldiq.details'] }],
            _meta: {
              securitySchemes: [{ type: 'oauth2', scopes: ['fieldiq.read', 'fieldiq.details'] }],
              ui: { visibility: ['app', 'model'] },
            },
          },
          { name: 'roles_only', securitySchemes: [{ type: 'oauth2', scopes: [] }] },
        ],
      },
    });
    expect(response.text).not.toContain('technician');
    expect(response.text).not.toContain('supervisor');
    expect(response.text).not.toContain('internal.read');
    if (era === 'modern')
      expect(response.json).toMatchObject({ result: { cacheScope: 'private', ttlMs: 0 } });
  });

  it('derives noauth for generated tools without changing policy-absent descriptors', async () => {
    const served = target();
    const generated: ServedArtifact = {
      ...served,
      artifact: {
        ...served.artifact,
        server: {
          ...served.artifact.server,
          context: { defaults: { locale: 'en-PK', timeZone: 'Asia/Karachi' } },
          knowledge: [
            {
              name: 'help',
              title: 'Help',
              description: 'Public help.',
              documents: [],
              sites: [],
              generatedTool: {
                name: 'search_help',
                description: 'Search help.',
                inputSchema: { type: 'object' },
                outputSchema: { type: 'object' },
              },
            },
          ],
        },
      },
      deps: {
        ...served.deps,
        knowledgeSearch: {
          enabled: async () => true,
          search: async () => ({ ok: true, hits: [] }),
        },
      },
    };
    const mixed = createDualEraMcpHandler(generated, { toolAuthentication: 'mixed-customer' });
    const unchanged = createDualEraMcpHandler(generated);
    handlers.push(mixed, unchanged);
    const result = await rpc(mixed, 'tools/list', {});
    for (const name of ['noodle_context', 'search_help']) {
      expect(result.json).toMatchObject({
        result: {
          tools: expect.arrayContaining([
            expect.objectContaining({
              name,
              securitySchemes: [{ type: 'noauth' }],
              _meta: expect.objectContaining({ securitySchemes: [{ type: 'noauth' }] }),
            }),
          ]),
        },
      });
    }
    const original = await rpc(unchanged, 'tools/list', {});
    const listed = original.json.result as {
      tools: Array<{ name: string; securitySchemes?: unknown; _meta?: Record<string, unknown> }>;
    };
    for (const tool of listed.tools.filter((tool) =>
      ['noodle_context', 'search_help'].includes(tool.name),
    )) {
      expect(tool).not.toHaveProperty('securitySchemes');
      expect(tool).not.toHaveProperty('_meta.securitySchemes');
    }
  });

  it('retains descriptor opt-in for a wrong-role caller but denies execution before argument validation', async () => {
    const runtime = handler({ subject: 'customer-a', roles: ['viewer'], scopes: [] });
    expect((await rpc(runtime, 'tools/list', {})).json).toMatchObject({
      result: { tools: [{ name: 'help' }, { name: 'fieldiq' }, { name: 'roles_only' }] },
    });
    const denied = await rpc(runtime, 'tools/call', { name: 'fieldiq', arguments: {} });
    expect(denied.json).toMatchObject({
      error: { code: TOOL_AUTHORIZATION_DENIED, data: { reason: 'role_required' } },
    });
    expect(denied.text).not.toContain('technician');
  });

  it('keeps identity-dependent discovery scoped to each request', async () => {
    const authenticated = await rpc(
      handler({ subject: 'customer-a', scopes: ['internal.read'] }),
      'tools/list',
      {},
    );
    expect(authenticated.text).toContain('hidden');
    const anonymous = await rpc(handler(), 'tools/list', {});
    expect(anonymous.text).not.toContain('hidden');
    expect(anonymous.text).not.toContain('customer-a');
    const denied = await rpc(handler(), 'tools/call', { name: 'fieldiq', arguments: {} });
    expect(denied.json).toMatchObject({ error: { data: { reason: 'authentication_required' } } });
  });
});

it('keeps execution filters strict and existing descriptor bytes free of new metadata', () => {
  expect(
    filterAuthorizedTools(target().artifact.tools, undefined).map((tool) => tool.name),
  ).toEqual(['help']);
  const old = mapToolsList(servedArtifact().artifact);
  expect(old.tools[0]).not.toHaveProperty('securitySchemes');
  expect(old.tools[0]).not.toHaveProperty('_meta.securitySchemes');
});

it('preserves wire schemes and the old SDK client compatibility mirror', async () => {
  const server = buildMcpServer(target(), { toolAuthentication: 'mixed-customer' });
  const client = new Client({ name: 'legacy-client', version: '1' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const messages: unknown[] = [];
  const send = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (message, options) => {
    messages.push(message);
    return send(message, options);
  };
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    // The older SDK client strips unknown top-level descriptor keys, so it reads the documented mirror.
    expect(await client.listTools()).toMatchObject({
      tools: [
        { name: 'help', _meta: { securitySchemes: [{ type: 'noauth' }] } },
        {
          name: 'fieldiq',
          _meta: {
            securitySchemes: [{ type: 'oauth2', scopes: ['fieldiq.read', 'fieldiq.details'] }],
          },
        },
        { name: 'roles_only', _meta: { securitySchemes: [{ type: 'oauth2', scopes: [] }] } },
      ],
    });
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          result: expect.objectContaining({
            tools: [
              expect.objectContaining({ name: 'help', securitySchemes: [{ type: 'noauth' }] }),
              expect.objectContaining({
                name: 'fieldiq',
                securitySchemes: [{ type: 'oauth2', scopes: ['fieldiq.read', 'fieldiq.details'] }],
              }),
              expect.objectContaining({
                name: 'roles_only',
                securitySchemes: [{ type: 'oauth2', scopes: [] }],
              }),
            ],
          }),
        }),
      ]),
    );
  } finally {
    await client.close();
    await server.close();
  }
});
