import type { Manifest } from '@noodle-borg/compiler';
import { type ConfigRef, isConfigRef, serializeSecretRef, serializeVariableRef } from './config.js';

export interface CustomerAuthClaimMap {
  readonly id?: string;
  readonly email?: string;
  readonly name?: string;
  readonly tenant?: string;
  readonly orgs?: string;
  readonly roles?: string;
  readonly scopes?: string;
}

export interface CustomerEndpointClaimMapping {
  readonly claim: string;
}

export interface CustomerAuthRouting {
  readonly endpoints: Readonly<Record<string, CustomerEndpointClaimMapping>>;
}

export interface FederatedOidcIssuer {
  readonly issuer: string;
  readonly audience: string;
  readonly claims?: CustomerAuthClaimMap;
  readonly routing?: CustomerAuthRouting;
}

export type CustomerAuth =
  | {
      readonly kind?: 'oidc';
      readonly issuer: string;
      readonly audience: string;
      readonly claims?: CustomerAuthClaimMap;
      readonly routing?: CustomerAuthRouting;
    }
  | {
      readonly kind: 'federatedOidc';
      readonly issuers: readonly FederatedOidcIssuer[];
    }
  | {
      readonly kind: 'bridge';
      readonly provider: 'firebase' | 'microsoft';
      readonly verifyUrl?: string;
      readonly authorizeUrl?: string;
      readonly projectId?: string;
      readonly apiKey?: string;
      readonly authDomain?: string;
      readonly appId?: string;
      readonly tenantId?: string;
      readonly audience?: string;
      readonly clientId?: string;
      readonly clientSecret?: string;
      readonly tokenUrl?: string;
      readonly scopes?: string[];
      readonly authMethod?: 'client_secret_basic' | 'client_secret_post';
      readonly user?: CustomerAuthClaimMap;
    };

export const customerAuth = {
  oidc(options: {
    readonly issuer: string;
    readonly audience: string;
    readonly claims?: CustomerAuthClaimMap;
    readonly routing?: CustomerAuthRouting;
  }): CustomerAuth {
    const { claims, routing, ...rest } = options;
    return {
      kind: 'oidc',
      ...rest,
      ...(claims !== undefined ? { claims } : {}),
      ...(routing !== undefined ? { routing: copyRouting(routing) } : {}),
    };
  },
  federatedOidc(options: { readonly issuers: readonly FederatedOidcIssuer[] }): CustomerAuth {
    return {
      kind: 'federatedOidc',
      issuers: options.issuers.map((issuer) => ({
        issuer: issuer.issuer,
        audience: issuer.audience,
        ...(issuer.claims === undefined ? {} : { claims: issuer.claims }),
        ...(issuer.routing === undefined ? {} : { routing: copyRouting(issuer.routing) }),
      })),
    };
  },
  firebase(options: {
    readonly projectId: string | ConfigRef;
    readonly apiKey: string | ConfigRef;
    readonly authDomain?: string | ConfigRef;
    readonly appId?: string | ConfigRef;
    readonly authorizeUrl?: string;
    readonly tenantId?: string | ConfigRef;
    readonly user?: CustomerAuthClaimMap;
  }): CustomerAuth {
    return {
      kind: 'bridge',
      provider: 'firebase',
      projectId: serializeBridgeVariable(options.projectId, 'server.auth.projectId'),
      apiKey: serializeBridgeVariable(options.apiKey, 'server.auth.apiKey'),
      ...(options.authDomain !== undefined
        ? { authDomain: serializeBridgeVariable(options.authDomain, 'server.auth.authDomain') }
        : {}),
      ...(options.appId !== undefined
        ? { appId: serializeBridgeVariable(options.appId, 'server.auth.appId') }
        : {}),
      ...(options.authorizeUrl !== undefined ? { authorizeUrl: options.authorizeUrl } : {}),
      ...(options.tenantId !== undefined
        ? { tenantId: serializeBridgeVariable(options.tenantId, 'server.auth.tenantId') }
        : {}),
      ...(options.user !== undefined ? { user: options.user } : {}),
    };
  },
  microsoft(options: {
    readonly tenantId: string | ConfigRef;
    readonly clientId: string | ConfigRef;
    readonly clientSecret: string | ConfigRef;
    readonly authorizeUrl?: string;
    readonly tokenUrl?: string;
    readonly scopes?: readonly string[];
    readonly authMethod?: 'client_secret_basic' | 'client_secret_post';
    readonly user?: CustomerAuthClaimMap;
  }): CustomerAuth {
    return {
      kind: 'bridge',
      provider: 'microsoft',
      tenantId: serializeBridgeVariable(options.tenantId, 'server.auth.tenantId'),
      clientId: serializeBridgeVariable(options.clientId, 'server.auth.clientId'),
      clientSecret: serializeBridgeSecret(options.clientSecret),
      ...(options.authorizeUrl !== undefined ? { authorizeUrl: options.authorizeUrl } : {}),
      ...(options.tokenUrl !== undefined ? { tokenUrl: options.tokenUrl } : {}),
      ...(options.scopes !== undefined ? { scopes: [...options.scopes] } : {}),
      ...(options.authMethod !== undefined ? { authMethod: options.authMethod } : {}),
      ...(options.user !== undefined ? { user: options.user } : {}),
    };
  },
} as const;

export function manifestCustomerAuth(
  auth: CustomerAuth,
): NonNullable<Extract<Manifest, { manifestVersion: '2' }>['server']['auth']> {
  if (auth.kind === 'federatedOidc') {
    return {
      kind: 'federatedOidc',
      issuers: auth.issuers.map((issuer) => ({
        issuer: issuer.issuer,
        audience: issuer.audience,
        ...(issuer.claims === undefined ? {} : { claims: issuer.claims }),
        ...(issuer.routing === undefined ? {} : { routing: copyRouting(issuer.routing) }),
      })),
    };
  }
  return { ...auth };
}

function copyRouting(routing: CustomerAuthRouting): CustomerAuthRouting {
  const endpoints: Record<string, CustomerEndpointClaimMapping> = Object.create(null);
  for (const [name, mapping] of Object.entries(routing.endpoints)) {
    endpoints[name] = { claim: mapping.claim };
  }
  return {
    endpoints,
  };
}

function serializeBridgeVariable(value: string | ConfigRef, path: string): string {
  return isConfigRef(value) ? serializeVariableRef(value, path) : value;
}

function serializeBridgeSecret(value: string | ConfigRef): string {
  return isConfigRef(value) ? serializeSecretRef(value, 'server.auth.clientSecret') : value;
}
