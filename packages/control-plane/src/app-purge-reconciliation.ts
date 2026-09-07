import { createHash } from 'node:crypto';
import {
  type AppPurgeReconciliationUnsignedPreviewArtifactV1,
  appPurgeReconciliationChecksumPayload,
} from '@noodle-borg/wire-contracts';

/** Hash the canonical Task 3 preview payload; both the CLI and service bind these exact bytes. */
export function computeAppPurgeReconciliationChecksum(
  unsignedArtifact: AppPurgeReconciliationUnsignedPreviewArtifactV1,
): string {
  const digest = createHash('sha256')
    .update(appPurgeReconciliationChecksumPayload(unsignedArtifact))
    .digest('hex');
  return `sha256:${digest}`;
}
