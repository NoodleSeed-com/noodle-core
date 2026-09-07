import type { CustomerRouteBinding } from '@noodle-borg/runtime';

/**
 * Add a request-local customer route to an in-memory credential identity.
 *
 * Legacy calls return the original key exactly. Routed calls copy only the allowlisted safe fields into
 * a structured identity, so a structurally compatible object carrying `baseUrl` cannot enter a cache key.
 */
export function routeBoundCredentialKey(
  baseKey: string,
  route: CustomerRouteBinding | undefined,
): string {
  return route === undefined
    ? baseKey
    : JSON.stringify(['customer-route', 1, baseKey, route.key, route.fingerprint]);
}

/** Copy only the safe route fields across a credential/assertion boundary. */
export function copyCustomerRouteBinding(route: CustomerRouteBinding): CustomerRouteBinding;
export function copyCustomerRouteBinding(route: undefined): undefined;
export function copyCustomerRouteBinding(
  route: CustomerRouteBinding | undefined,
): CustomerRouteBinding | undefined {
  return route === undefined
    ? undefined
    : Object.freeze({ key: route.key, fingerprint: route.fingerprint });
}
