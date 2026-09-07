import type { Logger } from '@noodle-borg/transport-http';
import type { CustomerAuthAudienceReconciliation } from './store/postgres-customer-auth-audience-schema.js';

/** Report derived customer-auth quarantine state without exposing identity or tenant identifiers. */
export function warnCustomerAuthAudienceQuarantine(
  logger: Pick<Logger, 'warn'>,
  reconciliation: CustomerAuthAudienceReconciliation,
): void {
  if (
    reconciliation.invalidBoundaries === 0 &&
    reconciliation.conflictingBindings === 0 &&
    reconciliation.conflictingBoundaries === 0
  ) {
    return;
  }
  logger.warn('customer_auth.audience_quarantine', {
    invalidBoundaries: reconciliation.invalidBoundaries,
    conflictingBindings: reconciliation.conflictingBindings,
    conflictingBoundaries: reconciliation.conflictingBoundaries,
  });
}
