import { type CredentialRequest, CredentialUnavailableError } from '@noodle-borg/runtime';

const CUSTOMER_ROUTE_FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/u;

/**
 * Enforce the compiled credential binding's route shape before any mutable or external dependency.
 *
 * Only the URL-blind key and canonical fingerprint are inspected. Callers must invoke this after a
 * binding lookup succeeds; a connector with no credential binding legitimately receives an empty token.
 */
export function assertCredentialRequestRoute(
  request: Pick<CredentialRequest, 'route'>,
  customerEndpoint: string | undefined,
): void {
  const route = request.route;
  if (customerEndpoint === undefined) {
    if (route !== undefined) throw routeUnavailable();
    return;
  }
  if (route === undefined) throw routeUnavailable();
  try {
    const key: unknown = route.key;
    const fingerprint: unknown = route.fingerprint;
    if (
      key !== customerEndpoint ||
      typeof fingerprint !== 'string' ||
      !CUSTOMER_ROUTE_FINGERPRINT_PATTERN.test(fingerprint)
    ) {
      throw routeUnavailable();
    }
  } catch {
    throw routeUnavailable();
  }
}

function routeUnavailable(): CredentialUnavailableError {
  return new CredentialUnavailableError('connector_route_unavailable');
}
