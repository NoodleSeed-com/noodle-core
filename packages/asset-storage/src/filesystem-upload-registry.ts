import type { HostedPackagedAsset } from '@noodle-borg/compiler';
import { AssetPlanError, type AssetScope } from '@noodle-borg/module';
import type { FilesystemAssetReservationState } from './filesystem-coordination.js';
import { isPendingReservation, sameAssetIdentity } from './filesystem-store-support.js';

export interface PendingUpload {
  readonly asset: HostedPackagedAsset;
  readonly reservationId: string;
  readonly scope: AssetScope;
  readonly expiresAt: number;
  readonly headers: Readonly<Record<string, string>>;
}

/** Process-local capability index reconciled against the durable reservation authority. */
export class FilesystemUploadRegistry {
  readonly #maxUploads: number;
  readonly #uploads = new Map<string, PendingUpload>();

  constructor(maxUploads: number) {
    this.#maxUploads = maxUploads;
  }

  get(token: string): PendingUpload | undefined {
    return this.#uploads.get(token);
  }

  add(token: string, pending: PendingUpload): void {
    if (!this.#uploads.has(token) && this.#uploads.size >= this.#maxUploads) {
      throw new AssetPlanError(
        `filesystem asset store has too many local outstanding upload capabilities (limit ${this.#maxUploads})`,
      );
    }
    this.#uploads.set(token, pending);
  }

  deleteToken(token: string): void {
    this.#uploads.delete(token);
  }

  deleteObject(objectKey: string): void {
    for (const [token, pending] of this.#uploads) {
      if (pending.asset.objectKey === objectKey) this.#uploads.delete(token);
    }
  }

  find(
    asset: HostedPackagedAsset,
  ): { readonly token: string; readonly pending: PendingUpload } | undefined {
    for (const [token, pending] of this.#uploads) {
      if (pending.asset.objectKey === asset.objectKey && sameAssetIdentity(pending.asset, asset)) {
        return { token, pending };
      }
    }
    return undefined;
  }

  reconcile(state: FilesystemAssetReservationState, now: number): void {
    for (const [token, pending] of this.#uploads) {
      if (
        pending.expiresAt <= now ||
        !state.capabilities.some((reservation) => isPendingReservation(reservation, pending))
      ) {
        this.#uploads.delete(token);
      }
    }
    if (this.#uploads.size > this.#maxUploads) {
      throw new AssetPlanError(
        `filesystem asset store has too many local outstanding upload capabilities (limit ${this.#maxUploads})`,
      );
    }
  }
}
