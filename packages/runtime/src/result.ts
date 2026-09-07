import type { CredentialProfile } from '@noodle-borg/compiler';
import type { ConnectorFailureCategory } from './connector/types.js';
import type { CustomerRouteBinding } from './customer-routing.js';

/** Why a tool call could not be fulfilled. Protocol and embedded adapters map this internal contract. */
export type ExecutionErrorCode =
  | 'shape_only_artifact'
  | 'unknown_tool'
  | 'unknown_resource'
  | 'unknown_prompt'
  | 'configuration_required'
  | 'configuration_invalid'
  | 'configuration_changed'
  | 'unsupported_fulfilment'
  | 'connector_unavailable'
  | 'connector_route_unavailable'
  | 'credential_unavailable'
  | 'signature_drift'
  | 'policy_denied'
  | 'policy_error'
  | 'dispatch_denied'
  | 'usage_limit_exceeded'
  | 'duplicate_execution_suppressed'
  | 'execution_admission_error'
  | 'execution_cancelled'
  | 'arg_invalid'
  | 'invalid_continuation'
  | 'invalid_elicitation_flow'
  | 'invalid_confirmation_flow'
  | 'expression_error'
  | 'circular_call_dependency'
  | 'connector_error'
  | 'output_invalid';

/**
 * Safe connector failure attribution for operator analytics (issue #1309): platform identifiers and
 * bounded classification only — never an upstream message, response body, credential, or exact URL.
 * Adapters must keep this off every model-facing wire channel.
 */
export interface ConnectorFailureAttribution {
  readonly connectorId: string;
  readonly connectorVersion: string;
  readonly operation: string;
  readonly category?: ConnectorFailureCategory;
  /** Upstream HTTP status class; the exact status is deliberately not retained. */
  readonly statusClass?: '4xx' | '5xx';
  readonly attempts?: number;
  readonly retryable?: boolean;
}

/** A typed execution failure. `path` locates the offending field/expression when applicable and
 * never carries a sensitive value. */
export interface ExecutionError {
  readonly code: ExecutionErrorCode;
  readonly message: string;
  readonly path?: string;
  /** Stable, allowlisted machine-readable detail. Never an upstream error message. */
  readonly reason?: string;
  /** Present on connector failures; analytics-only, never serialized to a client. */
  readonly connector?: ConnectorFailureAttribution;
  /** Safe monthly-allowance reset instant, present only for commercial usage denial. */
  readonly resetAt?: string;
  /** Safe remediation text intended for a developer or agent. */
  readonly fix?: string;
  /** Safe follow-up commands or actions. */
  readonly next?: readonly string[];
}

/** The result of executing a tool call: the operation output, or a typed error. */
export type ExecutionResult =
  | { readonly ok: true; readonly output: unknown }
  | { readonly ok: false; readonly error: ExecutionError };

/** Portable form input requested by an `elicit` flow step. Safe to expose to a host/client. */
export interface ElicitationRequest {
  readonly id: string;
  readonly message: string;
  readonly requestedSchema: Readonly<Record<string, unknown>>;
}

export type ElicitationResponse =
  | { readonly action: 'accept'; readonly content?: unknown }
  | { readonly action: 'decline' | 'cancel' };

/**
 * Server-side continuation state. Adapters persist this behind an opaque interaction id; it must
 * never be serialized into MCP or embedded-assistant client payloads.
 */
export interface ToolContinuation {
  readonly version: 1;
  readonly artifact: {
    readonly manifestName: string;
    readonly manifestVersion: string;
    readonly serverName: string;
    readonly serverVersion: string;
  };
  readonly toolName: string;
  readonly input: unknown;
  readonly nextStepIndex: number;
  readonly completedSteps: Readonly<Record<string, unknown>>;
  readonly resultMetas: readonly Readonly<Record<string, unknown>>[];
  readonly env: Readonly<Record<string, unknown>>;
  readonly pending: ElicitationRequest;
}

interface ContinuationArtifactIdentity {
  readonly manifestName: string;
  readonly manifestVersion: string;
  readonly serverName: string;
  readonly serverVersion: string;
}

/**
 * Server-side state while a confirmable tool is collecting its elicited prefix. This continuation
 * can evaluate pure maps and request more input, but cannot execute a connector operation.
 */
export interface ToolPreparationContinuation {
  readonly kind: 'confirmation_preparation';
  readonly version: 1;
  readonly artifact: ContinuationArtifactIdentity;
  readonly toolName: string;
  readonly input: unknown;
  readonly nextStepIndex: number;
  readonly completedSteps: Readonly<Record<string, unknown>>;
  readonly elicited: Readonly<Record<string, unknown>>;
  readonly env: Readonly<Record<string, unknown>>;
  readonly pending: ElicitationRequest;
}

/**
 * Server-side state after all pre-confirmation input has been collected. Adapters persist this
 * behind an opaque interaction id and release it to {@code executePreparedTool} only after approval.
 */
export interface PreparedToolContinuation {
  readonly kind: 'prepared_confirmation';
  /** Private hosting snapshot; never projected into a model-visible confirmation. */
  readonly executionRevision?: string;
  readonly version: 1;
  readonly artifact: ContinuationArtifactIdentity;
  readonly toolName: string;
  readonly input: unknown;
  /** First flow step not evaluated during preparation; zero for a single-operation fulfilment. */
  readonly nextStepIndex: number;
  readonly completedSteps: Readonly<Record<string, unknown>>;
  readonly env: Readonly<Record<string, unknown>>;
  /** Exact first connector invocation approved by the user; absent for a pure flow. */
  readonly reviewedAction?: PreparedOperationAction;
}

interface OperationActionIdentity {
  readonly connectorId: string;
  readonly connectorVersion: string;
  readonly operation: string;
  readonly bindingId?: string;
  readonly connectionId?: string;
  readonly connectionConfigRevision?: string;
  readonly profile?: string;
  readonly presentation?: CredentialProfile;
  readonly requiredScopes?: readonly string[];
  readonly requiredAudience?: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

/** Exact connector invocation bound into a private prepared confirmation continuation. */
export interface PreparedOperationAction extends OperationActionIdentity {
  /** URL-blind bindings for routed action calls, including transitive connector calls. */
  readonly customerRoutes?: readonly CustomerRouteBinding[];
}

/** Server-side data from which an adapter can construct a safely redacted public action review. */
export interface ConfirmationActionReview extends OperationActionIdentity {
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /** Later connector calls may depend on this action's output and are disclosed, not pre-resolved. */
  readonly additionalOperationCount: number;
}

/**
 * Values an adapter may summarize in its confirmation UI. This is server-side presentation input,
 * not a wire-safe payload: the adapter must redact the original input against the tool schema.
 */
export interface ConfirmationReview {
  readonly input: unknown;
  readonly elicited: Readonly<Record<string, unknown>>;
  /** Exact first connector invocation after all pure maps, ambient facts, and elicited values. */
  readonly action?: ConfirmationActionReview;
}

export type ConfirmationPreparationResult =
  | {
      readonly status: 'input_required';
      readonly request: ElicitationRequest;
      readonly continuation: ToolPreparationContinuation;
    }
  | {
      readonly status: 'confirmation_required';
      readonly review: ConfirmationReview;
      readonly continuation: PreparedToolContinuation;
    }
  | { readonly status: 'stopped'; readonly action: 'decline' | 'cancel' }
  | { readonly status: 'failed'; readonly error: ExecutionError };

export type InteractiveExecutionResult =
  | { readonly status: 'completed'; readonly output: unknown }
  | {
      readonly status: 'input_required';
      readonly request: ElicitationRequest;
      readonly continuation: ToolContinuation;
    }
  | { readonly status: 'stopped'; readonly action: 'decline' | 'cancel' }
  | { readonly status: 'failed'; readonly error: ExecutionError };

export function isInputRequired(
  result: InteractiveExecutionResult,
): result is Extract<InteractiveExecutionResult, { readonly status: 'input_required' }> {
  return result.status === 'input_required';
}

export function isInputRequiredForConfirmation(
  result: ConfirmationPreparationResult,
): result is Extract<ConfirmationPreparationResult, { readonly status: 'input_required' }> {
  return result.status === 'input_required';
}

export function isConfirmationRequired(
  result: ConfirmationPreparationResult,
): result is Extract<ConfirmationPreparationResult, { readonly status: 'confirmation_required' }> {
  return result.status === 'confirmation_required';
}
