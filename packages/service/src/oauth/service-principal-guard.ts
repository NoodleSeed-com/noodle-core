import type { TokenVerifier, VerifiedTokenEnvelope } from '@noodle-borg/auth';
import type { OwnerTokenVerification, OwnerTokenVerifier } from '@noodle-borg/module';
import type { ServicePrincipalStore } from './service-principal-store.js';

export interface ResolvedServicePrincipalTarget {
  readonly org: string;
  readonly app: string;
  readonly environment: string;
}

type ServiceCapableTokenVerifier = (
  token: string,
  resource: string,
) => Promise<VerifiedTokenEnvelope | OwnerTokenVerification | null>;

/**
 * Revalidate the private principal/grant/credential binding for every machine-authenticated data-plane
 * request. The private binding is consumed here and never projected into the protocol caller context.
 */
export function guardServicePrincipalAccessTokenVerifier(
  verifier: TokenVerifier | ServiceCapableTokenVerifier,
  store: ServicePrincipalStore | undefined,
  resolveResource: (resource: string) => Promise<ResolvedServicePrincipalTarget | undefined>,
  now: () => number = Date.now,
): OwnerTokenVerifier {
  return async (token, resource) => {
    const verification = await verifier(token, resource);
    if (verification === null || verification.caller.identityKind !== 'service') {
      return verification;
    }
    const binding = 'servicePrincipal' in verification ? verification.servicePrincipal : undefined;
    if (binding === undefined || store === undefined) return null;
    try {
      const target = await resolveResource(resource);
      if (target === undefined) return null;
      const valid = await store.validateAccessBinding({
        principalId: verification.caller.subject,
        grantId: binding.grantId,
        credentialId: binding.credentialId,
        org: target.org,
        app: target.app,
        environment: target.environment,
        now: now(),
      });
      return valid ? { caller: verification.caller } : null;
    } catch {
      return null;
    }
  };
}
