import type { ResolvedOperationRef } from '@noodle-borg/compiler';
import type { CallerIdentity } from './connector/types.js';
import type { ExecutionResult } from './result.js';

/** Explicit connector evidence. A returned tool result alone does not prove a business task completed. */
export interface OperationEvidence {
  readonly outcome: 'completed' | 'rejected' | 'accepted' | 'unknown' | 'returned';
  /** Opaque provider resource/job reference; protected by the service, never an authorization grant. */
  readonly reference?: string;
}

export interface OperationEvidenceIntent {
  readonly id: string;
  readonly tool: string;
  readonly operation: ResolvedOperationRef;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly executionRevision?: string;
  readonly executionBoundMs?: number;
  readonly caller?: CallerIdentity;
}

/** Hosting-owned durable intent/evidence authority. No provider transport or business-record custody. */
export interface OperationEvidencePort {
  /** Atomically claims an original invocation before I/O; undefined means it was already spent. */
  begin(intent: OperationEvidenceIntent): Promise<
    | {
        finish(evidence: OperationEvidence): Promise<void>;
      }
    | undefined
  >;
}

/** Shared by every connector action, including nested calls; persistence failure cannot enable I/O. */
export async function withOperationEvidence(
  port: OperationEvidencePort | undefined,
  intent: OperationEvidenceIntent,
  work: (report: (evidence: OperationEvidence) => void) => Promise<ExecutionResult>,
): Promise<ExecutionResult> {
  let claimed: Awaited<ReturnType<OperationEvidencePort['begin']>>;
  try {
    claimed = await port?.begin(intent);
  } catch {
    return {
      ok: false,
      error: {
        code: 'execution_admission_error',
        message: 'Operation evidence unavailable; no action dispatched.',
      },
    };
  }
  if (port && !claimed)
    return {
      ok: false,
      error: {
        code: 'duplicate_execution_suppressed',
        message:
          'This operation was already dispatched. Verify its original outcome before making a new request.',
      },
    };
  let evidence: OperationEvidence | undefined;
  let result: ExecutionResult;
  try {
    result = await work((value) => {
      evidence = safeOperationEvidence(value);
    });
  } catch {
    result = {
      ok: false,
      error: {
        code: 'connector_error',
        reason: 'operation_outcome_unknown',
        message: 'Operation outcome is unknown; verify the original effect before trying again.',
      },
    };
  }
  try {
    await claimed?.finish(evidence ?? { outcome: result.ok ? 'returned' : 'unknown' });
  } catch {
    return {
      ok: false,
      error: {
        code: 'connector_error',
        reason: 'operation_outcome_unknown',
        message:
          'Operation outcome could not be recorded. Do not repeat the write; verify its original outcome.',
      },
    };
  }
  return result;
}

/** Invalid or credential-like reference mappings never become success evidence or retained payloads. */
export function safeOperationEvidence(value: OperationEvidence): OperationEvidence {
  if (!['completed', 'rejected', 'accepted', 'unknown', 'returned'].includes(value.outcome))
    return { outcome: 'unknown' };
  if (
    value.reference !== undefined &&
    (!/^[A-Za-z0-9._:@/-]{1,256}$/.test(value.reference) || value.reference.includes('://'))
  )
    return { outcome: 'unknown' };
  return Object.freeze({
    outcome: value.outcome,
    ...(value.reference === undefined ? {} : { reference: value.reference }),
  });
}
