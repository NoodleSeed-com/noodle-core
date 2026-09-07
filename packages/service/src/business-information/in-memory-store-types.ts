import type { ManagedDefinitionResolver } from './managed-releases.js';

export interface IdempotencyRecord {
  readonly fingerprint: string;
  readonly recordKey: string;
}

export interface InMemoryBusinessInformationStoreOptions {
  readonly now?: () => Date;
  readonly id?: () => string;
  readonly publicId?: () => string;
  /** Service-wide stable managed release resolver; injection exists for deterministic release tests. */
  readonly managedDefinition?: ManagedDefinitionResolver;
}
