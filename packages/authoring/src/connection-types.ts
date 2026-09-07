import type { ConfigRef } from './config.js';
import { serializeSecretRef, serializeVariableRef } from './config.js';

const connectionSourceBrand: unique symbol = Symbol('noodle.connectionSource');

/** Credential source descriptors carry managed reference names only, never credential values. */
type ConnectionSourceShape =
  | { readonly kind: 'externalExchange' }
  | {
      readonly kind: 'managedSecret';
      readonly secret: string;
      readonly scopes?: readonly string[];
      readonly audience?: string;
    }
  | {
      readonly kind: 'clientCredentials';
      readonly tokenUrl: string;
      readonly clientId: string;
      readonly clientSecret: string;
      readonly scopes?: readonly string[];
      readonly audience?: string;
      readonly authMethod?: 'client_secret_basic' | 'client_secret_post';
    }
  | {
      readonly kind: 'googleWorkloadIdentity';
      readonly provider: string;
      readonly access:
        | { readonly kind: 'direct' }
        | {
            readonly kind: 'serviceAccountImpersonation';
            readonly serviceAccount: string;
          };
    };

/**
 * An opaque credential source created by one of the canonical source factories. The private brand keeps
 * raw structural objects (and therefore accidental credential literals) out of `connection(...)`.
 */
export type ConnectionSource = ConnectionSourceShape & {
  readonly [connectionSourceBrand]: true;
};

type ConnectionSourceBrand = { readonly [connectionSourceBrand]: true };

function markConnectionSource<Shape extends ConnectionSourceShape>(
  source: Shape,
): Shape & ConnectionSourceBrand {
  brandConnectionSource(source);
  return source;
}

function brandConnectionSource<Shape extends ConnectionSourceShape>(
  source: Shape,
): asserts source is Shape & ConnectionSourceBrand {
  Object.defineProperty(source, connectionSourceBrand, { value: true });
}

/** A deployment-owned external exchange connection. Provider lifecycle stays outside Core. */
export function externalExchange(): ConnectionSource {
  return markConnectionSource({ kind: 'externalExchange' });
}

export type GoogleWorkloadIdentityAccess =
  | { readonly kind: 'direct' }
  | {
      readonly kind: 'serviceAccountImpersonation';
      readonly serviceAccount: ConfigRef;
    };

/**
 * A keyless Google Workload Identity Federation connection. The provider resource and optional
 * service-account identity are non-secret deployment variables; Google credentials are minted by the broker.
 */
export function googleWorkloadIdentity(options: {
  readonly provider: ConfigRef;
  readonly access: GoogleWorkloadIdentityAccess;
}): ConnectionSource {
  return markConnectionSource({
    kind: 'googleWorkloadIdentity',
    provider: serializeVariableRef(options.provider, 'connection.source.provider'),
    access:
      options.access.kind === 'direct'
        ? { kind: 'direct' }
        : {
            kind: 'serviceAccountImpersonation',
            serviceAccount: serializeVariableRef(
              options.access.serviceAccount,
              'connection.source.access.serviceAccount',
            ),
          },
  });
}

/** A connection backed by one managed secret reference and any capabilities known for that secret. */
export function managedSecret(
  secret: ConfigRef,
  capabilities: { readonly scopes?: readonly string[]; readonly audience?: string } = {},
): ConnectionSource {
  return markConnectionSource({
    kind: 'managedSecret',
    secret: serializeSecretRef(secret, 'connection.source.secret'),
    ...(capabilities.scopes !== undefined ? { scopes: [...capabilities.scopes] } : {}),
    ...(capabilities.audience !== undefined ? { audience: capabilities.audience } : {}),
  });
}

/** A connection whose short-lived bearer is minted from managed client-credentials references. */
export function clientCredentials(options: {
  readonly tokenUrl: ConfigRef;
  readonly clientId: ConfigRef;
  readonly clientSecret: ConfigRef;
  readonly scopes?: readonly string[];
  readonly audience?: string;
  readonly authMethod?: 'client_secret_basic' | 'client_secret_post';
}): ConnectionSource {
  return markConnectionSource({
    kind: 'clientCredentials',
    tokenUrl: serializeVariableRef(options.tokenUrl, 'connection.source.tokenUrl'),
    clientId: serializeVariableRef(options.clientId, 'connection.source.clientId'),
    clientSecret: serializeSecretRef(options.clientSecret, 'connection.source.clientSecret'),
    ...(options.scopes !== undefined ? { scopes: [...options.scopes] } : {}),
    ...(options.audience !== undefined ? { audience: options.audience } : {}),
    ...(options.authMethod !== undefined ? { authMethod: options.authMethod } : {}),
  });
}

export interface ConnectionRef {
  readonly id: string;
  readonly source: ConnectionSource;
}

export interface ConnectionBinding<ProfileKey extends string = string> {
  readonly profile: ProfileKey;
  readonly connection: ConnectionRef;
}
