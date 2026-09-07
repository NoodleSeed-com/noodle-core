import type { CatalogConnector } from '@noodle-borg/compiler';
import {
  STATE_CONNECTOR_ID,
  STATE_CONNECTOR_VERSION,
  STATE_OPERATION_SIGNATURES,
} from '@noodle-borg/runtime';

export const BUILTIN_STATE_CATALOG_CONNECTOR: CatalogConnector = {
  id: STATE_CONNECTOR_ID,
  version: STATE_CONNECTOR_VERSION,
  kind: 'builtin',
  operations: STATE_OPERATION_SIGNATURES,
};

export function withBuiltinStateCatalog(
  catalog: readonly CatalogConnector[],
): readonly CatalogConnector[] {
  if (
    catalog.some(
      (connector) =>
        connector.id === BUILTIN_STATE_CATALOG_CONNECTOR.id &&
        connector.version === BUILTIN_STATE_CATALOG_CONNECTOR.version,
    )
  ) {
    return catalog;
  }
  return [BUILTIN_STATE_CATALOG_CONNECTOR, ...catalog];
}
