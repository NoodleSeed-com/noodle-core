import type { PreparedPackagedAsset } from '@noodle-borg/compiler';
import { formatWireError, preparedAssetSchema } from '@noodle-borg/wire-contracts';
import { z } from 'zod';

const preparedAssetsSchema = z.array(preparedAssetSchema);

/**
 * Parse the preflight `assets` list against the deploy-lane wire contract (ADR 0150). The wire shape
 * has no `absolutePath` (the CLI strips its local path); the compiler's `PreparedPackagedAsset` type
 * requires one, so the service normalizes it to `''` after the wire parse.
 */
export function parsePreparedAssets(value: unknown): readonly PreparedPackagedAsset[] {
  const parsed = preparedAssetsSchema.safeParse(value);
  if (!parsed.success) throw new Error(formatWireError(parsed.error));
  return parsed.data.map((asset) => ({ ...asset, absolutePath: '' }));
}
