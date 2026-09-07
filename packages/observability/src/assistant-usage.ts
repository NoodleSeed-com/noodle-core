import { randomUUID } from 'node:crypto';
import type { RequestEvent, RequestEventInput } from '@noodle-borg/module';

export const ASSISTANT_USAGE_METHOD = 'assistant';

export type AssistantUsageSurface = 'public' | 'authenticated';
export type AssistantUsageModelSource = 'noodle-managed' | 'operator';
export type AssistantTurnOutcome = 'delivered' | 'failed' | 'refused';

interface AssistantUsageBase {
  readonly org: string;
  readonly app: string;
  readonly env: string;
  readonly deploymentId: string;
  readonly sessionId?: string;
  readonly surface: AssistantUsageSurface;
  readonly modelSource?: AssistantUsageModelSource;
  readonly durationMs: number;
}

export interface AssistantSessionUsageInput extends AssistantUsageBase {
  readonly eventKind: 'session';
  /**
   * Absent for a mint that succeeded. A refused mint has no session to identify and no turn to
   * count, so it carries only the tenant it was refused for and the code that refused it.
   */
  readonly outcome?: 'refused';
  readonly errorKind?: string;
}

export interface AssistantTurnUsageInput extends AssistantUsageBase {
  readonly eventKind: 'turn';
  readonly outcome: AssistantTurnOutcome;
  readonly turnNumber: number;
  readonly modelRequests: number;
  readonly toolCalls: number;
  readonly interactionCount: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly reasoningTokens?: number;
  readonly totalTokens: number;
  readonly errorKind?: string;
}

export type AssistantUsageInput = AssistantSessionUsageInput | AssistantTurnUsageInput;

export interface AssistantUsageSessionRef {
  readonly id: string;
  readonly tenant: { readonly org: string; readonly app: string; readonly env: string };
  readonly deploymentId: string;
  readonly publicEmbedId?: string;
  readonly modelSource?: AssistantUsageModelSource;
  readonly turnCount: number;
  readonly history: readonly { readonly role: 'user' | 'assistant' }[];
}

export interface AssistantUsageTurnCounters {
  readonly modelRequests: number;
  readonly toolCalls: number;
  readonly interactionCount: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly reasoningTokens?: number;
  readonly totalTokens: number;
}

const EMPTY_TURN_COUNTERS: AssistantUsageTurnCounters = {
  modelRequests: 0,
  toolCalls: 0,
  interactionCount: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
};

export function assistantSessionUsageRequestEvent(
  session: AssistantUsageSessionRef,
  durationMs: number,
): RequestEventInput {
  return assistantUsageRequestEvent({
    ...session.tenant,
    deploymentId: session.deploymentId,
    eventKind: 'session',
    sessionId: session.id,
    surface: assistantSurface(session),
    ...(session.modelSource === undefined ? {} : { modelSource: session.modelSource }),
    durationMs,
  });
}

export function assistantTurnUsageRequestEvent(
  session: AssistantUsageSessionRef,
  input: {
    readonly outcome: AssistantTurnOutcome;
    readonly turnNumber: number;
    readonly durationMs: number;
    readonly counters?: AssistantUsageTurnCounters;
    readonly errorKind?: string;
  },
): RequestEventInput {
  return assistantUsageRequestEvent({
    ...session.tenant,
    deploymentId: session.deploymentId,
    eventKind: 'turn',
    sessionId: session.id,
    surface: assistantSurface(session),
    ...(session.modelSource === undefined ? {} : { modelSource: session.modelSource }),
    outcome: input.outcome,
    turnNumber: input.turnNumber,
    durationMs: input.durationMs,
    ...(input.counters ?? EMPTY_TURN_COUNTERS),
    ...(input.errorKind === undefined ? {} : { errorKind: input.errorKind }),
  });
}

/**
 * A mint refused before any session existed. There is no session id and no turn to count: the event
 * carries the tenant it was refused for and the code that refused it, and nothing else.
 */
export function assistantRefusedSessionUsageRequestEvent(input: {
  readonly tenant: { readonly org: string; readonly app: string; readonly env: string };
  readonly deploymentId?: string;
  readonly code: string;
  readonly durationMs: number;
}): RequestEventInput {
  return assistantUsageRequestEvent({
    ...input.tenant,
    deploymentId: input.deploymentId ?? '',
    eventKind: 'session',
    surface: 'public',
    outcome: 'refused',
    errorKind: input.code,
    durationMs: input.durationMs,
  });
}

/**
 * Record a refused mint, when it belongs to a tenant.
 *
 * Only attributable refusals are recorded: an unknown or malformed embed id is prober noise and
 * belongs in platform logs, not in a customer's usage. What an operator actually needs — the surface
 * is out of budget, one address is at its hourly ceiling, the origin is not on the live allowlist —
 * all know the embed by the time they refuse, which is why the decision lives here rather than at
 * the call site: a route that forgets it produces silence, and silence reads as health.
 */
export function captureRefusedAssistantSession(
  capture: ((event: RequestEventInput) => void) | undefined,
  refusal: {
    readonly code: string;
    readonly embed?: { readonly org: string; readonly app: string; readonly env: string };
  },
  durationMs: number,
): void {
  if (refusal.embed === undefined) return;
  const { org, app, env } = refusal.embed;
  captureAssistantUsage(
    capture,
    assistantRefusedSessionUsageRequestEvent({
      tenant: { org, app, env },
      code: refusal.code,
      durationMs,
    }),
  );
}

export function assistantRefusedTurnUsageRequestEvent(
  session: AssistantUsageSessionRef,
  errorKind: string,
  durationMs: number,
): RequestEventInput {
  return assistantTurnUsageRequestEvent(session, {
    outcome: 'refused',
    turnNumber: session.turnCount,
    durationMs,
    errorKind,
  });
}

function assistantSurface(session: AssistantUsageSessionRef): AssistantUsageSurface {
  return session.publicEmbedId === undefined ? 'authenticated' : 'public';
}

export function assistantTurnNumber(session: AssistantUsageSessionRef): number {
  if (session.publicEmbedId !== undefined) return session.turnCount + 1;
  return session.history.filter((message) => message.role === 'user').length + 1;
}

export function captureAssistantUsage(
  capture: ((event: RequestEventInput) => void) | undefined,
  event: RequestEventInput,
): void {
  try {
    capture?.(event);
  } catch {
    // Telemetry is best effort and never changes the assistant response path.
  }
}

/**
 * Project one assistant lifecycle event onto the shared tenant request stream. The allowlist is
 * deliberately scalar-only: conversation text, model messages, tool arguments/results, headers,
 * credentials, and page context have no field to enter through.
 */
export function assistantUsageRequestEvent(input: AssistantUsageInput): RequestEventInput {
  const refused = input.eventKind === 'session' ? input.outcome === 'refused' : false;
  const details = {
    eventKind: input.eventKind,
    surface: input.surface,
    ...(refused ? { assistantOutcome: 'refused' } : {}),
    ...(input.modelSource === undefined ? {} : { modelSource: input.modelSource }),
    ...(input.eventKind === 'turn'
      ? {
          assistantOutcome: input.outcome,
          turnNumber: input.turnNumber,
          modelRequests: input.modelRequests,
          toolCalls: input.toolCalls,
          interactionCount: input.interactionCount,
          promptTokens: input.promptTokens,
          completionTokens: input.completionTokens,
          totalTokens: input.totalTokens,
          ...(input.reasoningTokens === undefined
            ? {}
            : { reasoningTokens: input.reasoningTokens }),
        }
      : {}),
  };
  return {
    org: input.org,
    app: input.app,
    env: input.env,
    deploymentId: input.deploymentId,
    requestId: randomUUID(),
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    sessionSource: 'synthetic',
    subjectKind: input.surface === 'public' ? 'anonymous' : 'authenticated',
    accessMode: input.surface === 'public' ? 'public' : 'authenticated',
    // The shared stream vocabulary, not the assistant's own: `details.surface` keeps the internal
    // spelling for the assistant's own aggregates, while this field is what the whole request
    // stream groups by.
    surface: input.surface === 'public' ? 'assistant-public' : 'assistant-authenticated',
    method: ASSISTANT_USAGE_METHOD,
    kind: 'usage',
    outcome:
      input.outcome === 'refused'
        ? 'tool_error'
        : input.eventKind === 'session' || input.outcome === 'delivered'
          ? 'ok'
          : 'mcp_error',
    ...(input.errorKind === undefined ? {} : { errorKind: input.errorKind }),
    durationMs: finiteNonNegative(input.durationMs),
    details,
  };
}

export interface AssistantUsageMetrics {
  readonly sessions: {
    readonly minted: number;
    readonly public: number;
    readonly authenticated: number;
    /** Mints admission refused. Never counted as minted — the session does not exist. */
    readonly refused: number;
  };
  readonly turns: {
    readonly attempted: number;
    readonly delivered: number;
    readonly failed: number;
    readonly refused: number;
  };
  readonly depth: {
    readonly p50: number;
    readonly p90: number;
    readonly max: number;
    readonly atLeast10: number;
    readonly atLeast20: number;
    readonly atLeast30: number;
    readonly atLeast40: number;
  };
  readonly engagement: {
    readonly modelRequests: number;
    readonly toolTurns: number;
    readonly interactionTurns: number;
  };
  readonly latency: { readonly p50Ms: number; readonly p95Ms: number };
  readonly tokens: {
    readonly prompt: number;
    readonly completion: number;
    readonly reasoning: number;
    readonly total: number;
  };
  readonly byModelSource: { readonly noodleManaged: number; readonly operator: number };
  /**
   * Every refusal, mint and turn alike, by the code that produced it. Without this an operator sees
   * a refusal count and cannot tell "my surface is out of budget" from "one address is hammering
   * it" — which want opposite responses.
   */
  readonly refusalsByCode: Readonly<Record<string, number>>;
}

export function aggregateAssistantUsage(events: readonly RequestEvent[]): AssistantUsageMetrics {
  let minted = 0;
  let refusedSessions = 0;
  let publicSessions = 0;
  let authenticatedSessions = 0;
  let delivered = 0;
  let failed = 0;
  let refused = 0;
  let modelRequests = 0;
  let toolTurns = 0;
  let interactionTurns = 0;
  let prompt = 0;
  let completion = 0;
  let reasoning = 0;
  let total = 0;
  let noodleManaged = 0;
  let operator = 0;
  const latencies: number[] = [];
  const refusalsByCode = new Map<string, number>();
  const sessionDepth = new Map<string, number>();
  const countRefusal = (code: string | undefined) => {
    if (code === undefined) return;
    refusalsByCode.set(code, (refusalsByCode.get(code) ?? 0) + 1);
  };

  for (const event of events) {
    if (event.method !== ASSISTANT_USAGE_METHOD) continue;
    const details = event.details;
    const eventKind = scalarString(details?.eventKind);
    const surface = scalarString(details?.surface);
    if (eventKind === 'session') {
      if (scalarString(details?.assistantOutcome) === 'refused') {
        refusedSessions += 1;
        countRefusal(event.errorKind);
        continue;
      }
      minted += 1;
      if (surface === 'public') publicSessions += 1;
      if (surface === 'authenticated') authenticatedSessions += 1;
      continue;
    }
    if (eventKind !== 'turn') continue;
    const outcome = scalarString(details?.assistantOutcome);
    if (outcome === 'delivered') delivered += 1;
    else if (outcome === 'refused') {
      refused += 1;
      countRefusal(event.errorKind);
    } else if (outcome === 'failed') failed += 1;
    else continue;

    latencies.push(finiteNonNegative(event.durationMs));
    modelRequests += scalarCount(details?.modelRequests);
    if (scalarCount(details?.toolCalls) > 0) toolTurns += 1;
    if (scalarCount(details?.interactionCount) > 0) interactionTurns += 1;
    prompt += scalarCount(details?.promptTokens);
    completion += scalarCount(details?.completionTokens);
    reasoning += scalarCount(details?.reasoningTokens);
    total += scalarCount(details?.totalTokens);
    const source = scalarString(details?.modelSource);
    if (source === 'noodle-managed') noodleManaged += 1;
    if (source === 'operator') operator += 1;
    const turnNumber = scalarCount(details?.turnNumber);
    if (event.sessionId !== undefined && turnNumber > 0) {
      sessionDepth.set(
        event.sessionId,
        Math.max(sessionDepth.get(event.sessionId) ?? 0, turnNumber),
      );
    }
  }

  const depths = [...sessionDepth.values()].sort((a, b) => a - b);
  const sortedLatencies = latencies.sort((a, b) => a - b);
  return {
    sessions: {
      minted,
      public: publicSessions,
      authenticated: authenticatedSessions,
      refused: refusedSessions,
    },
    turns: {
      attempted: delivered + failed + refused,
      delivered,
      failed,
      refused,
    },
    depth: {
      p50: percentile(depths, 50),
      p90: percentile(depths, 90),
      max: depths.at(-1) ?? 0,
      atLeast10: depths.filter((value) => value >= 10).length,
      atLeast20: depths.filter((value) => value >= 20).length,
      atLeast30: depths.filter((value) => value >= 30).length,
      atLeast40: depths.filter((value) => value >= 40).length,
    },
    engagement: { modelRequests, toolTurns, interactionTurns },
    latency: {
      p50Ms: percentile(sortedLatencies, 50),
      p95Ms: percentile(sortedLatencies, 95),
    },
    tokens: { prompt, completion, reasoning, total },
    byModelSource: { noodleManaged, operator },
    refusalsByCode: Object.fromEntries([...refusalsByCode].sort(([a], [b]) => a.localeCompare(b))),
  };
}

function scalarString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function scalarCount(value: unknown): number {
  return typeof value === 'number' ? Math.floor(finiteNonNegative(value)) : 0;
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function percentile(sorted: readonly number[], percentileValue: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((percentileValue / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1] ?? 0;
}
