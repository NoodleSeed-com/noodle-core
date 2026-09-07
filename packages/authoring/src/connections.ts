import type { ConnectionBinding, ConnectionRef, ConnectionSource } from './connection-types.js';
import type { ConnectorRef } from './connectors.js';

export {
  clientCredentials,
  externalExchange,
  googleWorkloadIdentity,
  managedSecret,
} from './connection-types.js';

const NAME = /^[a-z0-9_]+$/;

/** Name one logical connection. The id is stable app configuration, not a provider account id. */
export function connection(id: string, source: ConnectionSource): ConnectionRef {
  if (!NAME.test(id)) {
    throw new Error(`connection id "${id}" must use lowercase letters, numbers, and underscores`);
  }
  return { id, source };
}

/** Bind a connector ref to one credential profile and logical connection. */
export interface BoundConnectorRef<ProfileKey extends string = string>
  extends ConnectorRef<ProfileKey> {
  readonly binding: ConnectionBinding<ProfileKey>;
}

export function bind<ProfileKey extends string>(
  connector: ConnectorRef<ProfileKey>,
  options: { readonly profile: NoInfer<ProfileKey>; readonly connection: ConnectionRef },
): BoundConnectorRef<ProfileKey> {
  if (!NAME.test(options.profile)) {
    throw new Error(
      `credential profile "${options.profile}" must use lowercase letters, numbers, and underscores`,
    );
  }
  return {
    id: connector.id,
    version: connector.version,
    operations: connector.operations,
    ...(connector.credentialProfiles !== undefined
      ? { credentialProfiles: connector.credentialProfiles }
      : {}),
    ...(connector.definitions !== undefined ? { definitions: connector.definitions } : {}),
    ...(connector.httpDef !== undefined ? { httpDef: connector.httpDef } : {}),
    ...(connector.mcpDef !== undefined ? { mcpDef: connector.mcpDef } : {}),
    binding: { profile: options.profile, connection: options.connection },
  };
}

export type {
  ConnectionBinding,
  ConnectionRef,
  ConnectionSource,
  GoogleWorkloadIdentityAccess,
} from './connection-types.js';

type ManifestV2ConnectorBinding = NonNullable<
  NonNullable<Extract<Manifest, { manifestVersion: '2' }>['connectors']>[string]['binding']
>;

/** Internal manifest projection: clone readonly author inputs to the mutable generated schema shape. */
function toManifestConnectionBinding(binding: ConnectionBinding): ManifestV2ConnectorBinding {
  const source = binding.connection.source;
  return {
    profile: binding.profile,
    connection: {
      id: binding.connection.id,
      source:
        source.kind === 'clientCredentials'
          ? {
              kind: 'clientCredentials',
              tokenUrl: source.tokenUrl,
              clientId: source.clientId,
              clientSecret: source.clientSecret,
              ...(source.scopes !== undefined ? { scopes: [...source.scopes] } : {}),
              ...(source.audience !== undefined ? { audience: source.audience } : {}),
              ...(source.authMethod !== undefined ? { authMethod: source.authMethod } : {}),
            }
          : source.kind === 'managedSecret'
            ? {
                kind: 'managedSecret',
                secret: source.secret,
                ...(source.scopes !== undefined ? { scopes: [...source.scopes] } : {}),
                ...(source.audience !== undefined ? { audience: source.audience } : {}),
              }
            : source.kind === 'googleWorkloadIdentity'
              ? {
                  kind: 'googleWorkloadIdentity',
                  provider: source.provider,
                  access:
                    source.access.kind === 'direct'
                      ? { kind: 'direct' }
                      : {
                          kind: 'serviceAccountImpersonation',
                          serviceAccount: source.access.serviceAccount,
                        },
                }
              : { kind: 'externalExchange' },
    },
  };
}

export function toManifestConnectorRef(connector: ConnectorRef): {
  readonly id: string;
  readonly version: string;
  readonly binding?: ManifestV2ConnectorBinding;
} {
  return {
    id: connector.id,
    version: connector.version,
    ...(connector.binding !== undefined
      ? { binding: toManifestConnectionBinding(connector.binding) }
      : {}),
  };
}

import type { Manifest } from '@noodle-borg/compiler';
