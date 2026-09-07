import {
  type CustomerEndpointPolicy,
  type CustomerEndpointRef,
  isValidCustomerEndpointName,
  normalizeCustomerEndpointPolicy,
} from '@noodle-borg/compiler';

export type { CustomerEndpointPolicy, CustomerEndpointRef } from '@noodle-borg/compiler';

/**
 * Declare a named, policy-bounded HTTP base URL projected privately from customer identity.
 *
 * This value contains only the endpoint key and its allow policy. The resolved customer URL is
 * request-local runtime authority and never enters authoring data or compiled artifacts.
 */
export function customerEndpoint(
  name: string,
  policy: CustomerEndpointPolicy,
): CustomerEndpointRef {
  if (!isValidCustomerEndpointName(name)) {
    throw new Error('customer endpoint name must use lowercase letters, numbers, and underscores');
  }
  return {
    kind: 'customerEndpoint',
    name,
    policy: normalizeCustomerEndpointPolicy(policy),
  };
}
