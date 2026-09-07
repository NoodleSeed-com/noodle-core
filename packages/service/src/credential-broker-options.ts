import type { DelegatedExchangeOptions } from './delegated-token-exchange.js';
import type {
  BoundExternalCredentialExchangeOptions,
  ExternalCredentialExchangeRuntimeOptions,
} from './external-credential-exchange.js';
import type {
  GoogleWorkloadIdentityOptions,
  GoogleWorkloadIdentityRuntimeOptions,
} from './google-workload-identity.js';

/** Complete deployment-bound broker exchange options without exposing provider lifecycle over HTTP. */
export function deploymentCredentialBrokerOptions(input: {
  readonly delegatedExchange:
    | Pick<
        DelegatedExchangeOptions,
        'issuer' | 'signer' | 'localDevtools' | 'onAttempt' | 'onSuccess'
      >
    | undefined;
  readonly externalCredentialExchange: ExternalCredentialExchangeRuntimeOptions | undefined;
  readonly googleWorkloadIdentity: GoogleWorkloadIdentityRuntimeOptions | undefined;
  readonly tenant: string;
  readonly deploymentId: string | undefined;
}): {
  readonly delegatedExchange?: DelegatedExchangeOptions;
  readonly externalCredentialExchange?: BoundExternalCredentialExchangeOptions;
  readonly googleWorkloadIdentity?: GoogleWorkloadIdentityOptions;
} {
  if (input.deploymentId === undefined) return {};
  return {
    ...(input.delegatedExchange === undefined
      ? {}
      : {
          delegatedExchange: {
            ...input.delegatedExchange,
            tenant: input.tenant,
            deployment: input.deploymentId,
          },
        }),
    ...(input.externalCredentialExchange === undefined
      ? {}
      : {
          externalCredentialExchange: {
            ...input.externalCredentialExchange,
            tenant: input.tenant,
            deployment: input.deploymentId,
          },
        }),
    ...(input.googleWorkloadIdentity === undefined
      ? {}
      : {
          googleWorkloadIdentity: {
            ...input.googleWorkloadIdentity,
            tenant: input.tenant,
            deployment: input.deploymentId,
          },
        }),
  };
}
