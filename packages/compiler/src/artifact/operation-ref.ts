import type { CredentialProfile } from '../catalog/types.js';

/**
 * Reference to a connector operation before catalog resolution.
 *
 * Emitted by the `shape-only` compile path (no catalog supplied): the operation reference string
 * `<connector>.<operation>` is parsed, but the alias is NOT resolved against a connector catalog,
 * so the connector id, connector version, and operation signature hash required by docs/SPEC.md
 * "Runtime Invariants" are absent.
 */
export interface UnresolvedOperationRef {
  readonly resolved: false;
  /** The connector alias as written in the operation reference (e.g. `acme`). */
  readonly connector: string;
  readonly operation: string;
}

/**
 * Reference to a connector operation after catalog resolution.
 *
 * Carries every field docs/SPEC.md "Runtime Invariants" requires: the connector id, the pinned
 * connector version, the operation name, and the operation signature hash. Produced when a
 * connector catalog is supplied to `compile`.
 */
export interface ResolvedOperationRef {
  readonly resolved: true;
  /** The connector alias declared in the manifest `connectors` block (e.g. `acme`). */
  readonly alias: string;
  /** The catalog connector id the alias points to (e.g. `acme_orders`). */
  readonly connectorId: string;
  /** The connector version pinned by the manifest. */
  readonly connectorVersion: string;
  readonly operation: string;
  /** Stable hash of the operation signature: `sha256:<hex>`. See catalog/signature.ts. */
  readonly signatureHash: string;
  /** Core-v2 credential selection resolved from the stable alias; absent on legacy artifacts. */
  readonly credentialBinding?: ResolvedCredentialBinding;
  /** Customer-derived base-URL key for a directly routed HTTP operation; never the resolved URL. */
  readonly customerEndpoint?: string;
  /**
   * Customer endpoint keys reachable from this operation, including connector-declared nested calls.
   * Names only: claim values and resolved URLs never enter the artifact.
   */
  readonly customerEndpointDependencies?: readonly string[];
  /**
   * Customer endpoint keys reachable through action operations, including connector-declared
   * nested calls. Confirmation uses these names to bind private route fingerprints without
   * persisting resolved URLs.
   */
  readonly customerActionEndpointDependencies?: readonly string[];
}

export interface ResolvedCredentialBinding {
  readonly bindingId: string;
  readonly connectionId: string;
  /** Digest of non-secret logical connection configuration, not live secret material. */
  readonly connectionConfigRevision: string;
  readonly profile: string;
  /** Catalog-selected, non-secret presentation rule for the broker-minted credential. */
  readonly presentation: CredentialProfile;
  readonly requiredScopes: readonly string[];
  readonly requiredAudience?: string;
}

export type OperationRef = UnresolvedOperationRef | ResolvedOperationRef;
