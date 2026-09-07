import { randomUUID } from 'node:crypto';
import type { RequestEventInput } from '@noodle-borg/module';
import { type AssistantUsageSessionRef, captureAssistantUsage } from './assistant-usage.js';

/**
 * A tool call served over the embedded assistant's apps bridge.
 *
 * These are `method: 'tools/call'` rather than the assistant lifecycle's own `'assistant'`, because
 * that is what they are: one governed execution against the tenant's connectors, indistinguishable
 * at the connector from an MCP call. They are deliberately outside `aggregateAssistantUsage`, which
 * counts conversations — a bridge call spends no turn and belongs in no session's depth.
 */
export interface AssistantAppToolCallUsage {
  /** Absent when the request named no tool; the outcome is still worth recording. */
  readonly toolName?: string;
  /**
   * The caller declared the WebMCP bridge marker (ADR 0220). It selects the label on this row and
   * nothing else: authority came from the session, which the route decided before this was built.
   * An unmarked call is the MCP Apps widget path and is attributed to the session's own surface.
   */
  readonly bridged: boolean;
  readonly outcome: 'ok' | 'refused' | 'failed';
  readonly errorKind?: string;
  readonly durationMs: number;
}

/** Project one apps-bridge tool call onto the shared tenant request stream. */
export function assistantAppToolCallRequestEvent(
  session: AssistantUsageSessionRef,
  input: AssistantAppToolCallUsage,
): RequestEventInput {
  const isPublic = session.publicEmbedId !== undefined;
  return {
    ...session.tenant,
    deploymentId: session.deploymentId,
    requestId: randomUUID(),
    sessionId: session.id,
    sessionSource: 'synthetic',
    subjectKind: isPublic ? 'anonymous' : 'authenticated',
    accessMode: isPublic ? 'public' : 'authenticated',
    surface: input.bridged ? 'webmcp' : isPublic ? 'assistant-public' : 'assistant-authenticated',
    method: 'tools/call',
    kind: 'usage',
    ...(input.toolName === undefined ? {} : { toolName: input.toolName }),
    outcome:
      input.outcome === 'ok' ? 'ok' : input.outcome === 'refused' ? 'tool_error' : 'mcp_error',
    ...(input.errorKind === undefined ? {} : { errorKind: input.errorKind }),
    durationMs: Number.isFinite(input.durationMs) && input.durationMs > 0 ? input.durationMs : 0,
    // Scalar-only, like every other assistant event: tool arguments, results, page context, and
    // credentials have no field to enter through.
    details: { eventKind: 'appToolCall', bridged: input.bridged },
  };
}

/**
 * Bind one apps-bridge tool call's fixed facts, leaving the caller a recorder it can run at any
 * exit. The route reaches several of them -- a budget refusal before any resolution work, an
 * unprojected tool, bad arguments, a raised confirmation, a result -- and assembling the event at
 * each one is how one of them ends up forgotten, which is what happened to the budget refusal.
 */
export function assistantAppToolCallRecorder(input: {
  readonly capture: ((event: RequestEventInput) => void) | undefined;
  readonly session: AssistantUsageSessionRef;
  readonly toolName: string | undefined;
  readonly bridged: boolean;
  /** Read once at bind time and again at each exit; the difference is the call's duration. */
  readonly clock: () => number;
}): (outcome: AssistantAppToolCallUsage['outcome'], errorKind?: string) => void {
  const startedAt = input.clock();
  return (outcome, errorKind) => {
    captureAssistantUsage(
      input.capture,
      assistantAppToolCallRequestEvent(input.session, {
        // Absent when the caller named no tool. That row still matters: a nameless call that
        // exhausts a budget is the shape abusive traffic takes, and it is the row an operator
        // watching a browser agent would miss if a missing name suppressed the event.
        ...(input.toolName === undefined ? {} : { toolName: input.toolName }),
        bridged: input.bridged,
        outcome,
        ...(errorKind === undefined ? {} : { errorKind }),
        durationMs: input.clock() - startedAt,
      }),
    );
  };
}
