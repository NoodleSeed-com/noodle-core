import {
  type ExternalCredentialAssertionVerifierOptions,
  verifyExternalCredentialWorkloadAssertion,
} from './assertion.js';
import {
  type ExternalCredentialExchangeRequest,
  type ExternalCredentialExchangeResponse,
  type ExternalCredentialWorkloadClaims,
  externalCredentialExchangeRequestSchema,
  externalCredentialExchangeResponseSchema,
} from './contract.js';

export interface ExternalCredentialProvider {
  exchange(input: unknown): Promise<unknown>;
}

export function createFakeExternalCredentialProvider(input: {
  readonly verifier: ExternalCredentialAssertionVerifierOptions;
  readonly issueCredential: (
    claims: ExternalCredentialWorkloadClaims,
  ) => Promise<ExternalCredentialExchangeResponse> | ExternalCredentialExchangeResponse;
}): ExternalCredentialProvider {
  return {
    async exchange(raw: unknown): Promise<ExternalCredentialExchangeResponse> {
      const request = externalCredentialExchangeRequestSchema.parse(raw);
      const claims = await verifyExternalCredentialWorkloadAssertion(
        request.subject_token,
        input.verifier,
      );
      assertRequestedCapabilitiesMatch(request, claims);
      return externalCredentialExchangeResponseSchema.parse(await input.issueCredential(claims));
    },
  };
}

/** Run the same strict request/response checks used by the Noodle service against a provider adapter. */
export async function assertExternalCredentialProviderConformance(input: {
  readonly provider: ExternalCredentialProvider;
  readonly request: ExternalCredentialExchangeRequest;
}): Promise<ExternalCredentialExchangeResponse> {
  const request = externalCredentialExchangeRequestSchema.parse(input.request);
  return externalCredentialExchangeResponseSchema.parse(await input.provider.exchange(request));
}

function assertRequestedCapabilitiesMatch(
  request: ExternalCredentialExchangeRequest,
  claims: ExternalCredentialWorkloadClaims,
): void {
  const expectedScope = claims.scopes.length === 0 ? undefined : claims.scopes.join(' ');
  if (request.scope !== expectedScope || request.audience !== claims.requested_audience) {
    throw new Error('external credential request capability mismatch');
  }
}
