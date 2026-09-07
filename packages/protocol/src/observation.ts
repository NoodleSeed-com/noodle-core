/** Two-tier request outcome (ADR 0121): recoverable tool error vs protocol/MCP error. */
export type ObservedOutcome = 'ok' | 'tool_error' | 'mcp_error';

/**
 * One analytics observation per executed tool/resource/prompt request, reported to the transport's
 * capture hook. The protocol layer owns the two-tier outcome split (it sees the `isError` channel and
 * the execution-error codes); the transport composes tenant identity and timing around it.
 */
export interface ProtocolObservation {
  readonly method: string;
  readonly toolName?: string;
  readonly resourceName?: string;
  readonly promptName?: string;
  readonly outcome: ObservedOutcome;
  readonly errorKind?: string;
  /** Validated operator analytics context, already removed from customer tool arguments. */
  readonly intent?: IntentCaptureValue;
  /** Rough token-equivalent of the response payload (chars/4), the context-bloat gauge. */
  readonly outputTokensEst?: number;
  /** Safe connector failure attribution projected from the execution error (#1309); scalars only. */
  readonly connector?: ConnectorFailureAttribution;
}

/**
 * The analytics `errorKind` for an execution error: the stable code, refined with the allowlisted
 * `reason` when one exists (`connector_error.timeout`). Analytics-only — the wire's structured
 * reasons are gated separately (and more narrowly) in `execution-error-mapping.ts`.
 */
function executionErrorKind(error: { readonly code: string; readonly reason?: string }): string {
  return error.reason === undefined ? error.code : `${error.code}.${error.reason}`;
}

/** The observation slice carried by an execution error, ready to spread into an observe call. */
export function executionErrorObservation(error: {
  readonly code: string;
  readonly reason?: string;
  readonly connector?: ConnectorFailureAttribution;
}): Pick<ProtocolObservation, 'errorKind' | 'connector'> {
  return {
    errorKind: executionErrorKind(error),
    ...(error.connector === undefined ? {} : { connector: error.connector }),
  };
}

interface ObservationContext {
  readonly observe?: (observation: ProtocolObservation) => void;
}

/** Report an observation; an observer bug must never break the request it watched. */
export function notify(context: ObservationContext, observation: ProtocolObservation): void {
  try {
    context.observe?.(observation);
  } catch {
    // Analytics is strictly best-effort.
  }
}

/** Rough content-level token estimate (JSON chars / 4), computed on the raw execution output so
 * the response path serializes it once — wire framing/duplication is deliberately excluded. */
export function estimateTokens(value: unknown): number {
  try {
    return Math.ceil(JSON.stringify(value).length / 4);
  } catch {
    return 0;
  }
}

import type { IntentCaptureValue } from '@noodle-borg/module';
import type { ConnectorFailureAttribution } from '@noodle-borg/runtime';
