import type { ToolDispatchDecision } from '@noodle-borg/module';

export type { ToolDispatchDecision } from '@noodle-borg/module';

/** Safe, argument-free context exposed when one logical tool call first consumes admission. */
export interface ToolDispatchContext {
  readonly toolName: string;
}

/** Called at connector boundaries and successful connector-free completion; latched once per logical call. */
export type ToolDispatchHook = (
  context: ToolDispatchContext,
) => ToolDispatchDecision | Promise<ToolDispatchDecision>;

class ToolDispatchCancelled extends Error {
  constructor(readonly deadline = false) {
    super();
  }
}
const startedAdmissions = new WeakSet<ToolDispatchHook>();

/** Client cancellation stops unadmitted work; a host execution deadline remains authoritative. */
export function executionCancellation(
  signal: AbortSignal | undefined,
  admission: ToolDispatchHook | undefined,
): ExecutionError | null {
  if (!signal?.aborted || (admission && startedAdmissions.has(admission) && !isDeadline(signal)))
    return null;
  return {
    code: 'execution_cancelled',
    message: isDeadline(signal)
      ? 'Execution deadline elapsed before connector dispatch.'
      : 'tool execution was cancelled before usage admission',
  };
}

/** After admission a client disconnect cannot cancel the effect, but a hard deadline still can. */
export function admittedExecutionSignal(parent: AbortSignal | undefined): {
  readonly signal: AbortSignal | undefined;
  dispose(): void;
} {
  if (!parent) return { signal: undefined, dispose() {} };
  const controller = new AbortController();
  const propagate = () => {
    if (parent.aborted && isDeadline(parent)) controller.abort(parent.reason);
  };
  parent.addEventListener('abort', propagate, { once: true });
  propagate();
  return {
    signal: controller.signal,
    dispose: () => parent.removeEventListener('abort', propagate),
  };
}

function isDeadline(signal: AbortSignal): boolean {
  return signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError';
}

/** Latch cancellation and admission once for every logical protocol operation. */
export function latchToolDispatchAdmission(
  hook: ToolDispatchHook | undefined,
  signal: AbortSignal | undefined,
): ToolDispatchHook | undefined {
  if (hook === undefined && signal === undefined) return undefined;
  let pending: Promise<ToolDispatchDecision> | undefined;
  const admission: ToolDispatchHook = (context) => {
    pending ??= Promise.resolve().then(() => {
      if (signal?.aborted) throw new ToolDispatchCancelled(isDeadline(signal));
      startedAdmissions.add(admission);
      return hook?.(context) ?? { allow: true };
    });
    return pending.then((decision) => {
      if (decision.allow && signal?.aborted && isDeadline(signal))
        throw new ToolDispatchCancelled(true);
      return decision;
    });
  };
  return admission;
}

/** Apply a hook as a fail-closed runtime admission decision without exposing implementation errors. */
export async function admitToolDispatch(
  hook: ToolDispatchHook | undefined,
  context: ToolDispatchContext,
): Promise<ExecutionError | null> {
  if (hook === undefined) return null;
  try {
    const decision = await hook(context);
    if (decision.allow) return null;
    if (decision.kind === 'usage_limit_exceeded') {
      const resetAt = normalizeResetAt(decision.resetAt);
      return {
        code: 'usage_limit_exceeded',
        message: `Monthly MCP call limit reached. Usage resets at ${resetAt}.`,
        reason: decision.reason,
        resetAt,
      };
    }
    if (decision.kind === 'duplicate_execution_suppressed') {
      return {
        code: 'duplicate_execution_suppressed',
        message:
          'This retry was already admitted. Its result was not replayed and any connector effect was suppressed; verify the original outcome before issuing a new request.',
        reason: decision.reason,
      };
    }
    return { code: 'dispatch_denied', message: decision.reason };
  } catch (error) {
    if (error instanceof ToolDispatchCancelled) {
      return {
        code: 'execution_cancelled',
        message: error.deadline
          ? 'Execution deadline elapsed; verify any operation already dispatched.'
          : 'tool execution was cancelled before usage admission',
      };
    }
    return { code: 'execution_admission_error', message: 'tool execution admission failed' };
  }
}

/**
 * Connector-backed tools admit immediately before their first connector effect. A successful tool that
 * reaches no connector still consumes the same once-latched unit immediately before its result leaves the
 * runtime. Resources and prompts never provide this hook.
 */
export async function admitSuccessfulToolResult(
  result: ExecutionResult,
  admission: ToolDispatchHook | undefined,
  toolName: string,
): Promise<ExecutionResult> {
  if (!result.ok) return result;
  const admissionError = await admitToolDispatch(admission, { toolName });
  return admissionError === null ? result : { ok: false, error: admissionError };
}

function normalizeResetAt(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error('usage-limit reset time is invalid');
  }
  return value;
}

import type { ExecutionError, ExecutionResult } from './result.js';
