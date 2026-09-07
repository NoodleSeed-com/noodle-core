import { Client, InMemoryTransport, type Transport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';

import type { DeveloperMcpContext } from '../src/contracts.js';
import { type DeveloperControlPlane, DeveloperControlPlaneError } from '../src/port.js';
import { createDeveloperMcpServer } from '../src/server.js';

const ctx: DeveloperMcpContext = {
  subject: 'subject-1',
  clientId: 'client-1',
  grantId: 'grant-1',
  resource: 'https://cloud.noodleseed.com/developer/mcp',
  capabilities: ['cloud:read'],
};

function fakePort(overrides: Partial<DeveloperControlPlane> = {}): DeveloperControlPlane {
  const unexpected = async (): Promise<never> => {
    throw new Error('unexpected port call');
  };
  return {
    getContext: async () => ({
      accessModel: 'live_user',
      capabilities: ['cloud:read'],
      organizations: [
        { org: 'acme', displayName: 'Acme', role: 'developer', capabilities: ['cloud:read'] },
      ],
    }),
    listApps: async () => ({ apps: [] }),
    inspectApp: unexpected,
    inspectDeployment: unexpected,
    getLogs: unexpected,
    getMetrics: unexpected,
    listEvents: unexpected,
    getSession: unexpected,
    rollbackDeployment: unexpected,
    ...overrides,
  };
}

const clients: Client[] = [];
const servers: ReturnType<typeof createDeveloperMcpServer>[] = [];

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
});

async function connect(controlPlane: DeveloperControlPlane = fakePort()) {
  const server = createDeveloperMcpServer({
    context: ctx,
    controlPlane,
    observedAt: () => '2026-07-17T12:00:00.000Z',
  });
  const client = new Client(
    { name: 'developer-mcp-test', version: '1.0.0' },
    { capabilities: {}, versionNegotiation: { mode: 'legacy' } },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport as Transport),
    client.connect(clientTransport as Transport),
  ]);
  clients.push(client);
  servers.push(server);
  return client;
}

describe('Noodle Developer MCP server', () => {
  it('publishes the exact V2 tool catalog, explicit-org schemas, and impact annotations', async () => {
    const client = await connect();
    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name)).toEqual([
      'get_context',
      'list_apps',
      'inspect_app',
      'inspect_deployment',
      'get_logs',
      'get_metrics',
      'list_events',
      'get_session',
      'diagnose_app',
      'rollback_deployment',
    ]);
    const readTools = tools.tools.filter((tool) => tool.name !== 'rollback_deployment');
    for (const tool of tools.tools) {
      expect(tool.outputSchema, `${tool.name} outputSchema`).toMatchObject({ type: 'object' });
      expect(tool.annotations, `${tool.name} annotations`).toMatchObject({
        readOnlyHint: expect.any(Boolean),
        destructiveHint: expect.any(Boolean),
        idempotentHint: expect.any(Boolean),
        openWorldHint: expect.any(Boolean),
      });
    }
    expect(readTools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(readTools.every((tool) => tool.annotations?.destructiveHint === false)).toBe(true);
    expect(readTools.every((tool) => tool.annotations?.openWorldHint === false)).toBe(true);
    expect(tools.tools.find((tool) => tool.name === 'inspect_app')?.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['org', 'app'],
    });
    expect(tools.tools.find((tool) => tool.name === 'rollback_deployment')).toMatchObject({
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['org', 'app', 'env', 'deploymentId'],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    });
    expect(tools.tools.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining(['deploy', 'upload_source', 'edit_source']),
    );
  });

  it('publishes the versioned resources and prompts', async () => {
    const client = await connect();
    await expect(client.listResources()).resolves.toMatchObject({ resources: expect.any(Array) });
    expect((await client.listResources()).resources.map((resource) => resource.uri)).toEqual([
      'noodle://developer/capabilities/v2',
      'noodle://developer/workflow/v2',
      'noodle://developer/hosts/chatgpt/v1',
      'noodle://developer/hosts/codex/v1',
      'noodle://developer/hosts/claude-code/v1',
      'ui://noodle-developer/app-overview/v1',
      'ui://noodle-developer/deployment-detail/v1',
      'ui://noodle-developer/operations/v1',
      'ui://noodle-developer/analytics/v1',
    ]);
    expect((await client.listPrompts()).prompts.map((prompt) => prompt.name)).toEqual([
      'build_mcp_app',
      'inspect_mcp_app',
      'debug_mcp_app',
    ]);
  });

  it('executes tools with complete structured content', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'get_context', arguments: {} });
    expect(result).toMatchObject({
      structuredContent: {
        ok: true,
        data: {
          accessModel: 'live_user',
          organizations: [{ org: 'acme', role: 'developer' }],
        },
        meta: { capabilityVersion: '2', nextActions: expect.any(Array) },
      },
      content: [{ type: 'text' }],
    });
  });

  it('returns safe structured error envelopes from Cloud failures', async () => {
    const client = await connect(
      fakePort({
        listApps: async () => {
          throw new DeveloperControlPlaneError(
            'dependency_unavailable',
            'App inventory is unavailable.',
          );
        },
      }),
    );
    const result = await client.callTool({ name: 'list_apps', arguments: { org: 'acme' } });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        error: { code: 'dependency_unavailable', retryable: true },
        meta: { capabilityVersion: '2', org: 'acme' },
      },
    });
  });

  it('reads guidance and assembles prompts without model sampling', async () => {
    const client = await connect();
    const resource = await client.readResource({ uri: 'noodle://developer/workflow/v2' });
    expect(resource.contents[0]).toMatchObject({ mimeType: 'text/markdown' });
    expect(resource.contents[0]).toHaveProperty('text', expect.stringContaining('coding agent'));
    const prompt = await client.getPrompt({ name: 'debug_mcp_app', arguments: {} });
    expect(prompt.messages[0]?.content).toMatchObject({ type: 'text' });
  });
});
