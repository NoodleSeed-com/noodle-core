import type { HostedPackagedAsset } from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import type { FilesystemAssetReservationState } from '../src/filesystem-coordination.js';
import { FilesystemUploadRegistry, type PendingUpload } from '../src/filesystem-upload-registry.js';

const BASE_ASSET: HostedPackagedAsset = {
  logicalId: 'logo',
  sourcePath: 'assets/logo.png',
  contentHash: `sha256:${'a'.repeat(64)}`,
  mimeType: 'image/png',
  byteLength: 68,
  width: 1,
  height: 1,
  objectKey: `${'1'.repeat(16)}/${'2'.repeat(16)}/${'3'.repeat(16)}/${'a'.repeat(64)}/logo`,
  publicUrl: `https://assets.example.test/__noodle/hosted-assets/${'1'.repeat(16)}/${'2'.repeat(16)}/${'3'.repeat(16)}/${'a'.repeat(64)}/logo`,
};

function pending(
  reservationId: string,
  objectKey = BASE_ASSET.objectKey,
  expiresAt = 2_000,
): PendingUpload {
  return {
    asset: { ...BASE_ASSET, objectKey },
    reservationId,
    scope: { org: 'acme', app: 'site', env: 'prod' },
    expiresAt,
    headers: { 'content-type': 'image/png' },
  };
}

function reservations(...uploads: readonly PendingUpload[]): FilesystemAssetReservationState {
  return {
    version: 1,
    capabilities: uploads.map((upload) => ({
      id: upload.reservationId,
      objectKey: upload.asset.objectKey,
      identityHash: upload.asset.contentHash.slice('sha256:'.length),
      byteLength: upload.asset.byteLength,
      expiresAt: upload.expiresAt,
    })),
  };
}

describe('FilesystemUploadRegistry', () => {
  it('removes local tokens whose shared reservations disappeared or expired', () => {
    const registry = new FilesystemUploadRegistry(2);
    const missing = pending('1'.repeat(32));
    const expired = pending('2'.repeat(32), BASE_ASSET.objectKey, 999);
    registry.add('token-missing', missing);
    registry.add('token-expired', expired);

    registry.reconcile(reservations(expired), 1_000);

    expect(registry.get('token-missing')).toBeUndefined();
    expect(registry.get('token-expired')).toBeUndefined();
  });

  it('requires the exact tenant-blinded object key when reusing a capability', () => {
    const registry = new FilesystemUploadRegistry(2);
    const first = pending('1'.repeat(32));
    const otherTenant = {
      ...BASE_ASSET,
      objectKey: `${'4'.repeat(16)}/${'5'.repeat(16)}/${'6'.repeat(16)}/${'a'.repeat(64)}/logo`,
    };
    registry.add('tenant-a-token', first);

    expect(registry.find(otherTenant)).toBeUndefined();
    expect(registry.find(BASE_ASSET)?.token).toBe('tenant-a-token');
  });

  it('enforces its local token cap after reconciliation', () => {
    const registry = new FilesystemUploadRegistry(1);
    const first = pending('1'.repeat(32));
    const second = pending('2'.repeat(32), `${BASE_ASSET.objectKey.slice(0, -4)}icon`);
    registry.add('first-token', first);
    expect(() => registry.add('second-token', second)).toThrow(/local|outstanding/i);

    registry.reconcile({ version: 1, capabilities: [] }, 1_000);
    expect(() => registry.add('second-token', second)).not.toThrow();
    expect(registry.get('second-token')).toBe(second);
  });
});
