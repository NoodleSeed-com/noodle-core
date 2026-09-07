import type { SigningKeyProvider } from '@noodle-borg/auth';
import { mintOAuthAccessToken } from './token-issuer.js';

export interface IssueServicePrincipalAccessTokenInput {
  readonly principalId: string;
  readonly resource: string;
  readonly scope?: string;
  readonly grantId: string;
  readonly credentialId: string;
  readonly ttlSeconds: number;
}

/** Mint one service-marked token while keeping private lifecycle bindings out of the public caller. */
export function issueServicePrincipalAccessToken(
  signer: SigningKeyProvider,
  issuer: string,
  input: IssueServicePrincipalAccessTokenInput,
): Promise<string> {
  return mintOAuthAccessToken({
    signer,
    issuer,
    ttlSeconds: input.ttlSeconds,
    identity: {
      ownerSubject: input.principalId,
      resource: input.resource,
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      roles: [],
      identityKind: 'service',
      oauthClientId: input.principalId,
      servicePrincipalGrantId: input.grantId,
      servicePrincipalCredentialId: input.credentialId,
    },
  });
}
