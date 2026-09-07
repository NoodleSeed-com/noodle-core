/** Engineering safeguards, independent of commercial plans and customer Activity retention. */
export const SOURCE_ORG_CUSTODY_BYTES = 1024 ** 3;
export const SOURCE_MAX_REPLICA_ROWS = 100_000;
export const SOURCE_MAX_REFRESH_KEYS = 50_000;
/** A conservative, validated upper bound for a row's non-payload representation. */
export const SOURCE_METADATA_BYTES = 4096;
export const SOURCE_REFRESH_REPLAY_MS = 30 * 86_400_000;

export class SourceCapacityError extends Error {
  readonly code = 'source_capacity_exceeded';
  constructor() {
    super(
      'Reference storage is full. Retained records remain available. Narrow the source or erase local records; refresh receipts recover capacity after their replay window.',
    );
    this.name = 'SourceCapacityError';
  }
}

export function sourceDatasetCharge(
  retained: number,
  baseline: number | undefined,
  projected: number,
): number {
  return baseline === undefined
    ? 2 * retained
    : Math.max(retained, 2 * Math.max(baseline, projected));
}

export function sourceRowCost(
  kind: 'record' | 'binding' | 'suppression' | 'refresh',
  payloadBytes: number,
  live: boolean,
): number {
  return (
    SOURCE_METADATA_BYTES + payloadBytes + (kind === 'record' && live ? SOURCE_METADATA_BYTES : 0)
  );
}

export function sourceJsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export function assertSourceMetadata(value: unknown): void {
  if (sourceJsonBytes(value) > SOURCE_METADATA_BYTES)
    throw new Error('Source metadata exceeds its reserved representation');
}
