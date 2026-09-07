import type {
  CredentialProfile,
  OperationSignature,
  ResolvedOperationRef,
} from '@noodle-borg/compiler';
import type { DownstreamCredential } from '../broker/types.js';
import type { CustomerConnectorRoute } from '../customer-routing.js';
import type { OperationEvidence } from '../operation-evidence.js';

/** Verified caller claims that may be threaded into first-party connector operations. */
export interface CallerIdentity {
  readonly subject: string;
  readonly email?: string;
  /** Verified display name from the embedding application's authenticated exchange. */
  readonly name?: string;
  /** Backend-verified BCP 47 locale preference, available as `${user.locale}`. */
  readonly locale?: string;
  /** Backend-verified IANA time-zone preference, available as `${user.timeZone}`. */
  readonly timeZone?: string;
  readonly scopes?: readonly string[];
  /** Canonical roles projected from an explicitly configured verified claim. */
  readonly roles?: readonly string[];
  readonly audience?: string;
  readonly identityKind?: 'platform' | 'customer' | 'service' | 'anonymous';
  readonly identityProvider?: string;
  /**
   * Developer-declared verified session claims (embedded assistant `sessionClaims` allowlist).
   * Flat scalars only; reachable in fulfilment as `${user.claims.<key>}`.
   */
  readonly claims?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ConnectorTraceEvent {
  readonly kind: 'connector';
  readonly connectorId: string;
  readonly connectorVersion: string;
  readonly operation: string;
  readonly status?: number;
  readonly category?: ConnectorFailureCategory;
  readonly attempts?: number;
  readonly retryable?: boolean;
  readonly retryAfterMs?: number;
  readonly responseExcerpt?: string;
  /** Time the call waited for an execution slot, timed independently of execution. */
  readonly queueWaitMs?: number;
  /** Time the call actually executed, excluding queue wait. */
  readonly executionMs?: number;
}

export interface ExecutionTraceSink {
  record(event: ConnectorTraceEvent): void;
}

export type ConnectorFailureCategory =
  | 'timeout'
  | 'queue_timeout'
  | 'network_error'
  | 'rate_limited'
  | 'upstream_5xx'
  | 'upstream_4xx'
  | 'invalid_response'
  | 'response_too_large';

const connectorInvocationErrors = new WeakSet<object>();
const connectorInvocationErrorMessages = new WeakMap<object, string>();

export class ConnectorInvocationError extends Error {
  readonly status?: number;
  readonly category?: ConnectorFailureCategory;
  readonly attempts?: number;
  readonly retryable?: boolean;
  readonly retryAfterMs?: number;
  readonly responseExcerpt?: string;
  readonly queueWaitMs?: number;
  readonly executionMs?: number;

  constructor(
    message: string,
    details: {
      readonly status?: number;
      readonly category?: ConnectorFailureCategory;
      readonly attempts?: number;
      readonly retryable?: boolean;
      readonly retryAfterMs?: number;
      readonly responseExcerpt?: string;
      readonly queueWaitMs?: number;
      readonly executionMs?: number;
    } = {},
  ) {
    super(message);
    connectorInvocationErrors.add(this);
    connectorInvocationErrorMessages.set(this, message);
    this.name = 'ConnectorInvocationError';
    if (details.status !== undefined) this.status = details.status;
    if (details.category !== undefined) this.category = details.category;
    if (details.attempts !== undefined) this.attempts = details.attempts;
    if (details.retryable !== undefined) this.retryable = details.retryable;
    if (details.retryAfterMs !== undefined) this.retryAfterMs = details.retryAfterMs;
    if (details.responseExcerpt !== undefined) this.responseExcerpt = details.responseExcerpt;
    if (details.queueWaitMs !== undefined) this.queueWaitMs = details.queueWaitMs;
    if (details.executionMs !== undefined) this.executionMs = details.executionMs;
  }
}

/** Trap-free nominal classification for connector rejection values. Proxy wrappers are untrusted. */
export function isConnectorInvocationError(value: unknown): value is ConnectorInvocationError {
  return isObjectLike(value) && connectorInvocationErrors.has(value);
}

/** Constructor-time message snapshot; never reads a potentially replaced `message` property. */
export function connectorInvocationErrorMessage(value: unknown): string | undefined {
  return isObjectLike(value) ? connectorInvocationErrorMessages.get(value) : undefined;
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

/**
 * Host capability exposed to connectors that need to call another connector operation on behalf of
 * sandboxed code. The runtime owns the implementation so nested calls still pass through signature
 * drift checks, policy, broker credentials, connector invocation, redaction, and output validation.
 */
export interface ConnectorCallHost {
  callOperation(
    ref: ResolvedOperationRef,
    args: Readonly<Record<string, unknown>>,
    path: string,
  ): Promise<unknown>;
}

/** A single connector-operation invocation, fully resolved and credentialed by the runtime. */
export interface ConnectorCall {
  readonly operation: string;
  /** Runtime-generated, deployment/step-bound identity. Not a business input or recovery authority. */
  readonly execution?: Readonly<{ readonly id: string }>;
  /** Connector/application-classified evidence; never infer completion from a transport status alone. */
  readonly reportOutcome?: (evidence: OperationEvidence) => void;
  /** Trusted request attribution for native public writes; never an argument or expression value. */
  readonly publicAdmission?: { readonly network: string; readonly visitor?: string };
  /** Evaluated, validated arguments. */
  readonly args: Readonly<Record<string, unknown>>;
  /** Managed variables resolved for the deployment scope. */
  readonly env?: Readonly<Record<string, unknown>>;
  /** Request-scoped cancellation; connectors should propagate it to outbound work. */
  readonly signal?: AbortSignal;
  /**
   * The downstream-scoped credential minted by the broker — never an inbound bearer token
   * (docs/SPEC.md "Auth And Identity").
   */
  readonly credential: DownstreamCredential;
  /** Binding-selected presentation; when present it overrides connector-level legacy auth config. */
  readonly credentialPresentation?: CredentialProfile;
  /** Lazy deployment credential for an explicitly declared independent transport; called only after egress validation. */
  readonly acquireTransportCredential?: () => Promise<DownstreamCredential>;
  /** Verified caller claims, when the access mode intentionally exposes them to execution. */
  readonly caller?: CallerIdentity;
  /** Full request-local route supplied only to the connector that needs it. */
  readonly route?: CustomerConnectorRoute;
  /** Optional host capability for sandboxed connectors; ignored by ordinary connectors. */
  readonly host?: ConnectorCallHost;
  /**
   * Optional execution trace sink for connector-side observability (e.g. sandbox queue-wait vs
   * execution durations). Connectors record only flat scalar fields; the runtime still owns the
   * failure-event path.
   */
  readonly trace?: ExecutionTraceSink;
}

/**
 * A connector: a versioned integration exposing typed operations. Phase 1 ships only an in-memory
 * implementation; the `http` and sandboxed `custom` kinds are later slices. The runtime treats a
 * connector as a port — it owns its transport, retries, and error normalization.
 */
export interface Connector {
  readonly id: string;
  readonly version: string;
  /** The operation's signature, used for signature-drift verification and argument/output checks. */
  signature(operation: string): OperationSignature | undefined;
  /** Maximum action execution duration owned by this connector; excludes confirmation/model time. */
  executionBoundMs?(operation: string): number | undefined;
  /** Invoke the operation. May reject; the runtime normalizes the failure (no secret leakage). */
  invoke(call: ConnectorCall): Promise<unknown>;
}

/** Maps a resolved operation reference to the connector that can serve it. */
export interface ConnectorRegistry {
  resolve(ref: ResolvedOperationRef): Connector | undefined;
}
