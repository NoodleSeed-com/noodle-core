import {
  type CustomerEndpointRef,
  normalizeCustomerEndpointPolicy,
  resolveCustomerEndpointBaseUrl,
} from '@noodle-borg/compiler';
import {
  type ConnectorCall,
  ConnectorInvocationError,
  isConnectorInvocationError,
  sanitizeConnectorFailureDetails,
} from '@noodle-borg/runtime';

interface RoutedHttpOperation {
  readonly path: string;
  readonly baseUrl?: string;
}

const customerRouteUnavailableErrors = new WeakSet<object>();

/** Copy and freeze the compiled route authority so mutable connector config cannot widen it later. */
export function frozenCustomerEndpointRef(value: CustomerEndpointRef): CustomerEndpointRef {
  const normalized = normalizeCustomerEndpointPolicy(value.policy);
  const policy =
    'allowedHttpsOrigins' in normalized
      ? Object.freeze({
          allowedHttpsOrigins: Object.freeze([...normalized.allowedHttpsOrigins]),
        })
      : Object.freeze({
          allowedHttpsHostSuffixes: Object.freeze([...normalized.allowedHttpsHostSuffixes]),
        });
  return Object.freeze({
    kind: 'customerEndpoint',
    name: value.name,
    policy,
  });
}

/** Independently validate the request-local route against the connector's immutable authority. */
export function resolveCustomerBase(
  configured: CustomerEndpointRef,
  operation: RoutedHttpOperation,
  call: ConnectorCall,
): string {
  if (
    operation.baseUrl !== undefined ||
    hasUnsafeRoutedOperationPath(operation.path) ||
    call.route === undefined ||
    call.route.key !== configured.name
  ) {
    throw customerRouteUnavailable();
  }
  const resolved = resolveCustomerEndpointBaseUrl(call.route.baseUrl, configured.policy);
  if (!resolved.ok || resolved.baseUrl !== call.route.baseUrl) throw customerRouteUnavailable();
  return resolved.baseUrl;
}

/** Keep every routed request on the exact frozen origin and canonical base path. */
export function isWithinCustomerBase(url: URL, customerBase: string): boolean {
  const base = new URL(customerBase);
  if (url.origin !== base.origin) return false;
  if (hasAmbiguousEncodedPath(url.pathname)) return false;
  const basePath = base.pathname.replace(/\/+$/u, '') || '/';
  if (basePath === '/') return true;
  return url.pathname === basePath || url.pathname.startsWith(`${basePath}/`);
}

export function customerRouteUnavailable(): ConnectorInvocationError {
  const error = new ConnectorInvocationError('connector route unavailable', {
    category: 'invalid_response',
    retryable: false,
  });
  customerRouteUnavailableErrors.add(error);
  return error;
}

/** Reconstruct routed failures from allowlisted metadata; never retain attacker-controlled fields. */
export function sanitizedCustomerRouteError(error: unknown): ConnectorInvocationError {
  if (isObjectLike(error) && customerRouteUnavailableErrors.has(error)) {
    return customerRouteUnavailable();
  }
  if (isConnectorInvocationError(error)) {
    return new ConnectorInvocationError(
      'connector request failed',
      sanitizeConnectorFailureDetails(error),
    );
  }
  return new ConnectorInvocationError('connector request failed', {
    category: 'network_error',
    retryable: false,
  });
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function hasUnsafeRoutedOperationPath(path: string): boolean {
  return (
    hasAmbiguousEncodedPath(path) ||
    /(?:^|[\\/])\.{1,2}(?:[\\/?#]|$)/u.test(path) ||
    path.includes('\\')
  );
}

function hasAmbiguousEncodedPath(path: string): boolean {
  return /%(?:25|2e|2f|5c)/iu.test(path);
}
