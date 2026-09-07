import { describe, expect, it, vi } from 'vitest';
import type { DeveloperMcpContext } from '../src/contracts.js';
import { diagnoseEvidence } from '../src/diagnosis.js';
import type { DeveloperControlPlane } from '../src/port.js';
import { diagnoseApp } from '../src/tools/diagnose.js';

const deployment = {
  target: { app: 'demo', env: 'dev' },
  deployment: {
    deploymentId: 'dep-1',
    endpointUrl: 'https://acme.example/demo/env/dev/mcp',
    active: true,
    serverName: 'Demo',
    createdAt: '2026-07-17T00:00:00.000Z',
    accessMode: 'org-members',
  },
  health: { state: 'ready', missingSecrets: [] as string[] },
  surface: {
    tools: [{ name: 'hello', description: 'Say hello' }],
    resources: [],
    prompts: [],
    widgets: [],
    compatibility: { mcpApps: 'pass' as const, chatgpt: 'pass' as const, claude: 'pass' as const },
  },
  findings: [],
};

const metrics = {
  window: { since: '2026-07-16T00:00:00.000Z' },
  truncated: false,
  metrics: {
    totals: {
      requests: 20,
      sessions: 2,
      legacyInitializations: 2,
      toolCalls: 10,
      discovery: 2,
    },
    errors: {
      ok: 20,
      toolErrors: 0,
      mcpErrors: 0,
      toolErrorRate: 0,
      mcpErrorRate: 0,
      errorRate: 0,
    },
    latency: { avgMs: 10, p50Ms: 8, p95Ms: 20, p99Ms: 25 },
    tokens: { total: 100, avgPerCall: 5 },
    byTool: [],
    byClient: [],
    byClientFamily: [],
    clientActivity: { callers: [], legacyHandshakes: { total: 0, byReportedClient: [] } },
    byMethod: [],
    series: [],
  },
};

describe('deterministic developer diagnosis', () => {
  it('reports missing managed config with cited evidence', () => {
    const findings = diagnoseEvidence({
      deployment: {
        ...deployment,
        health: { state: 'missing-config', missingSecrets: ['API_KEY'] },
      },
    });
    expect(findings).toContainEqual({
      severity: 'error',
      code: 'missing_managed_config',
      title: 'Managed configuration is incomplete',
      message: '1 required secret is missing.',
      evidence: ['deployment.health.missingSecrets'],
      nextAction: {
        kind: 'run_cli',
        label: 'Set the missing managed secret',
        command: 'noodle secrets set API_KEY',
      },
    });
  });

  it('emits a valid one-secret recovery command when several secrets are missing', () => {
    const findings = diagnoseEvidence({
      deployment: {
        ...deployment,
        health: { state: 'missing-config', missingSecrets: ['SECOND_SECRET', 'FIRST_SECRET'] },
      },
    });
    expect(findings[0]?.nextAction).toMatchObject({
      kind: 'run_cli',
      command: 'noodle secrets set FIRST_SECRET',
    });
    expect(findings[0]?.nextAction?.command).not.toContain('SECOND_SECRET');
  });

  it('reports an unhealthy compile or deployment state', () => {
    expect(
      diagnoseEvidence({
        deployment: { ...deployment, health: { state: 'compile-failed', missingSecrets: [] } },
      }),
    ).toContainEqual(expect.objectContaining({ code: 'deployment_unhealthy', severity: 'error' }));
  });

  it('reports no active deployment without inventing a source fix', () => {
    const findings = diagnoseEvidence({ app: { active: false } });
    expect(findings).toContainEqual(
      expect.objectContaining({ code: 'no_active_deployment', evidence: ['app.active'] }),
    );
    expect(JSON.stringify(findings)).not.toContain('edit source');
  });

  it('reports recent tool-error spikes', () => {
    const findings = diagnoseEvidence({
      deployment,
      metrics: {
        ...metrics,
        metrics: {
          ...metrics.metrics,
          errors: { ...metrics.metrics.errors, toolErrors: 8, toolErrorRate: 0.4, errorRate: 0.4 },
        },
      },
    });
    expect(findings).toContainEqual(
      expect.objectContaining({
        code: 'tool_error_spike',
        severity: 'warning',
        evidence: ['metrics.errors.toolErrorRate', 'metrics.totals.requests'],
      }),
    );
  });

  it('labels partial analytics evidence', () => {
    expect(
      diagnoseEvidence({ deployment, metrics: { ...metrics, truncated: true } }),
    ).toContainEqual(expect.objectContaining({ code: 'partial_analytics', severity: 'warning' }));
  });

  it('orders findings by severity then code', () => {
    const findings = diagnoseEvidence({
      deployment: {
        ...deployment,
        health: { state: 'missing-config', missingSecrets: ['B_SECRET', 'A_SECRET'] },
      },
      metrics: { ...metrics, truncated: true },
      unavailable: ['logs'],
    });
    expect(findings.map((finding) => finding.code)).toEqual([
      'missing_managed_config',
      'partial_analytics',
      'source_unavailable',
    ]);
  });

  it('returns insufficient evidence for an empty input and no findings for healthy evidence', () => {
    expect(diagnoseEvidence({})).toEqual([
      expect.objectContaining({ code: 'insufficient_evidence', severity: 'info' }),
    ]);
    expect(diagnoseEvidence({ deployment, metrics })).toEqual([]);
  });
});

describe('diagnose_app tool', () => {
  const ctx: DeveloperMcpContext = {
    subject: 'subject-1',
    clientId: 'client-1',
    grantId: 'grant-1',
    resource: 'https://cloud.noodleseed.com/developer/mcp',
    capabilities: ['cloud:read'],
  };

  it('stops after app inspection when no deployment is active', async () => {
    const inspectApp = vi.fn(async () => ({
      app: 'demo',
      environments: ['dev'],
      active: false,
      createdAt: '2026-07-17T00:00:00.000Z',
      selectedEnvironment: 'dev',
    }));
    const unexpected = vi.fn(async (): Promise<never> => {
      throw new Error('unexpected');
    });
    const controlPlane = {
      getContext: unexpected,
      listApps: unexpected,
      inspectApp,
      inspectDeployment: unexpected,
      getLogs: unexpected,
      getMetrics: unexpected,
      listEvents: unexpected,
      getSession: unexpected,
      rollbackDeployment: unexpected,
    } satisfies DeveloperControlPlane;

    const result = await diagnoseApp(
      { ctx, controlPlane, observedAt: () => '2026-07-17T12:00:00.000Z' },
      { org: 'acme', app: 'demo', env: 'dev' },
    );

    expect(inspectApp).toHaveBeenCalledWith(ctx, { org: 'acme', app: 'demo', env: 'dev' });
    expect(unexpected).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({
      ok: true,
      data: { findings: [{ code: 'no_active_deployment' }] },
    });
  });
});
