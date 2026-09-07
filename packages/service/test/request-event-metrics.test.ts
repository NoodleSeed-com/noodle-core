import type { RequestEvent } from '@noodle-borg/module';
import { aggregateRequestEvents } from '@noodle-borg/observability';
import { describe, expect, it } from 'vitest';

let seq = 0;
function event(overrides: Partial<RequestEvent> = {}): RequestEvent {
  seq += 1;
  return {
    id: `e-${seq}`,
    schemaVersion: 1,
    createdAt: '2026-07-05T10:00:00.000Z',
    org: 'acme',
    app: 'support',
    env: 'prod',
    requestId: `r-${seq}`,
    sessionSource: 'none',
    subjectKind: 'anonymous',
    method: 'tools/call',
    kind: 'usage',
    outcome: 'ok',
    durationMs: 100,
    ...overrides,
  };
}

const init = (client: string): RequestEvent => event({ method: 'initialize', clientName: client });

describe('aggregateRequestEvents', () => {
  it('computes totals, excluding discovery from usage', () => {
    const metrics = aggregateRequestEvents([
      init('claude-ai'),
      event({ toolName: 'a' }),
      event({ toolName: 'a' }),
      event({ method: 'tools/list', kind: 'discovery' }),
    ]);
    expect(metrics.totals.requests).toBe(2); // initialize + list are discovery; 2 calls remain
    expect(metrics.totals.discovery).toBe(2);
    expect(metrics.totals.toolCalls).toBe(2);
    expect(metrics.totals.sessions).toBe(1);
    expect(metrics.totals.legacyInitializations).toBe(1);
  });

  it('computes the two-tier error counts and rates', () => {
    const metrics = aggregateRequestEvents([
      event({ outcome: 'ok' }),
      event({ outcome: 'ok' }),
      event({ outcome: 'tool_error', errorKind: 'connector_error' }),
      event({ outcome: 'mcp_error', errorKind: 'timeout' }),
    ]);
    expect(metrics.errors.toolErrors).toBe(1);
    expect(metrics.errors.mcpErrors).toBe(1);
    expect(metrics.errors.toolErrorRate).toBeCloseTo(0.25);
    expect(metrics.errors.mcpErrorRate).toBeCloseTo(0.25);
    expect(metrics.errors.errorRate).toBeCloseTo(0.5);
  });

  it('computes latency percentiles over usage events', () => {
    const events = [10, 20, 30, 40, 50, 60, 70, 80, 90, 1000].map((ms) =>
      event({ durationMs: ms }),
    );
    const metrics = aggregateRequestEvents(events);
    expect(metrics.latency.p50Ms).toBe(50);
    expect(metrics.latency.p95Ms).toBe(1000);
    expect(metrics.latency.p99Ms).toBe(1000);
    expect(metrics.latency.avgMs).toBeCloseTo(145);
  });

  it('breaks down by tool with error counts and share', () => {
    const metrics = aggregateRequestEvents([
      event({ toolName: 'search', durationMs: 10 }),
      event({ toolName: 'search', durationMs: 20 }),
      event({ toolName: 'refund', outcome: 'tool_error', durationMs: 30 }),
    ]);
    const search = metrics.byTool.find((t) => t.tool === 'search');
    const refund = metrics.byTool.find((t) => t.tool === 'refund');
    expect(search).toMatchObject({ calls: 2, errors: 0 });
    expect(search?.share).toBeCloseTo(2 / 3);
    expect(refund).toMatchObject({ calls: 1, errors: 1 });
    expect(metrics.byTool[0]?.tool).toBe('search'); // sorted by calls desc
  });

  it('preserves the compatibility client mix from legacy initialize events', () => {
    const metrics = aggregateRequestEvents([
      init('claude-ai'),
      init('claude-ai'),
      init('chatgpt'),
      event({}), // tools/call without client info must not affect the mix
    ]);
    expect(metrics.byClient).toEqual([
      { client: 'claude-ai', sessions: 2, share: 2 / 3 },
      { client: 'chatgpt', sessions: 1, share: 1 / 3 },
    ]);
  });

  it('keeps a self-reported app name separate from named legacy handshakes', () => {
    const metrics = aggregateRequestEvents([
      ...Array.from({ length: 5 }, () =>
        event({
          method: 'initialize',
          kind: 'discovery',
          protocolEra: 'legacy',
          clientName: 'MCPJam Inspector',
        }),
      ),
      ...Array.from({ length: 2 }, () =>
        event({
          method: 'initialize',
          kind: 'discovery',
          protocolEra: 'legacy',
          clientName: 'codex-mcp-client',
        }),
      ),
      ...Array.from({ length: 44 }, () =>
        event({
          protocolEra: 'modern',
          clientName: 'Investment Calculator',
          clientFamily: 'investment-calculator',
        }),
      ),
      event({ method: 'assistant', clientName: 'noodle-assistant' }),
    ]);

    expect(metrics.clientActivity).toEqual({
      callers: [
        {
          family: 'investment-calculator',
          attribution: 'self_reported',
          reportedName: 'Investment Calculator',
          requests: 44,
          errors: 0,
          share: 1,
          lastSuccessfulAt: '2026-07-05T10:00:00.000Z',
          protocolEras: { legacy: 0, modern: 44, unknown: 0 },
        },
      ],
      legacyHandshakes: {
        total: 7,
        byReportedClient: [
          {
            reportedName: 'MCPJam Inspector',
            initializations: 5,
            share: 5 / 7,
            lastInitializedAt: '2026-07-05T10:00:00.000Z',
          },
          {
            reportedName: 'codex-mcp-client',
            initializations: 2,
            share: 2 / 7,
            lastInitializedAt: '2026-07-05T10:00:00.000Z',
          },
        ],
      },
    });
  });

  it('folds known client aliases while keeping transport-only and missing evidence explicit', () => {
    const metrics = aggregateRequestEvents([
      event({
        protocolEra: 'modern',
        clientName: 'openai-mcp',
        clientFamily: 'openai-mcp',
      }),
      event({
        protocolEra: 'modern',
        clientName: 'openai-mcp (Codex)',
        clientFamily: 'openai-mcp-codex',
      }),
      event({
        protocolEra: 'modern',
        clientName: 'MCPJam Inspector',
        clientFamily: 'mcpjam-inspector',
      }),
      event({ protocolEra: 'modern' }),
      event({ protocolEra: 'modern', clientFamily: 'undici' }),
      event({ protocolEra: 'legacy', clientFamily: 'other', outcome: 'mcp_error' }),
    ]);

    expect(metrics.clientActivity.callers).toEqual([
      {
        family: 'openai-mcp',
        attribution: 'known_client',
        requests: 2,
        errors: 0,
        share: 2 / 6,
        lastSuccessfulAt: '2026-07-05T10:00:00.000Z',
        protocolEras: { legacy: 0, modern: 2, unknown: 0 },
      },
      {
        family: 'mcpjam',
        attribution: 'known_client',
        requests: 1,
        errors: 0,
        share: 1 / 6,
        lastSuccessfulAt: '2026-07-05T10:00:00.000Z',
        protocolEras: { legacy: 0, modern: 1, unknown: 0 },
      },
      {
        family: 'other',
        attribution: 'transport_only',
        requests: 1,
        errors: 1,
        share: 1 / 6,
        protocolEras: { legacy: 1, modern: 0, unknown: 0 },
      },
      {
        family: 'undici',
        attribution: 'transport_only',
        requests: 1,
        errors: 0,
        share: 1 / 6,
        lastSuccessfulAt: '2026-07-05T10:00:00.000Z',
        protocolEras: { legacy: 0, modern: 1, unknown: 0 },
      },
      {
        family: 'unknown',
        attribution: 'unattributed',
        requests: 1,
        errors: 0,
        share: 1 / 6,
        lastSuccessfulAt: '2026-07-05T10:00:00.000Z',
        protocolEras: { legacy: 0, modern: 1, unknown: 0 },
      },
    ]);
  });

  it('computes cross-era client activity with last success and explicit era evidence', () => {
    const metrics = aggregateRequestEvents([
      event({
        createdAt: '2026-07-05T10:00:00.000Z',
        method: 'initialize',
        kind: 'usage',
        protocolEra: 'legacy',
        clientName: 'claude-ai',
        clientFamily: 'claude-ai',
      }),
      event({
        createdAt: '2026-07-05T10:01:00.000Z',
        protocolEra: 'legacy',
        clientFamily: 'claude-ai',
        toolName: 'search',
        outputTokensEst: 10,
      }),
      event({
        createdAt: '2026-07-05T10:03:00.000Z',
        protocolEra: 'legacy',
        clientFamily: 'claude-ai',
        toolName: 'search',
        outcome: 'tool_error',
      }),
      event({
        createdAt: '2026-07-05T10:02:00.000Z',
        protocolEra: 'modern',
        clientFamily: 'modern-console',
        toolName: 'search',
      }),
      event({ createdAt: '2026-07-05T10:04:00.000Z', toolName: 'search' }),
      event({ method: 'tools/list', kind: 'discovery', clientFamily: 'modern-console' }),
    ]);

    expect(metrics.totals).toEqual({
      requests: 4,
      sessions: 1,
      legacyInitializations: 1,
      toolCalls: 4,
      discovery: 2,
    });
    expect(metrics.byClient).toEqual([{ client: 'claude-ai', sessions: 1, share: 1 }]);
    expect(metrics.byClientFamily).toEqual([
      {
        family: 'claude-ai',
        requests: 2,
        errors: 1,
        share: 0.5,
        lastSuccessfulAt: '2026-07-05T10:01:00.000Z',
        protocolEras: { legacy: 2, modern: 0, unknown: 0 },
      },
      {
        family: 'modern-console',
        requests: 1,
        errors: 0,
        share: 0.25,
        lastSuccessfulAt: '2026-07-05T10:02:00.000Z',
        protocolEras: { legacy: 0, modern: 1, unknown: 0 },
      },
      {
        family: 'unknown',
        requests: 1,
        errors: 0,
        share: 0.25,
        lastSuccessfulAt: '2026-07-05T10:04:00.000Z',
        protocolEras: { legacy: 0, modern: 0, unknown: 1 },
      },
    ]);
  });

  it('excludes a modern initialize-shaped event without counting a legacy initialization', () => {
    const metrics = aggregateRequestEvents([
      event({ method: 'initialize', kind: 'usage', protocolEra: 'modern' }),
      event({ protocolEra: 'modern', clientFamily: 'modern-console' }),
    ]);

    expect(metrics.totals).toMatchObject({
      requests: 1,
      sessions: 0,
      legacyInitializations: 0,
      discovery: 1,
    });
  });

  it('sums the output-token estimates', () => {
    const metrics = aggregateRequestEvents([
      event({ outputTokensEst: 100 }),
      event({ outputTokensEst: 50 }),
      event({}),
    ]);
    expect(metrics.tokens.total).toBe(150);
    expect(metrics.tokens.avgPerCall).toBe(50);
  });

  it('buckets the series by hour', () => {
    const metrics = aggregateRequestEvents([
      event({ createdAt: '2026-07-05T10:05:00.000Z' }),
      event({ createdAt: '2026-07-05T10:55:00.000Z', outcome: 'tool_error' }),
      event({ createdAt: '2026-07-05T11:05:00.000Z' }),
    ]);
    expect(metrics.series).toEqual([
      { bucketStart: '2026-07-05T10:00:00.000Z', requests: 2, toolErrors: 1, mcpErrors: 0 },
      { bucketStart: '2026-07-05T11:00:00.000Z', requests: 1, toolErrors: 0, mcpErrors: 0 },
    ]);
  });

  it('returns a stable empty shape for no events', () => {
    const metrics = aggregateRequestEvents([]);
    expect(metrics.totals).toEqual({
      requests: 0,
      sessions: 0,
      legacyInitializations: 0,
      toolCalls: 0,
      discovery: 0,
    });
    expect(metrics.latency.p95Ms).toBe(0);
    expect(metrics.byTool).toEqual([]);
    expect(metrics.series).toEqual([]);
  });
});
