/**
 * Connector catalog contract used by the compiler to resolve operation references.
 *
 * The catalog is the source of truth for which connectors exist, at which versions, and what
 * operations each exposes (docs/SPEC.md "Connector SDK"). The compiler reads it; it never embeds
 * connector implementation or credentials. This slice models the minimal surface needed to resolve
 * an operation reference and type-check its mapped arguments; request/response mapping, auth
 * metadata, pagination, and dynamic options are deferred to later slices.
 */
import type { CustomerEndpointPolicy } from '../customer-endpoint.js';

/** Operation kind (docs/SPEC.md "Operations"). `trigger` is out of scope for Phase 1 execution. */
export type OperationType = 'read' | 'action';

/** Connector kind (docs/SPEC.md "Connector Kinds"). */
export type ConnectorKind = 'builtin' | 'catalog' | 'custom';

/** A JSON Schema 2020-12 document (object-shaped for operation input/output). */
export type JsonSchema = Record<string, unknown>;

/**
 * An operation's signature: its kind plus its input and output JSON Schemas (ADR 0139). Operation
 * I/O containers are object-typed and closed by default (`additionalProperties: false` unless the
 * author sets `true` explicitly); normalize with `normalizeOperationIoSchema` before constructing
 * one. The signature hash (catalog/signature.ts) is derived from this and determines operation
 * compatibility (docs/SPEC.md "Versioning").
 */
export interface OperationSignature {
  readonly type: OperationType;
  readonly input: JsonSchema;
  readonly output: JsonSchema;
}

/** How a broker-provided credential is presented to a connector operation. No credential value lives here. */
export type CredentialProfile =
  | { readonly kind: 'bearer' }
  | { readonly kind: 'apiKey'; readonly header: string };

/** Credential capabilities required by an operation, kept outside its compatibility signature. */
export interface OperationCredentialRequirement {
  readonly profiles: readonly string[];
  readonly scopes?: readonly string[];
  readonly audience?: string;
}

/**
 * System-derived routing integrity metadata from the validated connector call graph. Compiler and
 * runtime consumers must use trusted catalog output rather than accepting these dependency maps
 * from app input: a read-signature wrapper's transitive action boundary is represented only here.
 */
export interface CatalogCustomerRouting {
  readonly directEndpoint?: string;
  readonly endpoints: Readonly<Record<string, CustomerEndpointPolicy>>;
  readonly operationEndpoints: Readonly<Record<string, readonly string[]>>;
  readonly operationActionEndpoints: Readonly<Record<string, readonly string[]>>;
}

/** A connector as published in the catalog at a specific version. */
export interface CatalogConnector {
  readonly id: string;
  readonly version: string;
  readonly kind: ConnectorKind;
  readonly credentialProfiles?: Readonly<Record<string, CredentialProfile>>;
  readonly operationCredentials?: Readonly<Record<string, OperationCredentialRequirement>>;
  readonly operations: Readonly<Record<string, OperationSignature>>;
  /** System-derived declared compute call graph, including exact resolved target identities. */
  readonly operationCalls?: Readonly<
    Record<
      string,
      readonly {
        readonly connectorId: string;
        readonly connectorVersion: string;
        readonly operation: string;
        readonly signatureHash: string;
      }[]
    >
  >;
  readonly customerRouting?: CatalogCustomerRouting;
}

/** Read-only lookup of connectors by catalog id and pinned version. */
export interface ConnectorCatalog {
  /** Return the connector with this id at this exact version, or `undefined` if absent. */
  get(id: string, version: string): CatalogConnector | undefined;
}
