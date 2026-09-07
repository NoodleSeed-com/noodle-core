import type { Pool } from 'pg';
import type { DeveloperGrantStore } from './developer-grant.js';
import { DeveloperGrantAuthorizer } from './developer-grant-authorizer.js';

export interface DeveloperGrantStoreBootstrapOptions {
  readonly pool?: Pool;
  readonly store?: DeveloperGrantStore;
}

export interface DeveloperGrantAuthorizerBootstrapOptions {
  readonly grants: DeveloperGrantStore;
}

export function createDeveloperGrantAuthorizer(
  options: DeveloperGrantAuthorizerBootstrapOptions,
): DeveloperGrantAuthorizer {
  return new DeveloperGrantAuthorizer({ grants: options.grants });
}

/** Resolve the OAuth grant store while preserving PostgreSQL schema initialization for injected stores. */
export async function resolveDeveloperGrantStore(
  options: DeveloperGrantStoreBootstrapOptions,
): Promise<DeveloperGrantStore> {
  if (options.pool !== undefined) {
    const { PostgresDeveloperGrantStore } = await import('./developer-grant-store-postgres.js');
    const postgres = new PostgresDeveloperGrantStore(options.pool);
    await postgres.initialize();
    return options.store ?? postgres;
  }
  const { InMemoryDeveloperGrantStore } = await import('./developer-grant.js');
  return options.store ?? new InMemoryDeveloperGrantStore();
}
