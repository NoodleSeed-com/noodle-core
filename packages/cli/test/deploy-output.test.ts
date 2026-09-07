import { describe, expect, it } from 'vitest';
import {
  assetFailureRecovery,
  formatAssetSummary,
  productionCapacityRecovery,
} from '../src/commands/deploy-ops.js';

describe('formatAssetSummary', () => {
  it('reads as plain English for a mixed upload/reuse deploy', () => {
    expect(formatAssetSummary({ checked: 3, uploaded: 1, reused: 2, uploadedBytes: 12_288 })).toBe(
      '3 checked, 1 uploaded, 2 reused (12.0 KB uploaded).',
    );
  });

  it('shows bytes in plain B under 1 KiB', () => {
    expect(formatAssetSummary({ checked: 1, uploaded: 1, reused: 0, uploadedBytes: 512 })).toBe(
      '1 checked, 1 uploaded, 0 reused (512 B uploaded).',
    );
  });

  it('reports all-reused redeploys with zero uploaded bytes', () => {
    expect(formatAssetSummary({ checked: 2, uploaded: 0, reused: 2, uploadedBytes: 0 })).toBe(
      '2 checked, 0 uploaded, 2 reused (0 B uploaded).',
    );
  });

  it('says "none packaged" when the app ships no assets', () => {
    expect(formatAssetSummary({ checked: 0, uploaded: 0, reused: 0, uploadedBytes: 0 })).toBe(
      'none packaged.',
    );
  });
});

describe('assetFailureRecovery', () => {
  it('routes local validation failures to noodle validate', () => {
    const recovery = assetFailureRecovery(
      'validate',
      'asset file "assets/missing.png" does not exist',
    );
    expect(recovery.cause).toContain('assets/missing.png');
    expect(recovery.next).toBe('noodle validate');
  });

  it('surfaces the service message for a preflight (quota/policy) rejection', () => {
    const recovery = assetFailureRecovery('preflight', 'org asset quota exceeded');
    expect(recovery.cause).toBe('org asset quota exceeded');
    expect(recovery.next).toBe('noodle validate');
  });

  it('points an upload rejection back at deploy to retry', () => {
    const recovery = assetFailureRecovery('upload', 'asset upload checksum mismatch');
    expect(recovery.cause).toBe('asset upload checksum mismatch');
    expect(recovery.next).toBe('noodle deploy');
  });
});

describe('productionCapacityRecovery', () => {
  it('points a full pooled allowance at billing inspection and available recovery', () => {
    expect(productionCapacityRecovery('production_app_limit_exceeded', 'acme')).toEqual({
      code: 'production_app_limit_exceeded',
      cause: 'production app limit reached; archive an active app or contact support',
      fix: 'Archive an active production app on this billing account, or contact Noodle Seed support.',
      next: 'noodle billing org inspect acme',
    });
  });

  it('treats uncertain billing authority as a retryable service outage', () => {
    expect(productionCapacityRecovery('billing_enforcement_unavailable', 'acme')).toEqual({
      code: 'billing_enforcement_unavailable',
      cause: 'billing enforcement is temporarily unavailable; retry later',
      fix: 'Wait briefly and retry; do not bypass billing enforcement.',
      next: 'noodle deploy',
    });
  });
});
