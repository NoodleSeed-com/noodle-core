import type { OwnerTokenVerifier } from '@noodle-borg/transport-http';
import { bridgeCustomerIssuer } from './oauth/customer-bridge.js';
import type { TenantAuthConfig, TenantBridgeAuthConfig } from './store.js';

export function createHostedCustomerVerifierFactory(
  rawFactory: (auth: TenantAuthConfig) => OwnerTokenVerifier,
  platformVerifier: OwnerTokenVerifier | undefined,
  options: {
    readonly resolveBridgeAuth?: (
      auth: TenantBridgeAuthConfig,
      resource: string,
    ) => Promise<TenantBridgeAuthConfig | undefined>;
  } = {},
): (auth: TenantAuthConfig) => OwnerTokenVerifier {
  return (auth) => {
    if (auth.kind !== 'bridge') return rawFactory(auth);
    if (platformVerifier === undefined) return async () => null;
    return async (token, resource) => {
      const verification = await platformVerifier(token, resource);
      if (
        verification?.caller.identityKind !== 'customer' ||
        verification.caller.identityProvider !== auth.provider
      ) {
        return null;
      }
      if (verification.customerIssuer === undefined) {
        return { caller: verification.caller };
      }
      if (
        resource === undefined ||
        resource.length === 0 ||
        options.resolveBridgeAuth === undefined
      ) {
        return null;
      }
      let resolved: TenantBridgeAuthConfig | undefined;
      try {
        resolved = await options.resolveBridgeAuth(auth, resource);
      } catch {
        return null;
      }
      if (resolved === undefined || resolved.provider !== auth.provider) return null;
      const expectedIssuer = bridgeCustomerIssuer(resolved);
      if (expectedIssuer === undefined || expectedIssuer !== verification.customerIssuer)
        return null;
      return { caller: verification.caller, customerIssuer: expectedIssuer };
    };
  };
}

/**
 * Local Devtools accepts Firebase and Microsoft ID tokens directly because no hosted Noodle issuer exists
 * in the author loop. The configured provider still verifies signature, issuer, and audience; this wrapper
 * then binds the customer identity to the exact loopback MCP resource. Other bridge providers remain denied.
 */
export function createLocalDevtoolsCustomerVerifierFactory(
  rawFactory: (auth: TenantAuthConfig) => OwnerTokenVerifier,
  options: {
    readonly allowedProviders?: readonly ('firebase' | 'microsoft')[];
    readonly resolveBridgeAuth?: (
      auth: TenantBridgeAuthConfig,
      resource: string,
    ) => Promise<TenantBridgeAuthConfig>;
  } = {},
): (auth: TenantAuthConfig) => OwnerTokenVerifier {
  return (auth) => {
    if (auth.kind !== 'bridge') return rawFactory(auth);
    if (auth.provider !== 'firebase' && auth.provider !== 'microsoft') return async () => null;
    if (
      options.allowedProviders !== undefined &&
      !options.allowedProviders.includes(auth.provider)
    ) {
      return async () => null;
    }
    const resolveBridgeAuth = options.resolveBridgeAuth;
    if (resolveBridgeAuth !== undefined) {
      return async (token, resource) => {
        if (resource === undefined || resource.length === 0) return null;
        let resolved: TenantBridgeAuthConfig;
        try {
          resolved = await resolveBridgeAuth(auth, resource);
        } catch {
          return null;
        }
        if (resolved.provider !== auth.provider) return null;
        return bindLocalBridgeIdentity(rawFactory(resolved), resolved, token, resource);
      };
    }
    const verifyBridge = rawFactory(auth);
    return async (token, resource) => {
      if (resource === undefined || resource.length === 0) return null;
      return bindLocalBridgeIdentity(verifyBridge, auth, token, resource);
    };
  };
}

async function bindLocalBridgeIdentity(
  verifier: OwnerTokenVerifier,
  auth: TenantBridgeAuthConfig,
  token: string,
  resource: string,
) {
  const providerAudience =
    auth.provider === 'firebase' ? (auth.projectId ?? '') : (auth.clientId ?? '');
  const verification = await verifier(token, providerAudience);
  if (verification === null) return null;
  return {
    caller: {
      ...verification.caller,
      audience: resource,
      identityKind: 'customer' as const,
      identityProvider: auth.provider,
    },
  };
}
