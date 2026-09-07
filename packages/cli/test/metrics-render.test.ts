import { describe, expect, it } from 'vitest';
import {
  type EventRecord,
  type MetricsData,
  renderEventRow,
  renderEventsHeader,
  renderEventsSummary,
  renderLiveFooter,
  renderMetricsReport,
} from '../src/metrics-render.js';

const METRICS: MetricsData = {
  totals: {
    requests: 12480,
    sessions: 1204,
    legacyInitializations: 1204,
    toolCalls: 11210,
    discovery: 3200,
  },
  errors: {
    toolErrors: 224,
    mcpErrors: 62,
    toolErrorRate: 0.018,
    mcpErrorRate: 0.005,
    errorRate: 0.023,
  },
  latency: { avgMs: 145, p50Ms: 90, p95Ms: 340, p99Ms: 1200 },
  tokens: { total: 1048320, avgPerCall: 84 },
  byTool: [
    { tool: 'search_orders', calls: 4210, errors: 0, share: 0.34, p95Ms: 120 },
    { tool: 'refund_order', calls: 980, errors: 78, share: 0.08, p95Ms: 500 },
  ],
  byClient: [
    { client: 'chatgpt', sessions: 626, share: 0.52 },
    { client: 'claude-ai', sessions: 373, share: 0.31 },
  ],
  byClientFamily: [
    {
      family: 'chatgpt',
      requests: 6490,
      errors: 80,
      share: 0.52,
      lastSuccessfulAt: '2026-07-05T11:00:00.000Z',
      protocolEras: { legacy: 1100, modern: 5390, unknown: 0 },
    },
    {
      family: 'claude-ai',
      requests: 3869,
      errors: 120,
      share: 0.31,
      lastSuccessfulAt: '2026-07-05T10:58:00.000Z',
      protocolEras: { legacy: 3869, modern: 0, unknown: 0 },
    },
  ],
  clientActivity: {
    callers: [
      {
        family: 'openai-mcp',
        attribution: 'known_client',
        requests: 6490,
        errors: 80,
        share: 0.52,
        lastSuccessfulAt: '2026-07-05T11:00:00.000Z',
        protocolEras: { legacy: 1100, modern: 5390, unknown: 0 },
      },
      {
        family: 'claude',
        attribution: 'known_client',
        requests: 3869,
        errors: 120,
        share: 0.31,
        lastSuccessfulAt: '2026-07-05T10:58:00.000Z',
        protocolEras: { legacy: 3869, modern: 0, unknown: 0 },
      },
      {
        family: 'investment-calculator',
        attribution: 'self_reported',
        reportedName: 'Investment Calculator',
        requests: 1498,
        errors: 0,
        share: 0.12,
        lastSuccessfulAt: '2026-07-05T10:55:00.000Z',
        protocolEras: { legacy: 0, modern: 1498, unknown: 0 },
      },
      {
        family: 'other',
        attribution: 'transport_only',
        requests: 374,
        errors: 0,
        share: 0.03,
        lastSuccessfulAt: '2026-07-05T10:54:00.000Z',
        protocolEras: { legacy: 374, modern: 0, unknown: 0 },
      },
      {
        family: 'unknown',
        attribution: 'unattributed',
        requests: 249,
        errors: 249,
        share: 0.02,
        protocolEras: { legacy: 0, modern: 0, unknown: 249 },
      },
    ],
    legacyHandshakes: {
      total: 1204,
      byReportedClient: [
        {
          reportedName: 'MCPJam Inspector',
          initializations: 5,
          share: 0.004,
          lastInitializedAt: '2026-07-05T10:57:00.000Z',
        },
        {
          reportedName: 'codex-mcp-client',
          initializations: 1199,
          share: 0.996,
          lastInitializedAt: '2026-07-05T10:56:00.000Z',
        },
      ],
    },
  },
  byMethod: [
    { method: 'tools/call', requests: 9734, share: 0.78 },
    { method: 'resources/read', requests: 1747, share: 0.14 },
  ],
  series: [
    { bucketStart: '2026-07-05T09:00:00.000Z', requests: 40, toolErrors: 1, mcpErrors: 0 },
    { bucketStart: '2026-07-05T10:00:00.000Z', requests: 90, toolErrors: 2, mcpErrors: 1 },
  ],
};

const CONTEXT = { org: 'acme', app: 'support', env: 'prod', windowLabel: 'last 7 days' };
const PLAIN = { color: 'none', glyph: 'unicode' } as const;
const ASCII = { color: 'none', glyph: 'ascii' } as const;
const TRUECOLOR = { color: 'truecolor', glyph: 'unicode' } as const;

describe('renderMetricsReport', () => {
  it('renders the full plain report with KPI line, sections, and tool table', () => {
    const text = renderMetricsReport(CONTEXT, METRICS, PLAIN).join('\n');
    expect(text).toContain('noodle metrics');
    expect(text).toContain('acme/support · prod · last 7 days');
    expect(text).toContain('12,480 requests');
    expect(text).toContain('11,210 tool calls');
    expect(text).toContain('2.3% errors');
    expect(text).toContain('340ms p95');
    expect(text).toContain('p50 90ms');
    expect(text).toContain('p99 1.2s');
    expect(text).toContain('tool 1.8%');
    expect(text).toContain('mcp 0.5%');
    expect(text).toContain('84 avg/call');
    expect(text).toContain('search_orders');
    expect(text).toContain('4,210');
    expect(text).toContain('34%');
    expect(text).toContain('OpenAI MCP 52% · 6,490 requests · mixed');
    expect(text).toContain('Unidentified modern caller 12% · 1,498 requests');
    expect(text).toContain('reported itself as “Investment Calculator”');
    expect(text).toContain('Unrecognized connection software 3.0% · 374 requests');
    expect(text).toContain('No usable client metadata');
    expect(text).toContain('legacy handshakes 1,204');
    expect(text).toContain('MCPJam Inspector 5 handshakes');
    expect(text).not.toMatch(/\bunknown\b/i);
    expect(text).not.toMatch(/\bother\b/i);
    expect(text).not.toContain('sessions');
    expect(text).toContain('tools/call 78%');
    expect(text).toContain('(discovery excluded)');
  });

  it('nudges toward a tool with an elevated error share', () => {
    const text = renderMetricsReport(CONTEXT, METRICS, PLAIN).join('\n');
    expect(text).toContain('refund_order');
    expect(text).toContain('noodle events --tool refund_order');
  });

  it('omits the nudge when every tool is healthy', () => {
    const healthy: MetricsData = {
      ...METRICS,
      byTool: [{ tool: 'search_orders', calls: 100, errors: 0, share: 1, p95Ms: 90 }],
    };
    const text = renderMetricsReport(CONTEXT, healthy, PLAIN).join('\n');
    expect(text).not.toContain('noodle events --tool');
  });

  it('renders an actionable empty state for zero traffic', () => {
    const empty: MetricsData = {
      totals: {
        requests: 0,
        sessions: 0,
        legacyInitializations: 0,
        toolCalls: 0,
        discovery: 0,
      },
      errors: { toolErrors: 0, mcpErrors: 0, toolErrorRate: 0, mcpErrorRate: 0, errorRate: 0 },
      latency: { avgMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 },
      tokens: { total: 0, avgPerCall: 0 },
      byTool: [],
      byClient: [],
      byClientFamily: [],
      clientActivity: { callers: [], legacyHandshakes: { total: 0, byReportedClient: [] } },
      byMethod: [],
      series: [],
    };
    const text = renderMetricsReport(CONTEXT, empty, PLAIN).join('\n');
    expect(text).toContain('No traffic yet');
    expect(text).toContain('noodle connect');
  });

  it('does not relabel initialization client names when activity data is unavailable', () => {
    const { clientActivity: _clientActivity, ...olderServiceMetrics } = METRICS;
    const text = renderMetricsReport(CONTEXT, olderServiceMetrics, PLAIN).join('\n');

    expect(text).toContain('client activity unavailable from this service version');
    expect(text).not.toContain('OpenAI MCP 52%');
  });

  it('distinguishes initialization-only traffic from client activity', () => {
    const text = renderMetricsReport(
      CONTEXT,
      {
        ...METRICS,
        totals: {
          requests: 0,
          sessions: 2,
          legacyInitializations: 2,
          toolCalls: 0,
          discovery: 2,
        },
        byTool: [],
        byClientFamily: [],
        clientActivity: {
          callers: [],
          legacyHandshakes: {
            total: 2,
            byReportedClient: [
              {
                reportedName: 'MCPJam Inspector',
                initializations: 2,
                share: 1,
                lastInitializedAt: '2026-07-05T10:57:00.000Z',
              },
            ],
          },
        },
        byMethod: [],
        series: [],
      },
      PLAIN,
    ).join('\n');

    expect(text).toContain('No client activity yet');
    expect(text).toContain('2 legacy initializations');
    expect(text).not.toContain('No traffic yet');
  });

  it('emits zero escape codes in plain mode and real ANSI in truecolor', () => {
    const plain = renderMetricsReport(CONTEXT, METRICS, PLAIN).join('\n');
    expect(plain).not.toContain('[');
    const colored = renderMetricsReport(CONTEXT, METRICS, TRUECOLOR).join('\n');
    expect(colored).toContain('[38;2;');
    expect(colored).toContain('[0m');
  });

  it('pluralizes the KPI nouns correctly at one', () => {
    const single: MetricsData = {
      ...METRICS,
      totals: {
        requests: 1,
        sessions: 1,
        legacyInitializations: 1,
        toolCalls: 1,
        discovery: 1,
      },
    };
    const text = renderMetricsReport(CONTEXT, single, PLAIN).join('\n');
    expect(text).toContain('1 request ');
    expect(text).toContain('1 tool call ');
    expect(text).not.toContain('1 requests');
    expect(text).not.toContain('1 tool calls');
  });

  it('falls back to ascii glyphs when unicode is unsafe', () => {
    const text = renderMetricsReport(CONTEXT, METRICS, ASCII).join('\n');
    expect(text).not.toContain('█');
    expect(text).not.toContain('▂');
    expect(text).not.toContain('◆');
  });
});

describe('event stream rendering', () => {
  const OK: EventRecord = {
    id: 'e1',
    createdAt: '2026-07-05T09:41:12.000Z',
    method: 'tools/call',
    toolName: 'search_orders',
    clientName: 'chatgpt',
    outcome: 'ok',
    durationMs: 88,
  };
  const TOOL_ERR: EventRecord = {
    ...OK,
    id: 'e2',
    toolName: 'refund_order',
    outcome: 'tool_error',
    errorKind: 'connector_error',
    durationMs: 140,
  };
  const MCP_ERR: EventRecord = {
    ...OK,
    id: 'e3',
    toolName: 'get_status',
    outcome: 'mcp_error',
    errorKind: 'timeout',
    durationMs: 1400,
  };

  it('renders aligned rows with outcome glyphs and error kinds', () => {
    const header = renderEventsHeader(PLAIN);
    const ok = renderEventRow(OK, PLAIN);
    const toolErr = renderEventRow(TOOL_ERR, PLAIN);
    const mcpErr = renderEventRow(MCP_ERR, PLAIN);
    expect(header).toContain('time');
    expect(header).toContain('tool');
    expect(ok).toContain('09:41:12');
    expect(ok).toContain('✔ ok');
    expect(ok).toContain('search_orders');
    expect(ok).toContain('88ms');
    expect(toolErr).toContain('⚠ tool');
    expect(toolErr).toContain('connector_error');
    expect(mcpErr).toContain('✗ mcp');
    expect(mcpErr).toContain('timeout');
    expect(mcpErr).toContain('1.4s');
  });

  it('summarizes outcome counts', () => {
    const text = renderEventsSummary({ ok: 96, toolErrors: 3, mcpErrors: 1 }, PLAIN);
    expect(text).toContain('✔ 96');
    expect(text).toContain('⚠ 3 tool');
    expect(text).toContain('✗ 1 mcp');
  });

  it('truncates long client/method/tool names so columns stay aligned', () => {
    const long: EventRecord = {
      ...OK,
      clientName: 'a-very-long-client-name',
      method: 'resources/templates/list',
      toolName: 'an_extremely_long_tool_name_that_overflows',
    };
    const row = renderEventRow(long, PLAIN);
    const short = renderEventRow(OK, PLAIN);
    // Same width up to the duration column regardless of name lengths.
    expect(row.indexOf('88ms')).toBe(short.indexOf('88ms'));
    expect(row).toContain('\u2026');
    expect(row).not.toContain('an_extremely_long_tool_name_that_overflows');
  });

  it('renders the live tail footer', () => {
    const text = renderLiveFooter('acme/support · prod', PLAIN);
    expect(text).toContain('live');
    expect(text).toContain('^C to stop');
  });

  it('never emits escapes in plain mode', () => {
    expect(renderEventRow(TOOL_ERR, PLAIN)).not.toContain('[');
    expect(renderEventRow(TOOL_ERR, TRUECOLOR)).toContain('[38;2;');
  });
});
