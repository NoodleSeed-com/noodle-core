import { createHash } from 'node:crypto';
import type { BusinessInformationStore } from './contracts.js';
import { assertManagedRollbackReaders } from './managed-releases.js';
import { builtInDefinition, MANAGED_SOLUTION_PROFILE_KEYS } from './profiles.js';

export interface ManagedReaderFloorProof {
  readonly inventory: {
    readonly acceptedSchemaIdentities: number;
    readonly digest: string;
  };
  readonly readerTargets: number;
}

/** Proves the running release can read every managed schema identity ever accepted by the store. */
export async function proveManagedReaderFloor(
  store: BusinessInformationStore,
): Promise<ManagedReaderFloorProof> {
  const inventory = await store.listAcceptedSchemaInventory();
  for (const key of MANAGED_SOLUTION_PROFILE_KEYS) {
    const definition = builtInDefinition(key);
    if (definition.reference.kind !== 'managed') {
      throw new Error(`managed definition resolver returned a non-managed profile for "${key}"`);
    }
    assertManagedRollbackReaders(key, definition.reference.release, inventory);
  }
  const canonical = [...inventory]
    .map((identity) => JSON.stringify(identity))
    .sort()
    .join('\n');
  return {
    inventory: {
      acceptedSchemaIdentities: inventory.length,
      digest: `sha256:${createHash('sha256').update(canonical).digest('hex')}`,
    },
    readerTargets: MANAGED_SOLUTION_PROFILE_KEYS.length,
  };
}
