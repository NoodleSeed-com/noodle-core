import { Client, InMemoryTransport, type Transport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';

import type { DeveloperMcpContext } from '../src/contracts.js';
import type { DeveloperControlPlane } from '../src/port.js';
import { createDeveloperMcpServer } from '../src/server.js';
import { TOOL_WIDGET_LINKS } from '../src/widget-links.js';
import { DEVELOPER_WIDGETS } from '../src/widgets/resources.js';

const context: DeveloperMcpContext = {
  subject: 'subject-1',
  clientId: 'client-1',
  grantId: 'grant-1',
  resource: 'https://cloud.noodleseed.com/developer/mcp',
  capabilities: ['cloud:read', 'deployments:rollback'],
};

const deployment = {
  target: { app: 'demo', env: 'dev' },
  deployment: {
    deploymentId: 'dep-current',
    endpointUrl: 'https://cloud.example/o/acme/demo/dev/mcp',
    active: true,
    serverName: 'Demo',
    createdAt: '2026-07-17T00:00:00.000Z',
    accessMode: 'org-members',
  },
  health: { state: 'ready', missingSecrets: [] },
  surface: {
    tools: [],
    resources: [],
    prompts: [],
    widgets: [],
    compatibility: { mcpApps: 'pass' as const, chatgpt: 'pass' as const, claude: 'pass' as const },
  },
  findings: [],
};

const metrics = {
  window: { since: '2026-07-16T12:00:00.000Z' },
  truncated: false,
  metrics: {
    totals: {
      requests: 0,
      sessions: 0,
      legacyInitializations: 0,
      toolCalls: 0,
      discovery: 0,
    },
    errors: { ok: 0, toolErrors: 0, mcpErrors: 0, toolErrorRate: 0, mcpErrorRate: 0, errorRate: 0 },
    latency: { avgMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 },
    tokens: { total: 0, avgPerCall: 0 },
    byTool: [],
    byClient: [],
    byClientFamily: [],
    clientActivity: { callers: [], legacyHandshakes: { total: 0, byReportedClient: [] } },
    byMethod: [],
    series: [],
  },
};

function port(): DeveloperControlPlane {
  return {
    getContext: async () => ({
      accessModel: 'live_user',
      capabilities: ['cloud:read', 'deployments:rollback'],
      organizations: [
        {
          org: 'acme',
          role: 'owner',
          capabilities: ['cloud:read', 'deployments:rollback'],
        },
      ],
    }),
    listApps: async () => ({ apps: [] }),
    inspectApp: async () => ({
      app: 'demo',
      environments: ['dev'],
      selectedEnvironment: 'dev',
      active: true,
      createdAt: '2026-07-17T00:00:00.000Z',
      latest: {
        deploymentId: 'dep-current',
        environment: 'dev',
        active: true,
        serverName: 'Demo',
        createdAt: '2026-07-17T00:00:00.000Z',
        accessMode: 'org-members',
      },
    }),
    inspectDeployment: async () => deployment,
    getLogs: async () => ({ events: [] }),
    getMetrics: async () => metrics,
    listEvents: async () => ({ events: [] }),
    getSession: async () => ({ sessionId: 'session-1', events: [] }),
    rollbackDeployment: async () => ({
      target: { app: 'demo', env: 'dev' },
      rollback: {
        deploymentId: 'dep-previous',
        previousDeploymentId: 'dep-current',
        alreadyActive: false,
        endpointUrl: 'https://cloud.example/o/acme/demo/dev/mcp',
        accessMode: 'org-members',
        serverName: 'Demo',
        createdAt: '2026-07-16T00:00:00.000Z',
      },
    }),
  };
}

const clients: Client[] = [];
const servers: ReturnType<typeof createDeveloperMcpServer>[] = [];

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
});

async function connect(widgets: boolean): Promise<Client> {
  const server = createDeveloperMcpServer({
    context,
    controlPlane: port(),
    enableWidgets: widgets,
    observedAt: () => '2026-07-17T12:00:00.000Z',
  });
  const client = new Client(
    { name: 'widget-link-test', version: '1.0.0' },
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

describe('Developer MCP widget links', () => {
  it('maps the exact six tool projections to four stable resources', () => {
    expect(TOOL_WIDGET_LINKS).toEqual({
      inspect_app: 'ui://noodle-developer/app-overview/v1',
      inspect_deployment: 'ui://noodle-developer/deployment-detail/v1',
      get_logs: 'ui://noodle-developer/operations/v1',
      diagnose_app: 'ui://noodle-developer/operations/v1',
      get_metrics: 'ui://noodle-developer/analytics/v1',
      rollback_deployment: 'ui://noodle-developer/deployment-detail/v1',
    });
  });

  it('keeps every operational widget network-closed', () => {
    for (const widget of DEVELOPER_WIDGETS) {
      expect(widget._meta.ui.csp).toEqual({ connectDomains: [], resourceDomains: [] });
      expect(JSON.stringify(widget._meta)).not.toMatch(/https?:|openExternal|allow-same-origin/i);
    }
  });

  it('adds standard and ChatGPT-compatible metadata without changing any tool schema', async () => {
    const withWidgets = await connect(true);
    const headless = await connect(false);
    const projected = await withWidgets.listTools();
    const plain = await headless.listTools();

    expect(projected.tools.map(withoutMeta)).toEqual(plain.tools.map(withoutMeta));
    for (const [toolName, uri] of Object.entries(TOOL_WIDGET_LINKS)) {
      const tool = projected.tools.find((candidate) => candidate.name === toolName);
      expect(tool?._meta).toEqual({
        ui: { resourceUri: uri },
        'openai/outputTemplate': uri,
      });
      expect(plain.tools.find((candidate) => candidate.name === toolName)?._meta).toBeUndefined();
    }
  });

  it('keeps every linked tool result byte-for-byte equivalent in headless mode', async () => {
    const withWidgets = await connect(true);
    const headless = await connect(false);
    const calls = [
      ['inspect_app', { org: 'acme', app: 'demo', env: 'dev' }],
      ['inspect_deployment', { org: 'acme', deploymentId: 'dep-current' }],
      ['get_logs', { org: 'acme', app: 'demo', env: 'dev' }],
      ['get_metrics', { org: 'acme', app: 'demo', env: 'dev', window: '24h' }],
      ['diagnose_app', { org: 'acme', app: 'demo', env: 'dev' }],
      [
        'rollback_deployment',
        { org: 'acme', app: 'demo', env: 'dev', deploymentId: 'dep-previous' },
      ],
    ] as const;

    for (const [name, args] of calls) {
      const projected = await withWidgets.callTool({ name, arguments: args });
      const plain = await headless.callTool({ name, arguments: args });
      expect(projected.structuredContent, name).toEqual(plain.structuredContent);
      expect(projected.content, name).toEqual(plain.content);
      expect(projected.isError, name).toBe(plain.isError);
    }
  });

  it('lists and reads all widget resources while preserving a headless-only resource catalog', async () => {
    const withWidgets = await connect(true);
    const headless = await connect(false);
    const projected = await withWidgets.listResources();
    const plain = await headless.listResources();

    expect(projected.resources.map((resource) => resource.uri)).toEqual(
      expect.arrayContaining(DEVELOPER_WIDGETS.map((widget) => widget.uri)),
    );
    expect(plain.resources).toHaveLength(5);
    for (const widget of DEVELOPER_WIDGETS) {
      const descriptor = projected.resources.find((resource) => resource.uri === widget.uri);
      expect(descriptor).toMatchObject({
        mimeType: 'text/html;profile=mcp-app',
        _meta: widget._meta,
      });
      const read = await withWidgets.readResource({ uri: widget.uri });
      expect(read.contents).toHaveLength(1);
      expect(read.contents[0]).toMatchObject({
        uri: widget.uri,
        mimeType: 'text/html;profile=mcp-app',
        _meta: widget._meta,
      });
      expect(read.contents[0]).toHaveProperty(
        'text',
        expect.stringContaining('globalThis.ExtApps'),
      );
    }
  });
});

function withoutMeta<T extends { readonly _meta?: unknown }>(value: T): Omit<T, '_meta'> {
  const { _meta: ignored, ...plain } = value;
  void ignored;
  return plain;
}
