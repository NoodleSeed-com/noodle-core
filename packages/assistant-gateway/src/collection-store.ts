import type { ChannelTransaction } from './channel-store.js';
import { channelRow, channelValue } from './channel-types.js';
import type { CollectionLedger } from './collection-ledger.js';

/**
 * One sealed `interaction` row per participant inside the binding scope: the fixed id is what makes
 * "at most one open collection" true, and the row carries only the phase and expiry in the clear.
 */
export function collectionRowId(participantId: string): string {
  return `interaction:${participantId}`;
}

export async function loadCollection(
  tx: ChannelTransaction,
  bindingId: string,
  participantId: string,
): Promise<CollectionLedger | undefined> {
  return channelValue<CollectionLedger>(tx, bindingId, collectionRowId(participantId));
}

export async function saveCollection(
  tx: ChannelTransaction,
  ledger: CollectionLedger,
): Promise<void> {
  await tx.put(
    ledger.bindingId,
    channelRow(
      collectionRowId(ledger.participantId),
      'interaction',
      ledger,
      Date.parse(ledger.updatedAt),
      { state: ledger.phase, expiresAt: Date.parse(ledger.expiresAt) },
    ),
  );
}

export async function deleteCollection(
  tx: ChannelTransaction,
  bindingId: string,
  participantId: string,
): Promise<void> {
  await tx.remove(bindingId, collectionRowId(participantId));
}
