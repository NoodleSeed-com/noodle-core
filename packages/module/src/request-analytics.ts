import type { AccessMode, AuditDetails } from './contract.js';

// --- Request analytics (the tenant-facing MCP request-event stream) ---------
// A fourth telemetry stream, separate from platform logs, user-app logs, and audit
// (ADR 0121 / roadmap/mcp-analytics.md). It shares the audit redaction discipline
// (scalar allowlist) but is its own store. The field set below IS the allowlist.

/** Two-tier MCP request outcome: recoverable tool error vs protocol/MCP error. */
export type RequestOutcome = 'ok' | 'tool_error' | 'mcp_error';

/** Real usage vs protocol discovery (list-style discovery calls, excluded from usage metrics). */
export type RequestKind = 'usage' | 'discovery';

/** How the session id was derived (stateless transport mints synthetic ids). */
export type SessionSource = 'mcp' | 'synthetic' | 'none';

/**
 * Which product surface the request arrived through. One vocabulary for the whole stream: the MCP
 * endpoint, either embedded-assistant surface, and a browser agent calling through the WebMCP
 * provider bridge ([ADR 0220](../../../docs/decisions/0220-webmcp-provider-bridge.md)). Attribution
 * only — no code may read this to decide what a caller is allowed to do, because the bridge value
 * originates in a client-declared marker.
 */
export type RequestSurface = 'mcp' | 'assistant-public' | 'assistant-authenticated' | 'webmcp';

export const REQUEST_SURFACES = [
  'mcp',
  'assistant-public',
  'assistant-authenticated',
  'webmcp',
] as const satisfies readonly RequestSurface[];

export function isRequestSurface(value: unknown): value is RequestSurface {
  return REQUEST_SURFACES.includes(value as RequestSurface);
}

/** Whether the caller was an anonymous or an authenticated identity (never the raw subject). */
export type SubjectKind = 'anonymous' | 'authenticated';

/**
 * Bounded client-family projection (issue #1309): a stable low-cardinality token derived from MCP
 * `clientInfo` when supplied, else from a closed table of known HTTP client user agents (`other`
 * when unmatched, `unknown` when absent). Never a raw user-agent string.
 */
export const CLIENT_FAMILY_UNKNOWN = 'unknown';
export const CLIENT_FAMILY_OTHER = 'other';

export interface RequestEventInput {
  readonly org: string;
  readonly app?: string;
  readonly env?: string;
  readonly deploymentId?: string;
  readonly serverVersion?: string;
  readonly sdkProtocolVersion?: string;
  /** Server-observed wire era; never inferred from app or deployment configuration. */
  readonly protocolEra?: 'legacy' | 'modern';
  readonly requestId: string;
  readonly sessionId?: string;
  readonly sessionSource: SessionSource;
  readonly clientName?: string;
  readonly clientVersion?: string;
  /** Bounded client family; always present in practice (`unknown` when nothing safe was supplied). */
  readonly clientFamily?: string;
  readonly accessMode?: AccessMode;
  /** Originating surface; absent on rows written before schema v3, which read back as unknown. */
  readonly surface?: RequestSurface;
  readonly subjectKind: SubjectKind;
  readonly method: string;
  readonly kind: RequestKind;
  readonly toolName?: string;
  readonly resourceName?: string;
  readonly promptName?: string;
  readonly outcome: RequestOutcome;
  readonly errorKind?: string;
  readonly durationMs: number;
  /** Front-door wait (auth, admission, authorization preflight) before protocol dispatch began. */
  readonly queueMs?: number;
  /** Protocol-handler execution time; `durationMs` remains the full request wall clock. */
  readonly execMs?: number;
  readonly outputTokensEst?: number;
  readonly country?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** A persisted analytics event: the input shape plus store-stamped identity and redacted details. */
export interface RequestEvent extends Omit<RequestEventInput, 'details'> {
  readonly seq?: number;
  readonly id: string;
  readonly schemaVersion: number;
  readonly createdAt: string;
  readonly details?: AuditDetails;
}

export interface RequestEventFilter {
  readonly org: string;
  readonly app?: string;
  readonly env?: string;
  readonly method?: string;
  readonly outcome?: RequestOutcome;
  readonly toolName?: string;
  readonly clientName?: string;
  readonly surface?: RequestSurface;
  readonly sessionId?: string;
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
}

export interface RequestEventSink {
  emit(event: RequestEventInput): Promise<void>;
}

export interface RequestEventStore extends RequestEventSink {
  list(filter: RequestEventFilter): Promise<readonly RequestEvent[]>;
}

/**
 * v2 (issue #1309): adds `clientFamily`, `queueMs`, `execMs`, and connector-attribution `details`.
 * v3 (ADR 0220): adds `surface`. Additive and unbackfilled — a row at v2 or below simply has no
 * surface, which a reader must render as unknown rather than as any particular surface.
 */
export const REQUEST_EVENT_SCHEMA_VERSION = 3;
