import { sha256Canonical } from '@noodle-borg/app-package';
import {
  BillingEnforcementActivationApprovalSchema,
  type LegacyBillingMigrationPreview,
} from '@noodle-borg/wire-contracts';

export function billingEnforcementActivationApprovalChecksum(value: unknown): string {
  return sha256Canonical(BillingEnforcementActivationApprovalSchema.parse(value));
}

export function legacyBillingMigrationPreviewChecksum(
  preview: Omit<LegacyBillingMigrationPreview, 'previewChecksum'> | LegacyBillingMigrationPreview,
): string {
  const { previewChecksum: _checksum, ...content } = preview as LegacyBillingMigrationPreview;
  return sha256Canonical(content);
}
