import { describe, expect, it, vi } from 'vitest';

import type { DeveloperMcpContext, RollbackView } from '../src/contracts.js';
import { type DeveloperControlPlane, DeveloperControlPlaneError } from '../src/port.js';
import { rollbackDeployment } from '../src/tools/index.js';

const observedAt = () => '2026-07-17T12:00:00.000Z';

const rollbackView: RollbackView = {
  target: { app: 'demo', env: 'dev' },
  rollback: {
    deploymentId: 'dep-previous',
    previousDeploymentId: 'dep-current',
    alreadyActive: false,
    endpointUrl: 'https://acme.example/demo/env/dev/mcp',
    accessMode: 'org-members',
    previousAccessMode: 'owner-only',
    serverName: 'Demo',
    createdAt: '2026-07-17T00:00:00.000Z',
  },
};

function context(overrides: Partial<DeveloperMcpContext> = {}): DeveloperMcpContext {
  return {
    subject: 'subject-1',
    clientId: 'client-1',
    grantId: 'grant-1',
    resource: 'https://cloud.noodleseed.com/developer/mcp',
    capabilities: ['cloud:read', 'deployments:rollback'],
    ...overrides,
  };
}

function fakePort(rollback: DeveloperControlPlane['rollbackDeployment']): DeveloperControlPlane {
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
    rollbackDeployment: rollback,
  };
}

function invoke(
  input: unknown,
  options: {
    readonly ctx?: DeveloperMcpContext;
    readonly rollback?: DeveloperControlPlane['rollbackDeployment'];
  } = {},
) {
  const rollback = options.rollback ?? vi.fn(async () => rollbackView);
  return {
    rollback,
    result: rollbackDeployment(
      {
        ctx: options.ctx ?? context(),
        controlPlane: fakePort(rollback),
        observedAt,
      },
      input,
    ),
  };
}

describe('Developer MCP rollback tool', () => {
  it('denies a missing rollback capability before calling the port', async () => {
    const call = invoke(
      { org: 'acme', app: 'demo', env: 'dev', deploymentId: 'dep-previous' },
      { ctx: context({ capabilities: ['cloud:read'] }) },
    );

    await expect(call.result).resolves.toMatchObject({
      isError: true,
      structuredContent: { ok: false, error: { code: 'capability_missing' } },
    });
    expect(call.rollback).not.toHaveBeenCalled();
  });

  it('requires an explicit organization before calling the port', async () => {
    const call = invoke({ app: 'demo', env: 'prod', deploymentId: 'dep-previous' });

    await expect(call.result).resolves.toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        error: { code: 'validation_failed' },
      },
    });
    expect(call.rollback).not.toHaveBeenCalled();
  });

  it.each([
    { org: 'acme', app: 'demo', env: 'dev', deploymentId: '' },
    { org: 'acme', app: 'demo', env: 'dev', deploymentId: 'dep-previous', reason: '' },
    {
      org: 'acme',
      app: 'demo',
      env: 'dev',
      deploymentId: 'dep-previous',
      reason: 'x'.repeat(501),
    },
  ])('rejects invalid input without calling the port: %o', async (input) => {
    const call = invoke(input);

    await expect(call.result).resolves.toMatchObject({
      isError: true,
      structuredContent: { ok: false, error: { code: 'validation_failed' } },
    });
    expect(call.rollback).not.toHaveBeenCalled();
  });

  it('maps a governed port rejection without leaking implementation detail', async () => {
    const call = invoke(
      { org: 'acme', app: 'demo', env: 'dev', deploymentId: 'dep-previous' },
      {
        rollback: vi.fn(async () => {
          throw new DeveloperControlPlaneError('not_found', 'deployment not found');
        }),
      },
    );

    await expect(call.result).resolves.toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        error: { code: 'not_found', message: 'deployment not found', retryable: false },
      },
    });
  });

  it.each([
    false,
    true,
  ])('returns the complete rollback view and ordered next actions (alreadyActive=%s)', async (alreadyActive) => {
    const data: RollbackView = {
      ...rollbackView,
      rollback: { ...rollbackView.rollback, alreadyActive },
    };
    const rollback = vi.fn(async () => data);
    const call = invoke(
      {
        org: 'acme',
        app: 'demo',
        env: 'dev',
        deploymentId: 'dep-previous',
        reason: 'Restore the last known-good release',
      },
      { rollback },
    );

    await expect(call.result).resolves.toMatchObject({
      structuredContent: {
        ok: true,
        data,
        meta: {
          org: 'acme',
          env: 'dev',
          nextActions: [
            { kind: 'call_tool', tool: 'inspect_deployment' },
            { kind: 'call_tool', tool: 'get_logs' },
            { kind: 'call_tool', tool: 'get_metrics' },
          ],
        },
      },
    });
    expect(rollback).toHaveBeenCalledWith(context(), {
      org: 'acme',
      app: 'demo',
      env: 'dev',
      deploymentId: 'dep-previous',
      reason: 'Restore the last known-good release',
    });
  });
});
