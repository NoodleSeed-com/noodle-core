import type { SolutionInstallationCapacityError } from '@noodle-borg/wire-contracts';
/** Technical retained-metadata guard, independent of app or commercial entitlements. */
export const MAX_RETAINED_INSTALLATIONS_PER_ORG = 1_000;

export class InstallationCapacityError extends Error {
  readonly code: SolutionInstallationCapacityError['code'] = 'installation_capacity_exceeded';
  constructor() {
    super(
      'This organization has reached its retained installation limit. Reuse an existing application and environment; existing installations remain accessible.',
    );
    this.name = 'InstallationCapacityError';
  }
}
