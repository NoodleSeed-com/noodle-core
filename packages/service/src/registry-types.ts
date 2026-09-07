import type { CapabilityName } from '@noodle-borg/capabilities';
import type { CatalogConnector, HostedPackagedAsset } from '@noodle-borg/compiler';
import type { ControlPlaneIdentity } from '@noodle-borg/control-plane/portable';
import type { OrgMembershipSource, PolicyGate } from '@noodle-borg/module';
import type { Connector } from '@noodle-borg/runtime';
import type { AccessMode, OwnerTokenVerifier } from '@noodle-borg/transport-http';
import type { DeploymentSource } from '@noodle-borg/wire-contracts';
import type { AppPackageRenderer } from './app-package-snapshot.js';
import type { DelegatedExchangeOptions } from './delegated-token-exchange.js';
import type { ExternalCredentialExchangeRuntimeOptions } from './external-credential-exchange.js';
import type { GoogleWorkloadIdentityRuntimeOptions } from './google-workload-identity.js';
import type { LocalDevtoolsDelegatedExchangeRuntime } from './local-devtools-delegated-exchange.js';
import type { NativeRecordConnectorFactory } from './native-record-connector.js';
import type { OAuthStore } from './oauth/store.js';
import type { StateHandleStoreFactory } from './state-connector-factory.js';
import type { DeployRecord, SecretEnvelope, TenantAuthConfig } from './store.js';

/**
 * Everything optional about one deploy. Collected into a bag rather than a positional tail: `deploy` had
 * grown to nine positional parameters, so most callers threaded `undefined` through slots they did not
 * care about, and each new field made the next one harder to argue against.
 */
export interface DeployOptions {
  readonly connectors?: string | undefined;
  readonly actor?: ControlPlaneIdentity | undefined;
  readonly accessMode?: AccessMode | undefined;
  /** Effective OAuth subject for an owner-only deployment, distinct from the deploy actor. */
  readonly ownerSubject?: string | undefined;
  readonly orgMembershipSources?: readonly OrgMembershipSource[] | undefined;
  readonly hostedAssets?: readonly HostedPackagedAsset[] | undefined;
  readonly serverVersion?: string | undefined;
  readonly deploymentSource?: DeploymentSource | undefined;
  /**
   * A service-validated content key for retry-safe CLI deploys. The registry derives a stable
   * deployment id from it; callers that omit it retain the normal fresh-deployment behavior.
   */
  readonly idempotencyKey?: string | undefined;
  /** Provider-neutral automation identity revalidated by a module inside activation. */
  readonly automationId?: string | undefined;
}

/** A deploy error from compiling either the connector catalog or the manifest. */
export interface DeployError {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export type DeployResult =
  | {
      readonly ok: true;
      readonly deploymentId: string;
      readonly deploymentVersion: number;
      readonly serverVersion?: string;
      readonly accessMode?: AccessMode;
      readonly ownerSubject?: string;
      readonly replayed?: boolean;
    }
  | { readonly ok: false; readonly errors: readonly DeployError[] };

export type DeployPreflightResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: readonly DeployError[] };

export type RunDeployResult =
  | DeployResult
  | {
      readonly ok: false;
      readonly conflict: true;
      readonly code: 'idempotency_conflict' | 'deployment_locked';
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly superseded: true;
      readonly deploymentId: string;
      readonly deploymentVersion: number;
      readonly serverVersion?: string;
    };

export type AccessUpdateFailureCode =
  | 'no_active_deployment'
  | 'server_auth_required'
  | 'customer_auth_audience_conflict'
  | 'public_user_context_conflict'
  | 'owner_identity_required'
  | 'access_update_conflict';

export type AccessUpdateResult =
  | {
      readonly ok: true;
      readonly changed: boolean;
      readonly accessChanged: boolean;
      readonly ownerChanged: boolean;
      readonly previousAccessMode: AccessMode;
      readonly previousOwnerSubject?: string;
      readonly record: DeployRecord;
    }
  | {
      readonly ok: false;
      readonly status: 404 | 409;
      readonly code: AccessUpdateFailureCode;
      readonly message: string;
    };

export interface AccessUpdateOptions {
  readonly accessMode: AccessMode;
  readonly ownerSubject?: string | undefined;
  readonly serverVersion?: string | undefined;
}

export interface ServerRegistryOptions {
  readonly nativeRecords?: NativeRecordConnectorFactory;
  /** Pure renderer injection used for deployment-bound package construction and failure testing. */
  readonly renderAppPackage?: AppPackageRenderer;
  readonly customerVerifierFactory?: (auth: TenantAuthConfig) => OwnerTokenVerifier;
  readonly policyGate?: PolicyGate;
  /** The backing store executes module deployment hooks inside its activation transaction. */
  readonly transactionalModuleDeploymentActivation?: boolean;
  readonly serviceCapabilities?: readonly CapabilityName[];
  readonly platformCatalog?: readonly CatalogConnector[];
  readonly platformConnectors?: readonly Connector[];
  readonly stateHandleStoreFactory?: StateHandleStoreFactory;
  readonly delegatedCredentialStore?: Pick<
    OAuthStore,
    'getDelegatedCredential' | 'putDelegatedCredential'
  >;
  readonly sealCustomerCredential?: (credential: string) => Promise<SecretEnvelope>;
  readonly openCustomerCredential?: (credential: SecretEnvelope) => Promise<string>;
  /**
   * Platform issuer + signer for `delegatedTokenExchange` connector auth (ADR 0152); the registry
   * completes it per deployment with tenant/deployment identity when it builds each broker.
   */
  readonly delegatedExchange?: Pick<DelegatedExchangeOptions, 'issuer' | 'signer'>;
  /** Loopback-only authority resolved lazily after a valid delegated-exchange compile. */
  readonly localDevtoolsDelegatedExchange?: LocalDevtoolsDelegatedExchangeRuntime;
  /**
   * Deployment-owned external account exchange. The registry adds authoritative tenant/deployment
   * identity per served artifact; no provider lifecycle or endpoint registry is exposed over HTTP. Hosted
   * composition must supply a durable shared atomic subject-pin store.
   */
  readonly externalCredentialExchange?: ExternalCredentialExchangeRuntimeOptions;
  /** Platform OIDC identity exchanged keylessly through Google Workload Identity Federation. */
  readonly googleWorkloadIdentity?: GoogleWorkloadIdentityRuntimeOptions;
}

/** Outcome of recover: how many servers were rebuilt, and which records failed. */
export interface RecoverResult {
  readonly recovered: number;
  readonly failed: ReadonlyArray<{
    readonly deploymentId: string;
    readonly errors: readonly DeployError[];
  }>;
}
