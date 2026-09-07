import type { RequestEvent } from '@noodle-borg/module';

/**
 * Pure aggregation over the tenant analytics stream (ADR 0121 Stage B): turns a window of
 * {@link RequestEvent}s into the metrics the CLI and Console render. Discovery events (`*​/list`,
 * `ping`, and legacy `initialize`) are excluded from cross-era activity numbers. The legacy
 * initialization count remains as a protocol diagnostic and hidden compatibility projection.
 * Node-side aggregation is deliberate for Stage B scale; pre-aggregated rollups are Stage F.
 */
export interface RequestMetrics {
  readonly totals: {
    readonly requests: number;
    /** @deprecated Legacy initialize count retained for older wire clients. */
    readonly sessions: number;
    readonly legacyInitializations: number;
    readonly toolCalls: number;
    readonly discovery: number;
  };
  readonly errors: {
    readonly ok: number;
    readonly toolErrors: number;
    readonly mcpErrors: number;
    readonly toolErrorRate: number;
    readonly mcpErrorRate: number;
    readonly errorRate: number;
  };
  readonly latency: {
    readonly avgMs: number;
    readonly p50Ms: number;
    readonly p95Ms: number;
    readonly p99Ms: number;
  };
  readonly tokens: { readonly total: number; readonly avgPerCall: number };
  readonly byTool: readonly ToolMetrics[];
  readonly byClient: readonly ClientMetrics[];
  readonly byClientFamily: readonly ClientFamilyMetrics[];
  readonly clientActivity: ClientActivityMetrics;
  readonly byMethod: readonly MethodMetrics[];
  readonly series: readonly SeriesBucket[];
}

export interface ToolMetrics {
  readonly tool: string;
  readonly calls: number;
  readonly errors: number;
  readonly share: number;
  readonly p95Ms: number;
}

export interface ClientMetrics {
  readonly client: string;
  readonly sessions: number;
  readonly share: number;
}

export type CallerAttribution =
  | 'known_client'
  | 'self_reported'
  | 'transport_only'
  | 'unattributed';

export interface CallerActivityMetrics {
  readonly family: string;
  readonly attribution: CallerAttribution;
  readonly reportedName?: string;
  readonly requests: number;
  readonly errors: number;
  readonly share: number;
  readonly lastSuccessfulAt?: string;
  readonly protocolEras: {
    readonly legacy: number;
    readonly modern: number;
    readonly unknown: number;
  };
}

export interface LegacyHandshakeMetrics {
  readonly reportedName?: string;
  readonly initializations: number;
  readonly share: number;
  readonly lastInitializedAt: string;
}

export interface ClientActivityMetrics {
  readonly callers: readonly CallerActivityMetrics[];
  readonly legacyHandshakes: {
    readonly total: number;
    readonly byReportedClient: readonly LegacyHandshakeMetrics[];
  };
}

/** Cross-era activity breakdown by bounded client family (#1309). Discovery and initialize are
 * excluded, while failures and unattributed traffic stay separable from named clients. */
export interface ClientFamilyMetrics {
  readonly family: string;
  readonly requests: number;
  readonly errors: number;
  readonly share: number;
  readonly lastSuccessfulAt?: string;
  readonly protocolEras: {
    readonly legacy: number;
    readonly modern: number;
    readonly unknown: number;
  };
}

export interface MethodMetrics {
  readonly method: string;
  readonly requests: number;
  readonly share: number;
}

export interface SeriesBucket {
  readonly bucketStart: string;
  readonly requests: number;
  readonly toolErrors: number;
  readonly mcpErrors: number;
}

interface MutableClientFamilyMetrics {
  requests: number;
  errors: number;
  lastSuccessfulAt?: string;
  protocolEras: { legacy: number; modern: number; unknown: number };
}

interface MutableCallerActivityMetrics extends MutableClientFamilyMetrics {
  family: string;
  attribution: CallerAttribution;
  reportedName?: string;
}

interface MutableLegacyHandshakeMetrics {
  initializations: number;
  lastInitializedAt: string;
}

const KNOWN_CLIENT_FAMILIES = new Map<string, string>([
  ['chatgpt', 'openai-mcp'],
  ['openai', 'openai-mcp'],
  ['openai-mcp', 'openai-mcp'],
  ['openai-mcp-codex', 'openai-mcp'],
  ['claude', 'claude'],
  ['claude-ai', 'claude'],
  ['claude-desktop', 'claude'],
  ['codex', 'codex'],
  ['codex-mcp-client', 'codex'],
  ['mcpjam', 'mcpjam'],
  ['mcpjam-inspector', 'mcpjam'],
  ['mcp-inspector', 'mcp-inspector'],
  ['noodle-console', 'noodle-console'],
]);

function familyToken(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const token = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return token.length === 0 ? undefined : token;
}

function callerIdentity(event: RequestEvent): {
  readonly family: string;
  readonly attribution: CallerAttribution;
  readonly reportedName?: string;
} {
  const observedFamily = event.clientFamily ?? familyToken(event.clientName) ?? 'unknown';
  const knownFamily = KNOWN_CLIENT_FAMILIES.get(observedFamily);
  if (knownFamily !== undefined) {
    return { family: knownFamily, attribution: 'known_client' };
  }
  if (event.clientName !== undefined) {
    return {
      family: observedFamily,
      attribution: 'self_reported',
      reportedName: event.clientName,
    };
  }
  if (observedFamily === 'unknown') {
    return { family: observedFamily, attribution: 'unattributed' };
  }
  return { family: observedFamily, attribution: 'transport_only' };
}

/** Nearest-rank percentile over an already-sorted ascending array; 0 when empty. */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1] ?? 0;
}

/** Truncate an ISO timestamp to its UTC hour bucket. */
function hourBucket(iso: string): string {
  return `${iso.slice(0, 13)}:00:00.000Z`;
}

export function aggregateRequestEvents(events: readonly RequestEvent[]): RequestMetrics {
  // Assistant lifecycle records share the durable tenant stream but have their own aggregate. Keep
  // the long-standing MCP metrics contract stable rather than counting one user turn as an MCP call.
  const mcpEvents = events.filter((event) => event.method !== 'assistant');
  // Normalize by method as well as the stored kind so retained pre-change initialize events do not
  // distort the common legacy/modern activity denominator.
  const legacyInitializations = mcpEvents.filter(
    (event) => event.method === 'initialize' && event.protocolEra !== 'modern',
  );
  const usage = mcpEvents.filter(
    (event) => event.kind === 'usage' && event.method !== 'initialize',
  );
  const discovery = mcpEvents.length - usage.length;
  const durations = usage.map((e) => e.durationMs).sort((a, b) => a - b);

  let ok = 0;
  let toolErrors = 0;
  let mcpErrors = 0;
  let toolCalls = 0;
  let tokensTotal = 0;
  const byTool = new Map<string, { calls: number; errors: number; durations: number[] }>();
  const byClient = new Map<string, number>();
  const byClientFamily = new Map<string, MutableClientFamilyMetrics>();
  const callers = new Map<string, MutableCallerActivityMetrics>();
  const handshakes = new Map<string | undefined, MutableLegacyHandshakeMetrics>();
  const byMethod = new Map<string, number>();
  const series = new Map<string, { requests: number; toolErrors: number; mcpErrors: number }>();

  for (const event of legacyInitializations) {
    const client = event.clientName ?? 'other';
    byClient.set(client, (byClient.get(client) ?? 0) + 1);
    const handshake = handshakes.get(event.clientName) ?? {
      initializations: 0,
      lastInitializedAt: event.createdAt,
    };
    handshake.initializations += 1;
    if (event.createdAt > handshake.lastInitializedAt) {
      handshake.lastInitializedAt = event.createdAt;
    }
    handshakes.set(event.clientName, handshake);
  }

  for (const event of usage) {
    if (event.outcome === 'ok') ok += 1;
    else if (event.outcome === 'tool_error') toolErrors += 1;
    else mcpErrors += 1;

    byMethod.set(event.method, (byMethod.get(event.method) ?? 0) + 1);

    const family = event.clientFamily ?? 'unknown';
    const familyRow = byClientFamily.get(family) ?? {
      requests: 0,
      errors: 0,
      protocolEras: { legacy: 0, modern: 0, unknown: 0 },
    };
    familyRow.requests += 1;
    if (event.outcome !== 'ok') familyRow.errors += 1;
    const era = event.protocolEra ?? 'unknown';
    familyRow.protocolEras[era] += 1;
    if (
      event.outcome === 'ok' &&
      (familyRow.lastSuccessfulAt === undefined || event.createdAt > familyRow.lastSuccessfulAt)
    ) {
      familyRow.lastSuccessfulAt = event.createdAt;
    }
    byClientFamily.set(family, familyRow);

    const identity = callerIdentity(event);
    const callerKey = `${identity.attribution}:${identity.family}`;
    const callerRow = callers.get(callerKey) ?? {
      family: identity.family,
      attribution: identity.attribution,
      ...(identity.reportedName === undefined ? {} : { reportedName: identity.reportedName }),
      requests: 0,
      errors: 0,
      protocolEras: { legacy: 0, modern: 0, unknown: 0 },
    };
    callerRow.requests += 1;
    if (event.outcome !== 'ok') callerRow.errors += 1;
    callerRow.protocolEras[era] += 1;
    if (
      event.outcome === 'ok' &&
      (callerRow.lastSuccessfulAt === undefined || event.createdAt > callerRow.lastSuccessfulAt)
    ) {
      callerRow.lastSuccessfulAt = event.createdAt;
    }
    callers.set(callerKey, callerRow);

    if (event.toolName !== undefined) {
      toolCalls += 1;
      const tool = byTool.get(event.toolName) ?? { calls: 0, errors: 0, durations: [] };
      tool.calls += 1;
      if (event.outcome !== 'ok') tool.errors += 1;
      tool.durations.push(event.durationMs);
      byTool.set(event.toolName, tool);
    }
    if (event.outputTokensEst !== undefined) tokensTotal += event.outputTokensEst;

    const bucketStart = hourBucket(event.createdAt);
    const bucket = series.get(bucketStart) ?? { requests: 0, toolErrors: 0, mcpErrors: 0 };
    bucket.requests += 1;
    if (event.outcome === 'tool_error') bucket.toolErrors += 1;
    if (event.outcome === 'mcp_error') bucket.mcpErrors += 1;
    series.set(bucketStart, bucket);
  }

  const total = usage.length;
  const sessions = legacyInitializations.length;
  const rate = (n: number): number => (total === 0 ? 0 : n / total);
  return {
    totals: {
      requests: total,
      sessions,
      legacyInitializations: sessions,
      toolCalls,
      discovery,
    },
    errors: {
      ok,
      toolErrors,
      mcpErrors,
      toolErrorRate: rate(toolErrors),
      mcpErrorRate: rate(mcpErrors),
      errorRate: rate(toolErrors + mcpErrors),
    },
    latency: {
      avgMs: total === 0 ? 0 : durations.reduce((a, b) => a + b, 0) / total,
      p50Ms: percentile(durations, 50),
      p95Ms: percentile(durations, 95),
      p99Ms: percentile(durations, 99),
    },
    // avg is over every usage call (a call with no output still dilutes it — it's a bloat gauge).
    tokens: { total: tokensTotal, avgPerCall: total === 0 ? 0 : tokensTotal / total },
    byTool: [...byTool.entries()]
      .map(([tool, t]) => ({
        tool,
        calls: t.calls,
        errors: t.errors,
        share: toolCalls === 0 ? 0 : t.calls / toolCalls,
        p95Ms: percentile(
          t.durations.slice().sort((a, b) => a - b),
          95,
        ),
      }))
      .sort((a, b) => b.calls - a.calls),
    byClient: [...byClient.entries()]
      .map(([client, count]) => ({
        client,
        sessions: count,
        share: sessions === 0 ? 0 : count / sessions,
      }))
      .sort((a, b) => b.sessions - a.sessions),
    byClientFamily: [...byClientFamily.entries()]
      .map(([family, row]) => ({
        family,
        requests: row.requests,
        errors: row.errors,
        share: rate(row.requests),
        ...(row.lastSuccessfulAt === undefined ? {} : { lastSuccessfulAt: row.lastSuccessfulAt }),
        protocolEras: { ...row.protocolEras },
      }))
      .sort((a, b) => b.requests - a.requests || a.family.localeCompare(b.family)),
    clientActivity: {
      callers: [...callers.entries()]
        .map(([, row]) => ({
          family: row.family,
          attribution: row.attribution,
          ...(row.reportedName === undefined ? {} : { reportedName: row.reportedName }),
          requests: row.requests,
          errors: row.errors,
          share: rate(row.requests),
          ...(row.lastSuccessfulAt === undefined ? {} : { lastSuccessfulAt: row.lastSuccessfulAt }),
          protocolEras: { ...row.protocolEras },
        }))
        .sort(
          (a, b) =>
            b.requests - a.requests ||
            a.family.localeCompare(b.family) ||
            a.attribution.localeCompare(b.attribution),
        ),
      legacyHandshakes: {
        total: sessions,
        byReportedClient: [...handshakes.entries()]
          .map(([reportedName, row]) => ({
            ...(reportedName === undefined ? {} : { reportedName }),
            initializations: row.initializations,
            share: sessions === 0 ? 0 : row.initializations / sessions,
            lastInitializedAt: row.lastInitializedAt,
          }))
          .sort(
            (a, b) =>
              b.initializations - a.initializations ||
              (a.reportedName ?? '').localeCompare(b.reportedName ?? ''),
          ),
      },
    },
    byMethod: [...byMethod.entries()]
      .map(([method, requests]) => ({ method, requests, share: rate(requests) }))
      .sort((a, b) => b.requests - a.requests),
    series: [...series.entries()]
      .map(([bucketStart, bucket]) => ({ bucketStart, ...bucket }))
      .sort((a, b) => a.bucketStart.localeCompare(b.bucketStart)),
  };
}
