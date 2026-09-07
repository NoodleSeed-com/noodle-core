import type { ServiceOptions } from './options.js';

/** Reject split-brain store injection before selecting the Postgres persistence backend. */
export function assertPostgresStoreOwnership(
  options: ServiceOptions,
  postgresStoreRequested: boolean,
): void {
  if (postgresStoreRequested && options.controlPlaneStore !== undefined) {
    throw new Error(
      'Postgres persistence must own the control-plane store; do not inject a separate controlPlaneStore',
    );
  }
  if (postgresStoreRequested && options.businessInformationStore !== undefined) {
    throw new Error(
      'Postgres persistence must own the business information store; do not inject a separate businessInformationStore',
    );
  }
}
