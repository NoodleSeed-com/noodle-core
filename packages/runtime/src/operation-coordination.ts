import type { ExprNode } from '@noodle-borg/compiler';
import type { OperationEvidence } from './operation-evidence.js';

/** Application-authored resource identity; values resolve before executing the guarded operation. */
export interface OperationCoordinationDeclaration {
  readonly connectionId: string;
  readonly namespace: string;
  readonly key: ExprNode;
  readonly reference: ExprNode;
}

export interface OperationCoordinationIntent {
  readonly id: string;
  readonly connectionId: string;
  readonly namespace: string;
  readonly key: string;
  readonly reference: string;
  readonly executionBoundMs: number;
}

export interface OperationCoordinationSnapshot {
  readonly acquired: boolean;
  readonly previous?: { readonly reference: string; readonly operationDigest: string };
}

/** A token-bound lease: resolving a prior uncertain effect never admits a write in this invocation. */
export interface OperationCoordinationLease extends OperationCoordinationSnapshot {
  finish(evidence: OperationEvidence): Promise<void>;
  resolvePrevious(): Promise<void>;
}

/** Production implementations share durable authority across service instances. */
export interface OperationCoordinationPort {
  acquire(intent: OperationCoordinationIntent): Promise<OperationCoordinationLease>;
}
