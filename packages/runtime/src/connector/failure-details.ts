import type { ConnectorFailureCategory, ConnectorTraceEvent } from './types.js';

const FAILURE_CATEGORIES = new Set<ConnectorFailureCategory>([
  'timeout',
  'queue_timeout',
  'network_error',
  'rate_limited',
  'upstream_5xx',
  'upstream_4xx',
  'invalid_response',
  'response_too_large',
]);
const MAX_ATTEMPTS = 1_000;
const MAX_RETRY_AFTER_MS = Number.MAX_SAFE_INTEGER;
const MAX_RESPONSE_EXCERPT_LENGTH = 2_048;

type ConnectorFailureDetails = Pick<
  ConnectorTraceEvent,
  | 'status'
  | 'category'
  | 'attempts'
  | 'retryable'
  | 'retryAfterMs'
  | 'responseExcerpt'
  | 'queueWaitMs'
  | 'executionMs'
>;

/** Reconstruct connector failure metadata from runtime-validated own data properties only. */
export function sanitizeConnectorFailureDetails(
  error: unknown,
  options: { readonly includeResponseExcerpt?: boolean } = {},
): ConnectorFailureDetails {
  const status = ownData(error, 'status');
  const category = ownData(error, 'category');
  const attempts = ownData(error, 'attempts');
  const retryable = ownData(error, 'retryable');
  const retryAfterMs = ownData(error, 'retryAfterMs');
  const responseExcerpt = options.includeResponseExcerpt
    ? ownData(error, 'responseExcerpt')
    : undefined;
  const queueWaitMs = ownData(error, 'queueWaitMs');
  const executionMs = ownData(error, 'executionMs');

  return Object.freeze({
    ...(isIntegerInRange(status, 100, 599) ? { status } : {}),
    ...(typeof category === 'string' && FAILURE_CATEGORIES.has(category as ConnectorFailureCategory)
      ? { category: category as ConnectorFailureCategory }
      : {}),
    ...(isIntegerInRange(attempts, 1, MAX_ATTEMPTS) ? { attempts } : {}),
    ...(typeof retryable === 'boolean' ? { retryable } : {}),
    ...(isIntegerInRange(retryAfterMs, 0, MAX_RETRY_AFTER_MS) ? { retryAfterMs } : {}),
    ...(typeof responseExcerpt === 'string' && responseExcerpt.length <= MAX_RESPONSE_EXCERPT_LENGTH
      ? { responseExcerpt }
      : {}),
    ...(isIntegerInRange(queueWaitMs, 0, MAX_RETRY_AFTER_MS) ? { queueWaitMs } : {}),
    ...(isIntegerInRange(executionMs, 0, MAX_RETRY_AFTER_MS) ? { executionMs } : {}),
  });
}

function ownData(error: unknown, key: string): unknown {
  if (!((typeof error === 'object' && error !== null) || typeof error === 'function')) {
    return undefined;
  }
  try {
    const descriptor = Reflect.getOwnPropertyDescriptor(error, key);
    return descriptor !== undefined && Object.hasOwn(descriptor, 'value')
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
  );
}
