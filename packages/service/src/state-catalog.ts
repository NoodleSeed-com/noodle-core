import { BUILTIN_RECORD_CATALOG_CONNECTOR, type CatalogConnector } from '@noodle-borg/compiler';
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
  const builtins = [BUILTIN_STATE_CATALOG_CONNECTOR, BUILTIN_RECORD_CATALOG_CONNECTOR];
  return [
    ...builtins,
    ...catalog.filter((entry) => !builtins.some((builtin) => builtin.id === entry.id)),
  ];
}
