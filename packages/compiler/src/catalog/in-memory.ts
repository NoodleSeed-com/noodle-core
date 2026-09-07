import type { CatalogConnector, ConnectorCatalog } from './types.js';

/**
 * A {@link ConnectorCatalog} backed by an in-memory list of connectors. Suitable for tests and for
 * compiling against a fixed, known catalog. A persistent / control-plane catalog implements the
 * same interface and graduates to its own package when real connectors land (see the
 * implementation log).
 */
export class InMemoryCatalog implements ConnectorCatalog {
  private readonly byKey: ReadonlyMap<string, CatalogConnector>;

  constructor(connectors: readonly CatalogConnector[]) {
    this.byKey = new Map(connectors.map((c) => [key(c.id, c.version), c]));
  }

  get(id: string, version: string): CatalogConnector | undefined {
    return this.byKey.get(key(id, version));
  }
}

function key(id: string, version: string): string {
  return JSON.stringify([id, version]);
}
