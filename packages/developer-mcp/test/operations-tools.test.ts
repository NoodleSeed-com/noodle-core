import { describe, expect, it, vi } from 'vitest';

import type { DeveloperMcpContext } from '../src/contracts.js';
import { type DeveloperControlPlane, DeveloperControlPlaneError } from '../src/port.js';
import { getLogs, getMetrics, getSession, listEvents } from '../src/tools/index.js';

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

function toolContext(controlPlane: DeveloperControlPlane) {
  return { ctx, observedAt, controlPlane };
}

const event = {
  id: 'evt-1',
  schemaVersion: 1,
  createdAt: '2026-07-17T00:00:00.000Z',
  requestId: 'req-1',
  sessionId: 'session-1',
  sessionSource: 'mcp' as const,
  subjectKind: 'authenticated' as const,
  method: 'tools/call',
  kind: 'usage' as const,
  outcome: 'ok' as const,
  durationMs: 10,
};

const emptyMetrics = {
  totals: {
    requests: 0,
    sessions: 0,
    legacyInitializations: 0,
    toolCalls: 0,
    discovery: 0,
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
  byClientFamily: [],
  clientActivity: { callers: [], legacyHandshakes: { total: 0, byReportedClient: [] } },
  byMethod: [],
  series: [],
};

describe('Developer MCP operational tools', () => {
  it.each([
    ['invalid log level', getLogs, { org: 'acme', app: 'demo', env: 'dev', level: 'fatal' }],
    ['long search', getLogs, { org: 'acme', app: 'demo', env: 'dev', search: 'x'.repeat(201) }],
    [
      'inverted timestamps',
      getLogs,
      {
        org: 'acme',
        app: 'demo',
        env: 'dev',
        since: '2026-07-18T00:00:00.000Z',
        until: '2026-07-17T00:00:00.000Z',
      },
    ],
    ['event limit', listEvents, { org: 'acme', app: 'demo', env: 'dev', limit: 501 }],
    ['invalid outcome', listEvents, { org: 'acme', app: 'demo', env: 'dev', outcome: 'failed' }],
    [
      'long session',
      getSession,
      { org: 'acme', app: 'demo', env: 'dev', sessionId: 'x'.repeat(201) },
    ],
  ])('rejects %s before calling the port', async (_name, handler, input) => {
    const port = fakePort();
    const result = await handler(toolContext(port), input);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: 'validation_failed' },
    });
  });

  it('passes bounded log filters and preserves safe scalar details', async () => {
    const read = vi.fn(async () => ({
      events: [
        {
          id: 'log-1',
          createdAt: '2026-07-17T00:00:00.000Z',
          level: 'error' as const,
          message: 'tool failed',
          details: { attempt: 2, retryable: true },
        },
      ],
    }));
    const result = await getLogs(toolContext(fakePort({ getLogs: read })), {
      org: 'acme',
      app: 'demo',
      env: 'dev',
      level: 'error',
      limit: 25,
    });

    expect(read).toHaveBeenCalledWith(ctx, {
      org: 'acme',
      app: 'demo',
      env: 'dev',
      level: 'error',
      limit: 25,
    });
    expect(result.structuredContent).toMatchObject({
      ok: true,
      data: { events: [{ details: { attempt: 2, retryable: true } }] },
      meta: { env: 'dev' },
    });
  });

  it('rejects nested fake metadata without exposing its value', async () => {
    const result = await getLogs(
      toolContext(
        fakePort({
          getLogs: async () => ({
            events: [
              {
                id: 'log-1',
                createdAt: '2026-07-17T00:00:00.000Z',
                level: 'error',
                message: 'tool failed',
                details: { authorization: { bearer: 'do-not-expose' } },
              },
            ],
          }),
        }),
      ),
      { org: 'acme', app: 'demo', env: 'dev' },
    );

    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: 'internal_error' },
    });
    expect(JSON.stringify(result)).not.toContain('do-not-expose');
  });

  it('preserves partial metrics and explicit windows', async () => {
    const read = vi.fn(async () => ({
      window: { since: '2026-07-01T00:00:00.000Z', until: '2026-07-17T00:00:00.000Z' },
      truncated: true,
      metrics: emptyMetrics,
    }));
    const result = await getMetrics(toolContext(fakePort({ getMetrics: read })), {
      org: 'acme',
      app: 'demo',
      env: 'dev',
      since: '2026-07-01T00:00:00.000Z',
      until: '2026-07-17T00:00:00.000Z',
    });

    expect(read).toHaveBeenCalledWith(ctx, expect.objectContaining({ window: '7d' }));
    expect(result.structuredContent).toMatchObject({ ok: true, data: { truncated: true } });
  });

  it('preserves ordered session chronology', async () => {
    const later = { ...event, id: 'evt-2', createdAt: '2026-07-17T00:01:00.000Z' };
    const result = await getSession(
      toolContext(
        fakePort({ getSession: async () => ({ sessionId: 'session-1', events: [event, later] }) }),
      ),
      { org: 'acme', app: 'demo', env: 'dev', sessionId: 'session-1' },
    );
    expect(result.structuredContent).toMatchObject({
      ok: true,
      data: { events: [{ id: 'evt-1' }, { id: 'evt-2' }] },
    });
  });

  it('maps dependency failures without exposing unexpected exceptions', async () => {
    const result = await listEvents(
      toolContext(
        fakePort({
          listEvents: async () => {
            throw new DeveloperControlPlaneError(
              'dependency_unavailable',
              'Analytics is unavailable.',
            );
          },
        }),
      ),
      { org: 'acme', app: 'demo', env: 'dev' },
    );
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: 'dependency_unavailable', retryable: true },
    });
  });
});
