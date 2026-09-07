import { type ColorMode, cyclic, type GlyphMode, paint, type RGB } from './gradient.js';

/**
 * Pure renderers for the analytics surfaces (`noodle metrics` / `noodle events`), Direction A —
 * the typographic report: masthead, KPI line, latency/errors/tokens/volume block, gradient share
 * bars, client/method mix, and an actionable nudge. The warm cyclic gradient encodes data (bars,
 * sparkline) and the two-tier error model maps onto the existing glyph semantics: amber ⚠ tool-error
 * (recoverable) vs rose ✗ mcp-error (needs attention). Inputs → strings only; callers own streams,
 * `--json` gating, and capability detection, so every function degrades to plain text under
 * `color: 'none'` and ASCII glyphs under `glyph: 'ascii'`.
 */

export interface RenderOptions {
  readonly color: ColorMode;
  readonly glyph: GlyphMode;
  /** Report width for the masthead right-alignment. Default 78. */
  readonly width?: number;
}

export interface MetricsData {
  readonly totals: {
    readonly requests: number;
    /** @deprecated Wire compatibility for legacy initialization-session counts. */
    readonly sessions: number;
    /** Legacy initialize handshakes, excluded from activity request metrics. */
    readonly legacyInitializations?: number;
    readonly toolCalls: number;
    readonly discovery: number;
  };
  readonly errors: {
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
  readonly byTool: readonly {
    readonly tool: string;
    readonly calls: number;
    readonly errors: number;
    readonly share: number;
    readonly p95Ms: number;
  }[];
  readonly byClient: readonly {
    readonly client: string;
    readonly sessions: number;
    readonly share: number;
  }[];
  /** Canonical bounded per-request client activity; absent from older services. */
  readonly byClientFamily?: readonly {
    readonly family: string;
    readonly requests: number;
    readonly errors: number;
    readonly share: number;
    readonly lastSuccessfulAt?: string;
    readonly protocolEras?: {
      readonly legacy: number;
      readonly modern: number;
      readonly unknown: number;
    };
  }[];
  /** Evidence-aware caller activity and legacy handshake diagnostics; absent from older services. */
  readonly clientActivity?: {
    readonly callers: readonly {
      readonly family: string;
      readonly attribution: 'known_client' | 'self_reported' | 'transport_only' | 'unattributed';
      readonly reportedName?: string;
      readonly requests: number;
      readonly errors: number;
      readonly share: number;
      readonly lastSuccessfulAt?: string;
      readonly protocolEras?: {
        readonly legacy: number;
        readonly modern: number;
        readonly unknown: number;
      };
    }[];
    readonly legacyHandshakes: {
      readonly total: number;
      readonly byReportedClient: readonly {
        readonly reportedName?: string;
        readonly initializations: number;
        readonly share: number;
        readonly lastInitializedAt: string;
      }[];
    };
  };
  readonly byMethod: readonly {
    readonly method: string;
    readonly requests: number;
    readonly share: number;
  }[];
  readonly series: readonly {
    readonly bucketStart: string;
    readonly requests: number;
    readonly toolErrors: number;
    readonly mcpErrors: number;
  }[];
}

export interface EventRecord {
  readonly id?: string;
  readonly createdAt?: string;
  readonly method?: string;
  readonly toolName?: string;
  readonly resourceName?: string;
  readonly promptName?: string;
  readonly clientName?: string;
  readonly clientFamily?: string;
  readonly outcome?: string;
  readonly errorKind?: string;
  readonly durationMs?: number;
  readonly sessionId?: string;
}

export interface MetricsContext {
  readonly org: string;
  readonly app: string;
  readonly env: string;
  readonly windowLabel: string;
}

const GREEN: RGB = [34, 197, 94];
const AMBER: RGB = [245, 158, 11];
const ROSE: RGB = [244, 63, 94];
const DIM: RGB = [115, 115, 115];

const SPARK_UNICODE = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
const SPARK_ASCII = ['.', '.', ':', '-', '=', '+', '*', '#'];
const DEFAULT_WIDTH = 78;
const TOOL_BAR_WIDTH = 12;
const MIX_BAR_WIDTH = 6;
/** A tool whose error share crosses this (with enough calls) earns the trailing nudge line. */
const NUDGE_ERROR_SHARE = 0.05;
const NUDGE_MIN_CALLS = 5;

const num = (n: number): string => n.toLocaleString('en-US');
const pct = (f: number): string => {
  const v = f * 100;
  return `${v >= 10 ? Math.round(v).toString() : v.toFixed(1)}%`;
};
const ms = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`);
const plural = (n: number, word: string): string => `${word}${n === 1 ? '' : 's'}`;

/** Paint each character along the warm cyclic ramp (the wordmark/number/sparkline treatment). */
function gradientText(text: string, opts: RenderOptions): string {
  if (opts.color === 'none') return text;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    out += paint(cyclic(i / Math.max(text.length, 8)), text[i] as string, opts.color);
  }
  return out;
}

/** Filled cell count for a `width`-cell share bar: at least one whenever share is positive. */
function barCells(share: number, width: number): number {
  return Math.max(share > 0 ? 1 : 0, Math.round(share * width));
}

/** A solid share bar whose hue advances along the ramp, `width` cells at 100%. */
function shareBar(share: number, width: number, opts: RenderOptions): string {
  const cells = barCells(share, width);
  const ch = opts.glyph === 'ascii' ? '#' : '█';
  if (opts.color === 'none') return ch.repeat(cells);
  let out = '';
  for (let i = 0; i < cells; i++) out += paint(cyclic(i / width), ch, opts.color);
  return out;
}

function sparkline(series: MetricsData['series'], opts: RenderOptions): string {
  const max = Math.max(...series.map((b) => b.requests), 1);
  const levels = opts.glyph === 'ascii' ? SPARK_ASCII : SPARK_UNICODE;
  let out = '';
  for (let i = 0; i < series.length; i++) {
    const bucket = series[i] as MetricsData['series'][number];
    const level = Math.min(
      levels.length - 1,
      Math.max(0, Math.floor((bucket.requests / max) * (levels.length - 1) + 0.5)),
    );
    const ch = levels[level] as string;
    out += opts.color === 'none' ? ch : paint(cyclic(i / series.length), ch, opts.color);
  }
  return out;
}

const dim = (text: string, opts: RenderOptions): string => paint(DIM, text, opts.color);

function masthead(command: string, context: MetricsContext, opts: RenderOptions): string {
  const mark = opts.glyph === 'ascii' ? '*' : '◆';
  const left = `${mark} ${command}`;
  const right = `${context.org}/${context.app} · ${context.env} · ${context.windowLabel}`;
  const pad = Math.max(2, (opts.width ?? DEFAULT_WIDTH) - left.length - right.length);
  return `${gradientText(mark, opts)} ${command}${' '.repeat(pad)}${dim(right, opts)}`;
}

/** The `noodle metrics` report (Direction A). Returns display lines; caller writes them. */
export function renderMetricsReport(
  context: MetricsContext,
  metrics: MetricsData,
  opts: RenderOptions,
): readonly string[] {
  const lines: string[] = [masthead('noodle metrics', context, opts), ''];
  const initializationCount = legacyInitializationCount(metrics);

  if (metrics.totals.requests === 0) {
    if (initializationCount > 0) {
      lines.push(
        `No client activity yet — ${num(initializationCount)} legacy ${plural(initializationCount, 'initialization')} recorded.`,
        dim('Protocol handshakes are excluded from activity requests.', opts),
      );
      return lines;
    }
    lines.push(
      'No traffic yet — metrics appear as AI clients call this server.',
      `Connect a client: ${dim('noodle connect claude · noodle connect chatgpt', opts)}`,
    );
    return lines;
  }

  const { totals, errors, latency, tokens } = metrics;
  lines.push(
    [
      `${gradientText(num(totals.requests), opts)} ${dim(plural(totals.requests, 'request'), opts)}`,
      `${gradientText(num(totals.toolCalls), opts)} ${dim(plural(totals.toolCalls, 'tool call'), opts)}`,
      `${pct(errors.errorRate)} ${dim('errors', opts)}`,
      `${ms(latency.p95Ms)} ${dim('p95', opts)}`,
    ].join('   '),
    '',
    `${dim('latency', opts)}    p50 ${ms(latency.p50Ms)}    p95 ${ms(latency.p95Ms)}    p99 ${ms(latency.p99Ms)}`,
    `${dim('errors', opts)}     ${paint(AMBER, `${glyphFor('warn', opts)} tool ${pct(errors.toolErrorRate)}`, opts.color)}    ${paint(ROSE, `${glyphFor('fail', opts)} mcp ${pct(errors.mcpErrorRate)}`, opts.color)}`,
    `${dim('tokens', opts)}     ${Math.round(tokens.avgPerCall)} avg/call`,
    `${dim('protocol', opts)}   legacy handshakes ${num(initializationCount)} ${dim('· excluded from activity requests', opts)}`,
  );
  if (metrics.series.length > 1) {
    lines.push(
      `${dim('volume', opts)}     ${sparkline(metrics.series, opts)}  ${dim('· hourly', opts)}`,
    );
  }

  if (metrics.byTool.length > 0) {
    lines.push('', toolTableHeader(metrics, opts));
    for (const tool of metrics.byTool) lines.push(toolRow(tool, metrics, opts));
  }

  const mixes: string[] = [];
  if (metrics.clientActivity === undefined) {
    mixes.push(
      `${dim('clients', opts)}    ${dim('client activity unavailable from this service version', opts)}`,
    );
  } else {
    metrics.clientActivity.callers.forEach((caller, index) => {
      mixes.push(
        `${index === 0 ? `${dim('callers', opts)}    ` : '           '}${callerActivity(caller, opts)}`,
      );
    });
    metrics.clientActivity.legacyHandshakes.byReportedClient.forEach((handshake, index) => {
      mixes.push(
        `${index === 0 ? `${dim('handshakes', opts)} ` : '           '}${legacyHandshakeActivity(handshake)}`,
      );
    });
  }
  if (metrics.byMethod.length > 0) {
    mixes.push(
      `${dim('methods', opts)}    ${metrics.byMethod
        .map((m) => `${m.method} ${pct(m.share)}`)
        .join('   ')}   ${dim('(discovery excluded)', opts)}`,
    );
  }
  if (mixes.length > 0) lines.push('', ...mixes);

  const nudge = worstTool(metrics);
  if (nudge !== undefined) {
    lines.push(
      '',
      `${paint(AMBER, glyphFor('warn', opts), opts.color)} ${nudge.tool} errors elevated (${pct(nudge.errors / nudge.calls)}) — ${dim(`noodle events --tool ${nudge.tool}`, opts)}`,
    );
  }
  return lines;
}

function legacyInitializationCount(metrics: MetricsData): number {
  return metrics.totals.legacyInitializations ?? metrics.totals.sessions;
}

const KNOWN_CLIENT_LABELS: Readonly<Record<string, string>> = {
  'openai-mcp': 'OpenAI MCP',
  claude: 'Claude',
  codex: 'Codex',
  mcpjam: 'MCPJam Inspector',
  'mcp-inspector': 'MCP Inspector',
  'noodle-console': 'Noodle Console',
};

type CallerActivity = NonNullable<MetricsData['clientActivity']>['callers'][number];

function callerActivity(caller: CallerActivity, opts: RenderOptions): string {
  const detail =
    caller.lastSuccessfulAt === undefined
      ? 'no successful request'
      : `last success ${caller.lastSuccessfulAt}`;
  return [
    `${callerLabel(caller)} ${pct(caller.share)}`,
    `${num(caller.requests)} ${plural(caller.requests, 'request')}`,
    protocolEraLabel(caller.protocolEras),
    callerEvidence(caller),
    detail,
    shareBar(caller.share, MIX_BAR_WIDTH, opts),
  ].join(' · ');
}

function callerLabel(caller: CallerActivity): string {
  if (caller.attribution === 'known_client') {
    return KNOWN_CLIENT_LABELS[caller.family] ?? caller.family;
  }
  if (caller.attribution === 'self_reported') {
    const modernOnly =
      caller.protocolEras !== undefined &&
      caller.protocolEras.modern > 0 &&
      caller.protocolEras.legacy === 0 &&
      caller.protocolEras.unknown === 0;
    return modernOnly ? 'Unidentified modern caller' : 'Unidentified caller';
  }
  if (caller.attribution === 'transport_only') return 'Unrecognized connection software';
  return 'Unidentified caller';
}

function callerEvidence(caller: CallerActivity): string {
  if (caller.attribution === 'known_client') return 'recognized client family';
  if (caller.attribution === 'self_reported' && caller.reportedName !== undefined) {
    return `reported itself as “${caller.reportedName}”`;
  }
  if (caller.attribution === 'transport_only') return 'transport metadata only';
  return 'No usable client metadata';
}

function legacyHandshakeActivity(
  handshake: NonNullable<
    MetricsData['clientActivity']
  >['legacyHandshakes']['byReportedClient'][number],
): string {
  const token = handshake.reportedName?.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const label =
    token === 'mcpjam' || token === 'mcpjam-inspector'
      ? 'MCPJam Inspector'
      : token === 'codex' || token === 'codex-mcp-client'
        ? 'Codex'
        : (handshake.reportedName ?? 'Unidentified legacy client');
  return `${label} ${num(handshake.initializations)} ${plural(handshake.initializations, 'handshake')} · last ${handshake.lastInitializedAt}`;
}

function protocolEraLabel(eras: CallerActivity['protocolEras'] | undefined): string {
  if (eras === undefined) return 'era unavailable';
  const known =
    eras.legacy > 0 && eras.modern > 0
      ? 'mixed'
      : eras.legacy > 0
        ? 'legacy'
        : eras.modern > 0
          ? 'modern'
          : 'era unavailable';
  return eras.unknown > 0 && known !== 'era unavailable' ? `${known} + unattributed` : known;
}

function toolTableHeader(metrics: MetricsData, opts: RenderOptions): string {
  const nameWidth = toolNameWidth(metrics);
  return dim(
    `${'tool'.padEnd(nameWidth)}  ${'calls'.padStart(7)}  share${' '.repeat(TOOL_BAR_WIDTH)}  health`,
    opts,
  );
}

function toolRow(
  tool: MetricsData['byTool'][number],
  metrics: MetricsData,
  opts: RenderOptions,
): string {
  const nameWidth = toolNameWidth(metrics);
  const bar = shareBar(tool.share, TOOL_BAR_WIDTH, opts);
  const barPad = ' '.repeat(Math.max(0, TOOL_BAR_WIDTH - barCells(tool.share, TOOL_BAR_WIDTH)));
  // Below 1% error share a tool still reads healthy (amber would be noise); the count stays visible.
  const errShare = tool.calls > 0 ? tool.errors / tool.calls : 0;
  const health =
    tool.errors === 0
      ? paint(GREEN, glyphFor('done', opts), opts.color)
      : errShare < 0.01
        ? `${paint(GREEN, glyphFor('done', opts), opts.color)} ${dim(`${num(tool.errors)} err`, opts)}`
        : paint(AMBER, `${glyphFor('warn', opts)} ${pct(errShare)} errors`, opts.color);
  return `${tool.tool.padEnd(nameWidth)}  ${num(tool.calls).padStart(7)}  ${bar}${barPad} ${pct(tool.share).padStart(4)}  ${health}`;
}

function toolNameWidth(metrics: MetricsData): number {
  return Math.max(4, ...metrics.byTool.map((t) => t.tool.length));
}

/**
 * Tools whose error share crosses the attention bar, worst first. Shared by the report's nudge line
 * and the `--agent-output` summary so the human and agent surfaces always agree on "needs attention."
 */
export function attentionTools(metrics: MetricsData): readonly MetricsData['byTool'][number][] {
  return metrics.byTool
    .filter(
      (tool) => tool.calls >= NUDGE_MIN_CALLS && tool.errors / tool.calls >= NUDGE_ERROR_SHARE,
    )
    .sort((a, b) => b.errors / b.calls - a.errors / a.calls);
}

function worstTool(metrics: MetricsData): MetricsData['byTool'][number] | undefined {
  return attentionTools(metrics)[0];
}

function glyphFor(kind: 'done' | 'fail' | 'warn' | 'live', opts: RenderOptions): string {
  const unicode = { done: '✔', fail: '✗', warn: '⚠', live: '●' } as const;
  const ascii = { done: '+', fail: 'x', warn: '!', live: '*' } as const;
  return (opts.glyph === 'ascii' ? ascii : unicode)[kind];
}

// ─── Event stream ──────────────────────────────────────────────────────────────

const TIME_W = 8;
const OUTCOME_W = 8;
const CLIENT_W = 10;
const METHOD_W = 16;
const NAME_W = 17;

export function renderEventsHeader(opts: RenderOptions): string {
  return dim(
    ` ${'time'.padEnd(TIME_W)}  ${'status'.padEnd(OUTCOME_W)}  ${'client'.padEnd(CLIENT_W)}${'method'.padEnd(METHOD_W)}${'tool'.padEnd(NAME_W)}${'dur'.padStart(6)}`,
    opts,
  );
}

/** Truncate to the column width (ellipsis when clipped) so long names never break alignment. */
function fit(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, Math.max(1, width - 1))}…` : text;
}

export function renderEventRow(event: EventRecord, opts: RenderOptions): string {
  const time = event.createdAt?.slice(11, 19) ?? ''.padEnd(TIME_W);
  const outcome = event.outcome ?? 'ok';
  const cell =
    outcome === 'tool_error'
      ? paint(AMBER, `${glyphFor('warn', opts)} tool`.padEnd(OUTCOME_W), opts.color)
      : outcome === 'mcp_error'
        ? paint(ROSE, `${glyphFor('fail', opts)} mcp`.padEnd(OUTCOME_W), opts.color)
        : paint(GREEN, `${glyphFor('done', opts)} ok`.padEnd(OUTCOME_W), opts.color);
  const name = event.toolName ?? event.resourceName ?? event.promptName ?? '—';
  const dur = event.durationMs !== undefined ? ms(event.durationMs) : '';
  const error =
    event.errorKind !== undefined
      ? `  ${paint(outcome === 'mcp_error' ? ROSE : AMBER, event.errorKind, opts.color)}`
      : '';
  const client = fit(event.clientName ?? event.clientFamily ?? '—', CLIENT_W - 1).padEnd(CLIENT_W);
  const method = fit(event.method ?? '', METHOD_W - 1).padEnd(METHOD_W);
  const target = fit(name, NAME_W - 1).padEnd(NAME_W);
  return ` ${time.padEnd(TIME_W)}  ${cell}  ${client}${method}${target}${dur.padStart(6)}${error}`;
}

export function renderEventsSummary(
  counts: { readonly ok: number; readonly toolErrors: number; readonly mcpErrors: number },
  opts: RenderOptions,
): string {
  return ` ${paint(GREEN, `${glyphFor('done', opts)} ${num(counts.ok)}`, opts.color)}   ${paint(
    AMBER,
    `${glyphFor('warn', opts)} ${num(counts.toolErrors)} tool`,
    opts.color,
  )}   ${paint(ROSE, `${glyphFor('fail', opts)} ${num(counts.mcpErrors)} mcp`, opts.color)}`;
}

export function renderLiveFooter(target: string, opts: RenderOptions): string {
  const dot = paint(cyclic(0), glyphFor('live', opts), opts.color);
  return ` ${dot} ${dim(`live — ${target} · ^C to stop`, opts)}`;
}
