const ASSISTANT_CUSTOMER_ISSUER_PREFIX = 'urn:noodleseed:assistant-client:';

/** Private delegated-credential identity namespace derived at the authenticated client boundary. */
export function assistantCustomerIssuer(clientId: string): string {
  return `${ASSISTANT_CUSTOMER_ISSUER_PREFIX}${clientId}`;
}
