import type {
  CatalogConnector,
  CredentialProfile,
  OperationCredentialRequirement,
} from '@noodle-borg/compiler';
import type { ConnectorDef } from './schema.js';

/** Project catalog operation credential metadata without adding it to compatibility signatures. */
function operationCredentials(
  def: ConnectorDef,
): Record<string, OperationCredentialRequirement> | undefined {
  const requirements: Record<string, OperationCredentialRequirement> = {};
  for (const [name, operation] of Object.entries(def.operations)) {
    const credentials = operation.credentials;
    if (credentials === undefined) continue;
    requirements[name] = {
      profiles: [...credentials.profiles],
      ...(credentials.scopes !== undefined ? { scopes: [...credentials.scopes] } : {}),
      ...(credentials.audience !== undefined ? { audience: credentials.audience } : {}),
    };
  }
  return Object.keys(requirements).length > 0 ? requirements : undefined;
}

export function catalogCredentialMetadata(
  def: ConnectorDef,
): Pick<CatalogConnector, 'credentialProfiles' | 'operationCredentials'> {
  const requirements = operationCredentials(def);
  return {
    ...(def.credentialProfiles !== undefined
      ? { credentialProfiles: def.credentialProfiles as Record<string, CredentialProfile> }
      : {}),
    ...(requirements !== undefined ? { operationCredentials: requirements } : {}),
  };
}
