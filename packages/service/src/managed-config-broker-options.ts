import type { RuntimeArtifact } from '@noodle-borg/compiler';
import type { DelegatedTokenExchangeBrokerOptions } from './credential-broker-delegated-token-exchange.js';
import type { BoundExternalCredentialExchangeOptions } from './external-credential-exchange.js';
import type { GoogleWorkloadIdentityOptions } from './google-workload-identity.js';
import type { OAuthStore } from './oauth/store.js';
import type { SecretEnvelope, TenantAuthConfig } from './store.js';

export interface ManagedConfigBrokerOptions extends DelegatedTokenExchangeBrokerOptions {
  readonly artifact?: RuntimeArtifact;
  readonly delegatedCredentialStore?: Pick<
    OAuthStore,
    'getDelegatedCredential' | 'putDelegatedCredential'
  >;
  readonly serverAuth?: TenantAuthConfig;
  readonly openCustomerCredential?: (credential: SecretEnvelope) => Promise<string>;
  readonly sealCustomerCredential?: (credential: string) => Promise<SecretEnvelope>;
  /** Deployment-owned account credential exchange; distinct from ADR 0152 end-user delegation. */
  readonly externalCredentialExchange?: BoundExternalCredentialExchangeOptions;
  /** Keyless Google WIF exchange using the platform's OIDC issuer and deployment identity. */
  readonly googleWorkloadIdentity?: GoogleWorkloadIdentityOptions;
}
