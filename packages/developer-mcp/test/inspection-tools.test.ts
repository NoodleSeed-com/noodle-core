import { describe, expect, it, vi } from 'vitest';

import type { DeveloperMcpContext } from '../src/contracts.js';
import type { DeveloperControlPlane } from '../src/port.js';
import { getContext, inspectApp, inspectDeployment, listApps } from '../src/tools/index.js';

const ctx: DeveloperMcpContext = {
  subject: 'subject-1',
  clientId: 'client-1',
  grantId: 'grant-1',
  resource: 'https://cloud.noodleseed.com/developer/mcp',
  capabilities: ['cloud:read'],
};

const observedAt = () => '2026-07-17T12:00:00.000Z';

function fakePort(overrides: Partial<DeveloperControlPlane> = {}): DeveloperControlPlane {
  const unexpected = async (): Promise<never> => {
    throw new Error('unexpected port call');
  };
  return {
    getContext: unexpected,
    listApps: unexpected,
    inspectApp: unexpected,
    inspectDeployment: unexpected,
    getLogs: unexpected,
    getMetrics: unexpected,
    listEvents: unexpected,
    getSession: unexpected,
    ...overrides,
  };
}

describe('Developer MCP inspection tools', () => {
  it('gets current organizations and roles from the Cloud port', async () => {
    const read = vi.fn(async () => ({
      accessModel: 'live_user' as const,
      capabilities: ['cloud:read' as const],
      organizations: [
        { org: 'acme', role: 'developer' as const, capabilities: ['cloud:read' as const] },
      ],
    }));
    const result = await getContext({
      ctx,
      controlPlane: fakePort({ getContext: read }),
      observedAt,
    });

    expect(read).toHaveBeenCalledWith(ctx);
    expect(result).toMatchObject({
      structuredContent: {
        ok: true,
        data: {
          accessModel: 'live_user',
          organizations: [{ org: 'acme', role: 'developer' }],
          capabilities: ['cloud:read'],
        },
        meta: {
          capabilityVersion: '2',
          observedAt: '2026-07-17T12:00:00.000Z',
          nextActions: expect.any(Array),
        },
      },
      content: [{ type: 'text' }],
    });
  });

  it('passes parsed list defaults and grant context to the port', async () => {
    const list = vi.fn(async () => ({ apps: [] }));
    const result = await listApps(
      { ctx, controlPlane: fakePort({ listApps: list }), observedAt },
      { org: 'acme' },
    );

    expect(list).toHaveBeenCalledWith(ctx, { org: 'acme', limit: 50 });
    expect(result.structuredContent).toMatchObject({ ok: true, data: { apps: [] } });
  });

  it('passes explicit organization and environment targets to the live-authorizing port', async () => {
    const inspect = vi.fn(async () => ({
      app: 'demo',
      environments: ['prod'],
      selectedEnvironment: 'prod',
      active: false,
      createdAt: '2026-07-17T00:00:00.000Z',
    }));
    const result = await inspectApp(
      { ctx, controlPlane: fakePort({ inspectApp: inspect }), observedAt },
      { org: 'acme', app: 'demo', env: 'prod' },
    );

    expect(inspect).toHaveBeenCalledWith(ctx, { org: 'acme', app: 'demo', env: 'prod' });
    expect(result.structuredContent).toMatchObject({
      ok: true,
      meta: { org: 'acme', env: 'prod' },
    });
  });

  it('requires an organization target', async () => {
    const list = vi.fn();
    const result = await listApps(
      { ctx, controlPlane: fakePort({ listApps: list }), observedAt },
      {},
    );

    expect(list).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: 'validation_failed' },
    });
  });

  it('inspects deployments through the typed port and returns ordered next actions', async () => {
    const inspect = vi.fn(async () => ({
      target: { app: 'demo', env: 'dev' },
      deployment: {
        deploymentId: 'dep-1',
        endpointUrl: 'https://acme.example/demo/env/dev/mcp',
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
        compatibility: { mcpApps: 'pass', chatgpt: 'pass', claude: 'pass' },
      },
      findings: [],
    }));
    const result = await inspectDeployment(
      { ctx, controlPlane: fakePort({ inspectDeployment: inspect }), observedAt },
      { org: 'acme', deploymentId: 'dep-1' },
    );

    expect(inspect).toHaveBeenCalledWith(ctx, { org: 'acme', deploymentId: 'dep-1' });
    expect(result.structuredContent).toMatchObject({
      ok: true,
      meta: {
        org: 'acme',
        env: 'dev',
        nextActions: [
          { kind: 'call_tool', tool: 'get_logs' },
          { kind: 'call_tool', tool: 'get_metrics' },
          { kind: 'run_cli' },
        ],
      },
    });
  });

  it('does not change structured data when presentation metadata is attached later', async () => {
    const base = await getContext({
      ctx,
      observedAt,
      controlPlane: fakePort({
        getContext: async () => ({
          accessModel: 'live_user',
          capabilities: ['cloud:read'],
          organizations: [],
        }),
      }),
    });
    const enhanced = { ...base, _meta: { ui: { resourceUri: 'ui://noodle/context' } } };
    expect(enhanced.structuredContent).toEqual(base.structuredContent);
  });
});
