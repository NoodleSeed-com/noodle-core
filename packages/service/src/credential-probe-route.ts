import type { CredentialProbeRouteResolver, CustomerRouteBinding } from '@noodle-borg/runtime';
import { copyCustomerRouteBinding } from './credential-route-key.js';

export type CredentialProbeRouteResolution =
  | { readonly ok: true; readonly route?: CustomerRouteBinding }
  | { readonly ok: false };

/**
 * Resolve one optional deploy-plane endpoint key without ever accepting a URL into the broker.
 *
 * A routed probe without a resolver is unavailable by design. The returned binding is reconstructed
 * from the two allowlisted fields so extra structurally-compatible properties cannot cross the boundary.
 */
export function resolveCredentialProbeRoute(input: {
  readonly connectorId: string;
  readonly connectorVersion: string;
  readonly customerEndpoint?: string;
  readonly resolveRoute?: CredentialProbeRouteResolver;
}): CredentialProbeRouteResolution {
  if (input.customerEndpoint === undefined) return { ok: true };
  if (input.resolveRoute === undefined) return { ok: false };
  try {
    const resolved = input.resolveRoute({
      connectorId: input.connectorId,
      connectorVersion: input.connectorVersion,
      key: input.customerEndpoint,
    });
    if (resolved === null || resolved.key !== input.customerEndpoint) return { ok: false };
    const route = copyCustomerRouteBinding(resolved);
    return route.fingerprint.length === 0 ? { ok: false } : { ok: true, route };
  } catch {
    return { ok: false };
  }
}
