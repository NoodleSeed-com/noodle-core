import type { DeveloperMcpContext } from '@noodle-borg/developer-mcp';
import type { RequestEventStore } from '@noodle-borg/module';
import { describe, expect, it, vi } from 'vitest';

import {
  type DeveloperRegistry,
  ServiceDeveloperControlPlane,
} from '../src/developer-mcp/control-plane-adapter.js';
import type { AuditSink } from '../src/store/audit.js';
import type { UserAppLogStore } from '../src/store/user-app-logs.js';
import type { ControlPlaneStore } from '../src/store.js';

const ctx: DeveloperMcpContext = {
  subject: 'subject-1',
  clientId: 'client-1',
  grantId: 'grant-1',
  resource: 'https://cloud.example/developer/mcp',
  capabilities: ['cloud:read'],
};

function registry(overrides: Partial<DeveloperRegistry> = {}): DeveloperRegistry {
  return {
    listApps: async () => ({ apps: [], truncated: false }),
    getApp: async () => undefined,
    getEnvironment: async () => undefined,
    getDeployment: async () => undefined,
    get: async () => undefined,
    getStatus: async () => undefined,
    getActiveByTenant: async () => undefined,
    listDeployments: async () => [],
    getAppArchivedAt: async () => undefined,
    rollback: async () => ({
      ok: false as const,
      status: 404 as const,
      error: 'deployment not found for target environment',
    }),
    ...overrides,
  };
}

function logs(overrides: Partial<UserAppLogStore> = {}): UserAppLogStore {
  return {
    emit: async () => undefined,
    list: async () => [],
    ...overrides,
  };
}

function requestEvents(overrides: Partial<RequestEventStore> = {}): RequestEventStore {
  return {
    emit: async () => undefined,
    list: async () => [],
    ...overrides,
  };
}

function adapter(
  options: {
    readonly registry?: DeveloperRegistry;
    readonly logs?: UserAppLogStore;
    readonly requestEvents?: RequestEventStore;
    readonly controlPlane?: Pick<
      ControlPlaneStore,
      'getActiveMcpSubdomain' | 'getOrgMember' | 'listOrgsForSubject'
    >;
    readonly audit?: AuditSink;
    readonly publicBaseDomain?: string;
  } = {},
) {
  return new ServiceDeveloperControlPlane({
    registry: options.registry ?? registry(),
    logs: options.logs ?? logs(),
    requestEvents: options.requestEvents ?? requestEvents(),
    controlPlane:
      options.controlPlane ??
      ({
        getActiveMcpSubdomain: async () => ({
          mcpSubdomain: 'acme',
          orgSlug: 'acme',
          claimedAt: '2026-07-17T00:00:00.000Z',
        }),
        getOrgMember: async ({ org, subject }) =>
          org === 'acme' && subject === ctx.subject
            ? {
                orgSlug: 'acme',
                subject: ctx.subject,
                email: 'developer@acme.example',
                role: 'owner',
                createdAt: '2026-07-17T00:00:00.000Z',
              }
            : undefined,
        listOrgsForSubject: async () => [
          {
            slug: 'acme',
            displayName: 'Acme',
            createdAt: '2026-07-17T00:00:00.000Z',
          },
        ],
      } satisfies Pick<
        ControlPlaneStore,
        'getActiveMcpSubdomain' | 'getOrgMember' | 'listOrgsForSubject'
      >),
    audit: options.audit ?? { emit: async () => undefined },
    publicBaseUrl: 'https://cloud.example',
    ...(options.publicBaseDomain === undefined
      ? {}
      : { publicBaseDomain: options.publicBaseDomain }),
    now: () => new Date('2026-07-17T12:00:00.000Z'),
  });
}

describe('ServiceDeveloperControlPlane', () => {
  it('returns live organizations, roles, and role-effective capabilities', async () => {
    await expect(
      adapter().getContext({ ...ctx, capabilities: ['cloud:read', 'deployments:rollback'] }),
    ).resolves.toEqual({
      accessModel: 'live_user',
      capabilities: ['cloud:read', 'deployments:rollback'],
      organizations: [
        {
          org: 'acme',
          displayName: 'Acme',
          role: 'owner',
          capabilities: ['cloud:read', 'deployments:rollback'],
        },
      ],
    });
  });

  it('returns every environment in a live member organization', async () => {
    const result = await adapter({
      registry: registry({
        listApps: async () => ({
          truncated: false,
          apps: [
            {
              orgSlug: 'acme',
              appSlug: 'demo',
              environments: ['prod', 'dev'],
              active: true,
              createdAt: '2026-07-17T00:00:00.000Z',
              lastActivityAt: '2026-07-17T01:00:00.000Z',
              latest: {
                deploymentId: 'prod-dep',
                orgSlug: 'acme',
                appSlug: 'demo',
                environment: 'prod',
                active: true,
                serverName: 'Demo',
                createdAt: '2026-07-17T01:00:00.000Z',
                accessMode: 'org-members',
              },
            },
          ],
        }),
      }),
    }).listApps(ctx, { org: 'acme', limit: 50 });

    expect(result).toEqual({
      apps: [
        {
          app: 'demo',
          environments: ['prod', 'dev'],
          active: true,
          createdAt: '2026-07-17T00:00:00.000Z',
          lastActivityAt: '2026-07-17T01:00:00.000Z',
          latest: {
            deploymentId: 'prod-dep',
            environment: 'prod',
            active: true,
            serverName: 'Demo',
            createdAt: '2026-07-17T01:00:00.000Z',
            accessMode: 'org-members',
          },
        },
      ],
    });
  });

  it('rejects an organization without current membership before any registry read', async () => {
    const getApp = vi.fn();
    const getEnvironment = vi.fn();
    const controlPlane = adapter({ registry: registry({ getApp, getEnvironment }) });

    await expect(
      controlPlane.inspectApp(ctx, { org: 'other', app: 'demo', env: 'prod' }),
    ).rejects.toMatchObject({ code: 'forbidden_scope' });
    expect(getApp).not.toHaveBeenCalled();
    expect(getEnvironment).not.toHaveBeenCalled();
  });

  it('does not resolve a deployment ID outside the granted organization', async () => {
    const getDeployment = vi.fn(async (org: string) =>
      org === 'other'
        ? {
            deploymentId: 'dep-other',
            orgSlug: 'other',
            appSlug: 'demo',
            environment: 'dev',
            active: true,
            serverName: 'Demo',
            createdAt: '2026-07-17T00:00:00.000Z',
            accessMode: 'org-members' as const,
          }
        : undefined,
    );
    await expect(
      adapter({ registry: registry({ getDeployment }) }).inspectDeployment(ctx, {
        org: 'acme',
        deploymentId: 'dep-other',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(getDeployment).toHaveBeenCalledWith('acme', 'dep-other');
  });

  it('does not freeze deployment environments into the connection', async () => {
    const getStatus = vi.fn();
    const controlPlane = adapter({
      registry: registry({
        getDeployment: async () => ({
          deploymentId: 'prod-dep',
          orgSlug: 'acme',
          appSlug: 'demo',
          environment: 'prod',
          active: true,
          serverName: 'Demo',
          createdAt: '2026-07-17T00:00:00.000Z',
          accessMode: 'org-members',
        }),
        getStatus,
      }),
    });
    await expect(
      controlPlane.inspectDeployment(ctx, { org: 'acme', deploymentId: 'prod-dep' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(getStatus).toHaveBeenCalled();
  });

  it('inspects an inactive historical deployment by its exact deployment id', async () => {
    const historical = {
      deploymentId: 'dep-previous',
      orgSlug: 'acme',
      appSlug: 'demo',
      environment: 'dev',
      active: false,
      serverName: 'Demo previous',
      createdAt: '2026-07-16T01:00:00.000Z',
      accessMode: 'org-members' as const,
    };
    const get = vi.fn(async () => ({
      served: {
        artifact: { tools: [], resources: [], prompts: [] },
      },
    }));
    const controlPlane = adapter({
      registry: {
        ...registry({ getDeployment: async () => historical }),
        get,
      } as DeveloperRegistry,
    });

    const inspected = await controlPlane.inspectDeployment(ctx, {
      org: 'acme',
      deploymentId: historical.deploymentId,
    });

    expect(get).toHaveBeenCalledWith(historical.deploymentId);
    expect(inspected.deployment).toMatchObject({
      deploymentId: historical.deploymentId,
      active: false,
    });
    expect(inspected.health).toEqual({ state: 'ready', missingSecrets: [] });
  });

  it('adds an explicit prior deployment candidate only when rollback is granted', async () => {
    const listDeployments = vi.fn(async () => [
      {
        deploymentId: 'dep-current',
        orgSlug: 'acme',
        appSlug: 'demo',
        environment: 'dev',
        active: true,
        serverName: 'Demo current',
        createdAt: '2026-07-17T01:00:00.000Z',
        accessMode: 'org-members' as const,
      },
      {
        deploymentId: 'dep-previous',
        orgSlug: 'acme',
        appSlug: 'demo',
        environment: 'dev',
        active: false,
        serverName: 'Demo previous',
        createdAt: '2026-07-16T01:00:00.000Z',
        accessMode: 'owner-only' as const,
      },
    ]);
    const candidateRegistry = registry({
      getDeployment: async () => ({
        deploymentId: 'dep-current',
        orgSlug: 'acme',
        appSlug: 'demo',
        environment: 'dev',
        active: true,
        serverName: 'Demo current',
        createdAt: '2026-07-17T01:00:00.000Z',
        accessMode: 'org-members',
      }),
      getStatus: async () => ({
        target: { org: 'acme', app: 'demo', env: 'dev' },
        deployment: {
          deploymentId: 'dep-current',
          endpointUrl: 'https://cloud.example/o/acme/demo/dev/mcp',
          active: true,
          serverName: 'Demo current',
          createdAt: '2026-07-17T01:00:00.000Z',
          accessMode: 'org-members',
        },
        health: { state: 'ready' },
        config: { ok: true, missingSecrets: [] },
      }),
      listDeployments,
    });

    const withRollback = await adapter({ registry: candidateRegistry }).inspectDeployment(
      { ...ctx, capabilities: ['cloud:read', 'deployments:rollback'] },
      { org: 'acme', deploymentId: 'dep-current' },
    );
    expect(withRollback.rollbackCandidate).toEqual({
      deploymentId: 'dep-previous',
      serverName: 'Demo previous',
      createdAt: '2026-07-16T01:00:00.000Z',
    });
    expect(listDeployments).toHaveBeenCalledWith({ org: 'acme', app: 'demo', env: 'dev' });

    listDeployments.mockClear();
    const withoutRollback = await adapter({ registry: candidateRegistry }).inspectDeployment(ctx, {
      org: 'acme',
      deploymentId: 'dep-current',
    });
    expect(withoutRollback).not.toHaveProperty('rollbackCandidate');
    expect(listDeployments).not.toHaveBeenCalled();
  });

  it('passes exact log scope and removes redundant tenant fields', async () => {
    const list = vi.fn(async () => [
      {
        id: 'log-1',
        createdAt: '2026-07-17T00:00:00.000Z',
        level: 'error' as const,
        message: 'failed',
        org: 'acme',
        app: 'demo',
        env: 'dev',
        details: { attempt: 2 },
      },
    ]);
    const result = await adapter({ logs: logs({ list }) }).getLogs(ctx, {
      org: 'acme',
      app: 'demo',
      env: 'dev',
      limit: 25,
      level: 'error',
    });

    expect(list).toHaveBeenCalledWith({
      org: 'acme',
      app: 'demo',
      env: 'dev',
      limit: 25,
      level: 'error',
    });
    expect(result.events[0]).toEqual({
      id: 'log-1',
      createdAt: '2026-07-17T00:00:00.000Z',
      level: 'error',
      message: 'failed',
      details: { attempt: 2 },
    });
  });

  it('preserves cross-era client activity evidence in the metrics projection', async () => {
    const list = vi.fn(async () => [
      {
        id: 'event-1',
        schemaVersion: 2,
        createdAt: '2026-07-17T00:01:00.000Z',
        org: 'acme',
        app: 'demo',
        env: 'dev',
        protocolEra: 'modern' as const,
        requestId: 'request-1',
        sessionSource: 'none' as const,
        clientFamily: 'modern-console',
        subjectKind: 'anonymous' as const,
        method: 'tools/call',
        kind: 'usage' as const,
        toolName: 'hello',
        outcome: 'ok' as const,
        durationMs: 10,
      },
    ]);
    const result = await adapter({ requestEvents: requestEvents({ list }) }).getMetrics(ctx, {
      org: 'acme',
      app: 'demo',
      env: 'dev',
      window: '7d',
    });

    expect(result.metrics.totals).toMatchObject({
      requests: 1,
      legacyInitializations: 0,
    });
    expect(result.metrics.byClientFamily).toEqual([
      {
        family: 'modern-console',
        requests: 1,
        errors: 0,
        share: 1,
        lastSuccessfulAt: '2026-07-17T00:01:00.000Z',
        protocolEras: { legacy: 0, modern: 1, unknown: 0 },
      },
    ]);
    expect(result.metrics.clientActivity).toEqual({
      callers: [
        {
          family: 'modern-console',
          attribution: 'transport_only',
          requests: 1,
          errors: 0,
          share: 1,
          lastSuccessfulAt: '2026-07-17T00:01:00.000Z',
          protocolEras: { legacy: 0, modern: 1, unknown: 0 },
        },
      ],
      legacyHandshakes: { total: 0, byReportedClient: [] },
    });
  });

  it('runs rollback through the governed operation and removes the organization from the tool view', async () => {
    const rollback = vi.fn(async () => ({
      ok: true as const,
      deploymentId: 'dep-previous',
      previousDeploymentId: 'dep-current',
      alreadyActive: false,
      accessMode: 'org-members' as const,
      previousAccessMode: 'owner-only' as const,
      serverName: 'Demo',
      createdAt: '2026-07-17T00:00:00.000Z',
    }));
    const audit = { emit: vi.fn(async () => undefined) };
    const result = await adapter({
      registry: registry({ rollback }),
      audit,
      publicBaseDomain: 'mcp.example',
      controlPlane: {
        getActiveMcpSubdomain: async () => ({
          mcpSubdomain: 'arez',
          orgSlug: 'acme',
          claimedAt: '2026-08-11T00:00:00.000Z',
        }),
        getOrgMember: async () => ({
          orgSlug: 'acme',
          subject: ctx.subject,
          email: 'developer@acme.example',
          role: 'owner',
          createdAt: '2026-07-17T00:00:00.000Z',
        }),
        listOrgsForSubject: async () => [],
      },
    }).rollbackDeployment(
      { ...ctx, capabilities: ['cloud:read', 'deployments:rollback'] },
      {
        org: 'acme',
        app: 'demo',
        env: 'dev',
        deploymentId: 'dep-previous',
        reason: 'Restore known-good release',
      },
    );

    expect(rollback).toHaveBeenCalledWith({ org: 'acme', app: 'demo', env: 'dev' }, 'dep-previous');
    expect(result).toEqual({
      target: { app: 'demo', env: 'dev' },
      rollback: {
        deploymentId: 'dep-previous',
        previousDeploymentId: 'dep-current',
        alreadyActive: false,
        endpointUrl: 'https://arez.mcp.example/demo/env/dev/mcp',
        accessMode: 'org-members',
        previousAccessMode: 'owner-only',
        serverName: 'Demo',
        createdAt: '2026-07-17T00:00:00.000Z',
      },
    });
    expect(audit.emit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'deploy.rollback', decision: 'allow' }),
    );
  });

  it('rejects rollback before service access when the grant capability or live owner role is absent', async () => {
    const rollback = vi.fn();
    const controlPlane = adapter({
      registry: registry({ rollback }),
      controlPlane: {
        getActiveMcpSubdomain: async () => undefined,
        getOrgMember: async () => ({
          orgSlug: 'acme',
          subject: ctx.subject,
          email: 'developer@acme.example',
          role: 'developer',
          createdAt: '2026-07-17T00:00:00.000Z',
        }),
        listOrgsForSubject: async () => [],
      },
    });

    await expect(
      controlPlane.rollbackDeployment(ctx, {
        org: 'acme',
        app: 'demo',
        env: 'dev',
        deploymentId: 'dep-previous',
      }),
    ).rejects.toMatchObject({ code: 'forbidden_scope' });
    await expect(
      controlPlane.rollbackDeployment(
        { ...ctx, capabilities: ['cloud:read', 'deployments:rollback'] },
        { org: 'acme', app: 'demo', env: 'prod', deploymentId: 'dep-previous' },
      ),
    ).rejects.toMatchObject({ code: 'forbidden_scope' });
    expect(rollback).not.toHaveBeenCalled();
  });
});
