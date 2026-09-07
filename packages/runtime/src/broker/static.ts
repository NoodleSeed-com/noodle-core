import type { CredentialBroker, CredentialRequest, DownstreamCredential } from './types.js';

/**
 * A development/test broker that hands out a single fixed service credential for every request.
 * Stands in for the real credential broker until Phase 3 introduces delegated end-user credentials.
 * It never sees an inbound token, upholding the no-token-forwarding invariant by construction.
 */
export class StaticServiceBroker implements CredentialBroker {
  readonly #credential: DownstreamCredential;

  constructor(credential: DownstreamCredential) {
    this.#credential = credential;
  }

  getCredential(_request: CredentialRequest): Promise<DownstreamCredential> {
    return Promise.resolve(this.#credential);
  }
}
