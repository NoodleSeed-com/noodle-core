import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  DEVELOPER_ERROR_CODES,
  DEVELOPER_MCP_CAPABILITY_VERSION,
  deploymentInspectionViewSchema,
  deploymentSummarySchema,
  developerErrorCodeSchema,
  developerMcpContextSchema,
  getLogsInputSchema,
  getMetricsInputSchema,
  getSessionInputSchema,
  inspectAppInputSchema,
  inspectDeploymentInputSchema,
  isoTimestampSchema,
  listAppsInputSchema,
  listEventsInputSchema,
  metricsViewSchema,
  rollbackViewSchema,
  sessionViewSchema,
} from '../src/contracts.js';

describe('Developer MCP contracts', () => {
  it('locks the capability and error-code vocabulary', () => {
    expect(DEVELOPER_MCP_CAPABILITY_VERSION).toBe('2');
    expect(DEVELOPER_ERROR_CODES).toEqual([
      'authentication_required',
      'grant_revoked',
      'forbidden_scope',
      'capability_missing',
      'client_incompatible',
      'validation_failed',
      'not_found',
      'dependency_unavailable',
      'rate_limited',
      'internal_error',
    ]);
    for (const code of DEVELOPER_ERROR_CODES) {
      expect(developerErrorCodeSchema.parse(code)).toBe(code);
    }
    expect(developerErrorCodeSchema.safeParse('unknown_error').success).toBe(false);
  });

  it('strictly parses grant-derived context', () => {
    const context = {
      subject: 'google-subject',
      clientId: 'client-1',
      grantId: 'grant-1',
      resource: 'https://cloud.noodleseed.com/developer/mcp',
      capabilities: ['cloud:read'],
    };
    expect(developerMcpContextSchema.parse(context)).toEqual(context);
    expect(developerMcpContextSchema.safeParse({ ...context, extra: true }).success).toBe(false);
    expect(
      developerMcpContextSchema.safeParse({ ...context, resource: '/developer/mcp' }).success,
    ).toBe(false);
  });

  it('requires an explicit organization on every organization-scoped input', () => {
    expect(listAppsInputSchema.parse({ org: 'other' })).toEqual({ org: 'other', limit: 50 });
    expect(listAppsInputSchema.safeParse({}).success).toBe(false);
    expect(inspectAppInputSchema.parse({ app: 'demo', env: 'dev', org: 'other' })).toEqual({
      app: 'demo',
      env: 'dev',
      org: 'other',
    });
    expect(
      inspectDeploymentInputSchema.safeParse({ org: 'acme', deploymentId: 'dep-1', extra: true })
        .success,
    ).toBe(false);
  });

  it('enforces public bounds and defaults', () => {
    expect(listAppsInputSchema.parse({ org: 'acme' })).toEqual({ org: 'acme', limit: 50 });
    expect(listAppsInputSchema.safeParse({ org: 'acme', limit: 0 }).success).toBe(false);
    expect(listAppsInputSchema.safeParse({ org: 'acme', limit: 101 }).success).toBe(false);

    expect(getLogsInputSchema.parse({ org: 'acme', app: 'demo', env: 'dev' }).limit).toBe(100);
    expect(
      getLogsInputSchema.safeParse({ org: 'acme', app: 'demo', env: 'dev', limit: 201 }).success,
    ).toBe(false);
    expect(
      getLogsInputSchema.safeParse({
        org: 'acme',
        app: 'demo',
        env: 'dev',
        search: 'x'.repeat(201),
      }).success,
    ).toBe(false);

    expect(listEventsInputSchema.parse({ org: 'acme', app: 'demo', env: 'dev' }).limit).toBe(100);
    expect(
      listEventsInputSchema.safeParse({ org: 'acme', app: 'demo', env: 'dev', limit: 501 }).success,
    ).toBe(false);
    expect(
      getSessionInputSchema.safeParse({
        org: 'acme',
        app: 'demo',
        env: 'dev',
        sessionId: 'x'.repeat(201),
      }).success,
    ).toBe(false);
  });

  it('validates environments, timestamps, and ordered time ranges', () => {
    expect(
      inspectAppInputSchema.safeParse({ org: 'acme', app: 'demo', env: '../prod' }).success,
    ).toBe(false);
    expect(isoTimestampSchema.safeParse('2026-07-17T12:00:00.000Z').success).toBe(true);
    expect(isoTimestampSchema.safeParse('2026-07-17').success).toBe(false);
    expect(
      getLogsInputSchema.safeParse({
        app: 'demo',
        org: 'acme',
        env: 'dev',
        since: '2026-07-18T00:00:00.000Z',
        until: '2026-07-17T00:00:00.000Z',
      }).success,
    ).toBe(false);
    expect(
      getLogsInputSchema.safeParse({
        app: 'demo',
        org: 'acme',
        env: 'dev',
        since: '2026-07-17T12:00:00+05:00',
        until: '2026-07-17T09:00:00Z',
      }).success,
    ).toBe(true);
    expect(
      getLogsInputSchema.safeParse({
        app: 'demo',
        org: 'acme',
        env: 'dev',
        since: '2026-07-17T12:00:00Z',
        until: '2026-07-17T12:00:00.000Z',
      }).success,
    ).toBe(true);
  });

  it('represents host rendering as unverified until live-host evidence exists', () => {
    const compatibility = deploymentInspectionViewSchema.shape.surface.shape.compatibility.parse({
      mcpApps: 'pass',
      chatgpt: 'unverified',
      claude: 'unverified',
    });
    expect(compatibility).toEqual({
      mcpApps: 'pass',
      chatgpt: 'unverified',
      claude: 'unverified',
    });
  });

  it('accepts bounded metrics windows or explicit timestamps', () => {
    expect(getMetricsInputSchema.parse({ org: 'acme', app: 'demo', env: 'dev' }).window).toBe('7d');
    expect(
      getMetricsInputSchema.safeParse({ org: 'acme', app: 'demo', env: 'dev', window: '90d' })
        .success,
    ).toBe(false);
    expect(
      getMetricsInputSchema.safeParse({
        app: 'demo',
        org: 'acme',
        env: 'dev',
        since: '2026-07-17T00:00:00.000Z',
        until: '2026-07-18T00:00:00.000Z',
      }).success,
    ).toBe(true);
  });

  it('keeps session events bounded and output contracts strict', () => {
    const event = {
      id: 'evt-1',
      createdAt: '2026-07-17T00:00:00.000Z',
      requestId: 'req-1',
      sessionSource: 'mcp',
      subjectKind: 'authenticated',
      method: 'tools/call',
      kind: 'usage',
      outcome: 'ok',
      durationMs: 10,
    };
    expect(
      sessionViewSchema.safeParse({ sessionId: 'session-1', events: Array(1_001).fill(event) })
        .success,
    ).toBe(false);
    const metricsView = {
      window: { since: '2026-07-17T00:00:00.000Z' },
      truncated: false,
      metrics: {
        totals: {
          requests: 1,
          sessions: 1,
          legacyInitializations: 1,
          toolCalls: 1,
          discovery: 1,
        },
        errors: {
          ok: 0,
          toolErrors: 0,
          mcpErrors: 0,
          toolErrorRate: 0,
          mcpErrorRate: 0,
          errorRate: 0,
        },
        latency: { avgMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 },
        tokens: { total: 0, avgPerCall: 0 },
        byTool: [],
        byClient: [],
        byClientFamily: [
          {
            family: 'claude-ai',
            requests: 1,
            errors: 0,
            share: 1,
            lastSuccessfulAt: '2026-07-17T00:01:00.000Z',
            protocolEras: { legacy: 1, modern: 0, unknown: 0 },
          },
        ],
        clientActivity: {
          callers: [
            {
              family: 'investment-calculator',
              attribution: 'self_reported',
              reportedName: 'Investment Calculator',
              requests: 1,
              errors: 0,
              share: 1,
              lastSuccessfulAt: '2026-07-17T00:01:00.000Z',
              protocolEras: { legacy: 0, modern: 1, unknown: 0 },
            },
          ],
          legacyHandshakes: {
            total: 1,
            byReportedClient: [
              {
                reportedName: 'MCPJam Inspector',
                initializations: 1,
                share: 1,
                lastInitializedAt: '2026-07-17T00:00:00.000Z',
              },
            ],
          },
        },
        byMethod: [],
        series: [],
      },
    };
    expect(metricsViewSchema.safeParse(metricsView).success).toBe(true);
    expect(metricsViewSchema.safeParse({ ...metricsView, unknown: true }).success).toBe(false);
  });

  it('rejects oversized deployment inspection collections', () => {
    const base = {
      target: { app: 'demo', env: 'dev' },
      deployment: {
        deploymentId: 'dep-1',
        endpointUrl: 'https://cloud.example/o/acme/demo/dev/mcp',
        active: true,
        serverName: 'Demo',
        createdAt: '2026-07-17T00:00:00.000Z',
        accessMode: 'owner-only',
        ownerSubject: 'oauth-human',
      },
      health: { state: 'ready', missingSecrets: [] },
      surface: {
        tools: [],
        resources: [],
        prompts: [],
        widgets: [],
        compatibility: { mcpApps: 'pass', chatgpt: 'unverified', claude: 'unverified' },
      },
    };
    expect(deploymentInspectionViewSchema.safeParse({ ...base, findings: [] }).success).toBe(true);
    expect(
      deploymentSummarySchema.safeParse({
        deploymentId: 'dep-1',
        environment: 'dev',
        active: true,
        serverName: 'Demo',
        createdAt: '2026-07-17T00:00:00.000Z',
        accessMode: 'owner-only',
        ownerSubject: 'oauth-human',
      }).success,
    ).toBe(true);
    expect(
      rollbackViewSchema.safeParse({
        target: { app: 'demo', env: 'dev' },
        rollback: {
          deploymentId: 'dep-1',
          alreadyActive: false,
          endpointUrl: 'https://cloud.example/o/acme/demo/dev/mcp',
          accessMode: 'owner-only',
          ownerSubject: 'oauth-human',
          serverName: 'Demo',
          createdAt: '2026-07-17T00:00:00.000Z',
        },
      }).success,
    ).toBe(true);
    expect(
      deploymentInspectionViewSchema.safeParse({
        ...base,
        findings: Array.from({ length: 101 }, () => ({
          level: 'warn',
          code: 'bounded',
          message: 'Finding',
        })),
      }).success,
    ).toBe(false);
  });

  it('exports draft 2020-12 JSON Schema for public inputs', () => {
    const schema = z.toJSONSchema(listEventsInputSchema, { target: 'draft-2020-12' });
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.additionalProperties).toBe(false);
  });
});
