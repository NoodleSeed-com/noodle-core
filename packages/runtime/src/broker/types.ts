import type { CredentialProfile } from '@noodle-borg/compiler';
import type { CallerIdentity } from '../connector/types.js';
import type { CustomerRouteBinding, CustomerRouteRequirement } from '../customer-routing.js';

/** Stable, non-secret reasons a credential lookup can fail. */
export type CredentialUnavailableReason =
  | 'caller_identity_not_customer'
  | 'caller_audience_missing'
  | 'caller_issuer_missing'
  | 'caller_subject_missing'
  | 'credential_not_configured'
  | 'credential_exchange_failed'
  | 'connector_route_unavailable';

export interface CredentialUnavailableErrorOptions {
  readonly fix?: string;
  readonly next?: readonly string[];
}

interface CredentialUnavailableErrorSnapshot {
  readonly reason: CredentialUnavailableReason;
  readonly fix?: string;
  readonly next?: readonly string[];
}

const credentialUnavailableErrors = new WeakSet<object>();
const credentialUnavailableErrorSnapshots = new WeakMap<
  object,
  CredentialUnavailableErrorSnapshot
>();

/**
 * A broker failure whose allowlisted diagnostics are safe to return to developers and agents.
 * Arbitrary broker error messages and causes intentionally never cross the runtime boundary.
 */
export class CredentialUnavailableError extends Error {
  readonly reason: CredentialUnavailableReason;
  readonly fix?: string;
  readonly next?: readonly string[];

  constructor(
    reason: CredentialUnavailableReason,
    options: CredentialUnavailableErrorOptions = {},
  ) {
    super(`credential unavailable: ${reason}`);
    this.name = 'CredentialUnavailableError';
    this.reason = reason;
    if (options.fix !== undefined) this.fix = options.fix;
    if (options.next !== undefined) this.next = [...options.next];

    const snapshot = Object.freeze({
      reason,
      ...(options.fix === undefined ? {} : { fix: options.fix }),
      ...(options.next === undefined ? {} : { next: Object.freeze([...options.next]) }),
    });
    credentialUnavailableErrors.add(this);
    credentialUnavailableErrorSnapshots.set(this, snapshot);
  }
}

/**
 * Return constructor-time diagnostics for a genuine broker error without invoking observable
 * properties. Proxy wrappers and shape-compatible values are intentionally treated as untrusted.
 */
export function credentialUnavailableErrorSnapshot(
  value: unknown,
): CredentialUnavailableErrorSnapshot | undefined {
  if (!isObjectLike(value) || !credentialUnavailableErrors.has(value)) return undefined;
  return credentialUnavailableErrorSnapshots.get(value);
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

/**
 * A downstream-scoped credential minted by the {@link CredentialBroker} for a single connector
 * operation. It is opaque to the runtime, which only forwards it to the connector and never logs
 * or inspects it. It is NOT an inbound MCP/OAuth bearer token — the runtime never forwards those
 * to business backends (docs/SPEC.md "Auth And Identity").
 */
export type DownstreamCredential = BearerDownstreamCredential | CookieDownstreamCredential;

interface BearerDownstreamCredential {
  readonly kind?: 'bearer';
  /** Opaque secret material the connector presents to its backing system. */
  readonly token: string;
  /** Optional scope marker, for the broker's own bookkeeping. */
  readonly scope?: string;
}

interface CookieDownstreamCredential {
  readonly kind: 'cookie';
  /** Cookie header value scoped by the broker to the connector's allowed downstream origin. */
  readonly cookie: string;
  /** Absolute expiry timestamp in milliseconds when known. */
  readonly expiresAt?: number;
}

/** What the runtime tells the broker about the call it is credentialing. */
export interface CredentialRequest {
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
  /** Optional hosted execution identity; local and legacy invocation paths omit it. */
  readonly tenantId?: string;
  readonly deploymentId?: string;
  /** Verified end-user identity when the deployment authenticates a caller. */
  readonly caller?: CallerIdentity;
  /** Verified customer IdP issuer, private to broker cache and downstream identity binding. */
  readonly customerIssuer?: string;
  /** Safe request-local route binding; never contains the resolved customer URL. */
  readonly route?: CustomerRouteBinding;
}

/** Complete immutable authorization descriptor for a compiled connector binding operation. */
export interface CredentialBindingDescriptor {
  readonly connectorId: string;
  readonly connectorVersion: string;
  readonly operation: string;
  readonly bindingId: string;
  readonly connectionId: string;
  readonly connectionConfigRevision: string;
  readonly profile: string;
  readonly presentation: CredentialProfile;
  readonly requiredScopes: readonly string[];
  readonly requiredAudience?: string;
}

/**
 * Return the complete immutable binding descriptor carried by a credential request.
 * Requests with no binding metadata are legacy requests. If any binding metadata is present, every
 * required field must be present so malformed binding calls can never fall through to legacy secrets.
 */
export function credentialBindingDescriptorFromRequest(
  request: CredentialRequest,
): CredentialBindingDescriptor | undefined {
  const hasBindingMetadata =
    request.bindingId !== undefined ||
    request.connectionId !== undefined ||
    request.connectionConfigRevision !== undefined ||
    request.profile !== undefined ||
    request.presentation !== undefined ||
    request.requiredScopes !== undefined ||
    request.requiredAudience !== undefined;
  if (!hasBindingMetadata) return undefined;
  if (
    request.bindingId === undefined ||
    request.connectionId === undefined ||
    request.connectionConfigRevision === undefined ||
    request.profile === undefined ||
    request.presentation === undefined ||
    request.requiredScopes === undefined
  ) {
    throw new CredentialUnavailableError('credential_not_configured');
  }
  return {
    connectorId: request.connectorId,
    connectorVersion: request.connectorVersion,
    operation: request.operation,
    bindingId: request.bindingId,
    connectionId: request.connectionId,
    connectionConfigRevision: request.connectionConfigRevision,
    profile: request.profile,
    presentation: request.presentation,
    requiredScopes: request.requiredScopes,
    ...(request.requiredAudience === undefined
      ? {}
      : { requiredAudience: request.requiredAudience }),
  };
}

export interface DelegatedCredentialProbe {
  readonly connectorId: string;
  readonly operation?: string;
  readonly bindingId?: string;
  readonly connectionId?: string;
  readonly profile?: string;
  readonly authKind:
    | 'delegatedOAuth'
    | 'delegatedSessionCookie'
    | 'delegatedTokenExchange'
    | 'externalExchange'
    | 'googleWorkloadIdentity';
  readonly ok: boolean;
  readonly reason?: CredentialUnavailableReason;
  readonly fix?: string;
  readonly next?: readonly string[];
}

/**
 * Resolve one connector-specific customer route to the URL-blind binding accepted by credential probes.
 * The callback remains request-local; neither the frozen base URL nor its policy crosses into the broker.
 */
export type CredentialProbeRouteResolver = (
  requirement: CustomerRouteRequirement,
) => CustomerRouteBinding | null;

/**
 * Exchanges validated identity for a downstream-scoped credential. In Phase 1 there is no end-user
 * identity, so the broker returns a *service* credential. The broker is the only source of
 * connector credentials; the runtime never derives one from an inbound token (docs/SPEC.md
 * "Auth And Identity", "Policy And Security"; [ADR 0005](../../../../docs/decisions/0005-runtime-execution-boundary.md)).
 */
export interface CredentialBroker {
  getCredential(request: CredentialRequest): Promise<DownstreamCredential>;
  /**
   * Perform credential exchanges without invoking a connector operation. Implemented only by hosted
   * brokers that can enumerate their compiled delegated bindings; ordinary runtime brokers may omit it.
   */
  probeDelegatedCredentials?(
    caller: CallerIdentity,
    resolveRoute?: CredentialProbeRouteResolver,
    customerIssuer?: string,
  ): Promise<readonly DelegatedCredentialProbe[]>;
  /** Probe deployment-owned service credential exchanges without invoking a connector operation. */
  probeServiceCredentials?(
    resolveRoute?: CredentialProbeRouteResolver,
  ): Promise<readonly DelegatedCredentialProbe[]>;
}
