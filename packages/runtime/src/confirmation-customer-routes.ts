import type { OperationRef } from '@noodle-borg/compiler';
import {
  type FrozenCustomerRoutes,
  resolveCustomerActionRouteBindings,
} from './customer-routing.js';
import type { ExecutionError, PreparedOperationAction } from './result.js';

/** Match the current request's URL-blind action routes against the private prepared continuation. */
export function validatePreparedCustomerRoutes(
  ref: OperationRef,
  reviewedAction: PreparedOperationAction,
  routes: FrozenCustomerRoutes | undefined,
  signatureType?: 'read' | 'action',
): ExecutionError | null {
  if (ref.resolved !== true) {
    return {
      code: 'invalid_continuation',
      message: 'prepared connector action is no longer available',
    };
  }
  const current = resolveCustomerActionRouteBindings(routes, ref, signatureType);
  const reviewed = reviewedAction.customerRoutes ?? [];
  if (
    current === null ||
    current.length !== reviewed.length ||
    current.some(
      (binding, index) =>
        binding.key !== reviewed[index]?.key ||
        binding.fingerprint !== reviewed[index]?.fingerprint,
    )
  ) {
    return {
      code: 'invalid_continuation',
      message: 'Customer connector route no longer matches the prepared action.',
    };
  }
  return null;
}
