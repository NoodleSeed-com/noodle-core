import type { ConnectorFailureCategory, ConnectorTraceEvent } from '@noodle-borg/runtime';
import {
  ConnectorInvocationError,
  connectorInvocationErrorMessage,
  isConnectorInvocationError,
  sanitizeConnectorFailureDetails,
} from '@noodle-borg/runtime';
import { type DnsLookup, guardedFetch } from './ssrf.js';

type HttpRetryCategory = 'timeout' | 'network_error' | 'rate_limited' | 'upstream_5xx';

export interface HttpRetryPolicy {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly backoffMultiplier?: number;
  readonly retryOn?: readonly HttpRetryCategory[];
}

export interface ResponseOperation {
  readonly signature: { readonly type: 'read' | 'action' };
  readonly responseType?: 'json' | 'text' | 'empty';
  readonly resilience?: { readonly timeoutMs?: number; readonly retry?: HttpRetryPolicy };
  readonly maxResponseBytes?: number;
}

export interface ResponseFetchOptions {
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly lookup?: DnsLookup;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 1 << 20;
const MAX_OPERATION_RESPONSE_BYTES = 6 * 1024 * 1024;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 100;
const DEFAULT_MAX_DELAY_MS = 1_000;
const DEFAULT_BACKOFF_MULTIPLIER = 2;
const DEFAULT_RETRY_ON: readonly HttpRetryCategory[] = [
  'timeout',
  'network_error',
  'rate_limited',
  'upstream_5xx',
];
const RESPONSE_TOO_LARGE = Symbol('response too large');

interface NormalizedRetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly backoffMultiplier: number;
  readonly retryOn: ReadonlySet<HttpRetryCategory>;
}

interface NormalizedAttemptError {
  readonly error: ConnectorInvocationError;
  readonly retry: boolean;
  readonly retryAfterMs?: number;
}

export async function fetchResponseWithResilience(
  url: URL,
  op: ResponseOperation,
  init: RequestInit,
  options: ResponseFetchOptions,
): Promise<unknown> {
  const operationMax = validateResponseSizeLimit(op.maxResponseBytes, MAX_OPERATION_RESPONSE_BYTES);
  const connectorMax = validateResponseSizeLimit(options.maxBytes, DEFAULT_MAX_BYTES);
  const max = operationMax ?? connectorMax ?? DEFAULT_MAX_BYTES;
  const retry = normalizeRetryPolicy(op);
  const maxAttempts = retry === undefined ? 1 : retry.maxAttempts;
  const timeoutMs = op.resilience?.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let lastError: ConnectorInvocationError | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    try {
      const response = await guardedFetch(
        url,
        {
          ...init,
          redirect: 'manual',
          signal,
        },
        {
          connectTimeoutMs: timeoutMs,
          ...(options.lookup === undefined ? {} : { lookup: options.lookup }),
        },
      );
      if (response.status >= 300 && response.status <= 399) {
        throw new ConnectorInvocationError('egress redirect rejected', {
          status: response.status,
          category: 'invalid_response',
          attempts: attempt,
          retryable: false,
        });
      }
      if (op.responseType === 'text') {
        return await readResponseText(response, max, attempt, retry !== undefined);
      }
      if (op.responseType === 'empty') {
        await readResponseText(response, max, attempt, retry !== undefined);
        return {};
      }
      return await readJsonResponse(response, max, attempt, retry !== undefined);
    } catch (error) {
      const normalized = normalizeAttemptError(
        error,
        attempt,
        retry,
        op.signature.type === 'read',
        signal.aborted,
      );
      lastError = normalized.error;
      if (init.signal?.aborted || !normalized.retry || attempt >= maxAttempts) throw lastError;
      await sleep(retryDelayMs(retry as NormalizedRetryPolicy, attempt, normalized.retryAfterMs));
    }
  }

  throw lastError ?? new ConnectorInvocationError('connector failed', { attempts: maxAttempts });
}

function validateResponseSizeLimit(limit: number | undefined, ceiling: number): number | undefined {
  if (limit === undefined) return undefined;
  if (Number.isSafeInteger(limit) && limit > 0 && limit <= ceiling) return limit;
  throw new ConnectorInvocationError('invalid response size limit', {
    category: 'invalid_response',
    attempts: 1,
    retryable: false,
  });
}

async function readTextWithLimit(response: Response, max: number): Promise<string> {
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        try {
          await reader.cancel();
        } catch {
          // Cancellation is best-effort; the stable oversized-response failure remains authoritative.
        }
        throw RESPONSE_TOO_LARGE;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const buffer = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(buffer);
}

/**
 * Read a successful response body as text, enforcing the status, declared-length, and streamed-size
 * guards shared by JSON and text response modes. Non-2xx responses and oversized bodies raise a
 * `ConnectorInvocationError`; the raw decoded string is returned otherwise.
 */
async function readResponseText(
  response: Response,
  max: number,
  attempt: number,
  hasRetryPolicy: boolean,
): Promise<string> {
  if (!response.ok) {
    const category = categoryForStatus(response.status);
    const retryAfterMs =
      response.status === 429 ? parseRetryAfterMs(response.headers.get('retry-after')) : undefined;
    throw new ConnectorInvocationError(`backend responded ${response.status}`, {
      status: response.status,
      category,
      attempts: attempt,
      retryable: hasRetryPolicy && retryableCategory(category),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      responseExcerpt: await safeResponseExcerpt(response, max),
    });
  }

  const contentEncoding = response.headers.get('content-encoding')?.trim().toLowerCase();
  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  const declaredLengthDescribesDecodedBody =
    contentEncoding === undefined || contentEncoding === '' || contentEncoding === 'identity';
  if (declaredLengthDescribesDecodedBody && declaredLength > max) {
    throw new ConnectorInvocationError('response exceeds the size limit', {
      category: 'response_too_large',
      attempts: attempt,
      retryable: false,
    });
  }

  try {
    return await readTextWithLimit(response, max);
  } catch (error) {
    if (error === RESPONSE_TOO_LARGE) {
      throw new ConnectorInvocationError('response exceeds the size limit', {
        category: 'response_too_large',
        attempts: attempt,
        retryable: false,
      });
    }
    throw error;
  }
}

async function readJsonResponse(
  response: Response,
  max: number,
  attempt: number,
  hasRetryPolicy: boolean,
): Promise<unknown> {
  const text = await readResponseText(response, max, attempt, hasRetryPolicy);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ConnectorInvocationError('backend response was not valid JSON', {
      category: 'invalid_response',
      attempts: attempt,
      retryable: false,
    });
  }
}

function normalizeRetryPolicy(op: ResponseOperation): NormalizedRetryPolicy | undefined {
  if (op.signature.type !== 'read') return undefined;
  const retry = op.resilience?.retry;
  if (retry === undefined) return undefined;
  return {
    maxAttempts: retry.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    baseDelayMs: retry.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
    maxDelayMs: retry.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
    backoffMultiplier: retry.backoffMultiplier ?? DEFAULT_BACKOFF_MULTIPLIER,
    retryOn: new Set(retry.retryOn ?? DEFAULT_RETRY_ON),
  };
}

function normalizeAttemptError(
  error: unknown,
  attempt: number,
  retry: NormalizedRetryPolicy | undefined,
  readOperation: boolean,
  timedOut: boolean,
): NormalizedAttemptError {
  const details = sanitizeConnectorFailureDetails(error, { includeResponseExcerpt: true });
  const normalized = isConnectorInvocationError(error)
    ? withAttempt(
        error,
        details,
        attempt,
        readOperation && categoryInRetryPolicy(details.category, retry),
      )
    : fromFetchError(attempt, readOperation && retry !== undefined, timedOut);
  const retryable = normalized.retryable === true;
  return {
    error: normalized,
    retry: retryable && retry !== undefined && categoryInRetryPolicy(normalized.category, retry),
    ...(normalized.retryAfterMs !== undefined ? { retryAfterMs: normalized.retryAfterMs } : {}),
  };
}

function withAttempt(
  error: unknown,
  details: Pick<
    ConnectorTraceEvent,
    'status' | 'category' | 'attempts' | 'retryAfterMs' | 'responseExcerpt'
  >,
  attempt: number,
  retryable: boolean,
): ConnectorInvocationError {
  return new ConnectorInvocationError(
    connectorInvocationErrorMessage(error) ?? 'connector request failed',
    {
      ...(details.status !== undefined ? { status: details.status } : {}),
      ...(details.category !== undefined ? { category: details.category } : {}),
      attempts: details.attempts ?? attempt,
      retryable,
      ...(details.retryAfterMs !== undefined ? { retryAfterMs: details.retryAfterMs } : {}),
      ...(details.responseExcerpt !== undefined
        ? { responseExcerpt: details.responseExcerpt }
        : {}),
    },
  );
}

function fromFetchError(
  attempt: number,
  retryable: boolean,
  timedOut: boolean,
): ConnectorInvocationError {
  const category: ConnectorFailureCategory = timedOut ? 'timeout' : 'network_error';
  return new ConnectorInvocationError(
    category === 'timeout' ? 'request timed out' : 'network request failed',
    {
      category,
      attempts: attempt,
      retryable,
    },
  );
}

function categoryForStatus(status: number): ConnectorFailureCategory {
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'upstream_5xx';
  return 'upstream_4xx';
}

function retryableCategory(category: ConnectorFailureCategory | undefined): boolean {
  return (
    category === 'timeout' ||
    category === 'network_error' ||
    category === 'rate_limited' ||
    category === 'upstream_5xx'
  );
}

function categoryInRetryPolicy(
  category: ConnectorFailureCategory | undefined,
  retry: NormalizedRetryPolicy | undefined,
): category is HttpRetryCategory {
  if (retry === undefined) return false;
  switch (category) {
    case 'timeout':
    case 'network_error':
    case 'rate_limited':
    case 'upstream_5xx':
      return retry.retryOn.has(category);
    default:
      return false;
  }
}

function retryDelayMs(
  policy: NormalizedRetryPolicy,
  completedAttempt: number,
  retryAfterMs?: number,
): number {
  if (retryAfterMs !== undefined && retryAfterMs <= policy.maxDelayMs) return retryAfterMs;
  const exponential =
    policy.baseDelayMs * policy.backoffMultiplier ** Math.max(0, completedAttempt - 1);
  return Math.min(policy.maxDelayMs, exponential);
}

function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return undefined;
  return Math.max(0, time - Date.now());
}

async function safeResponseExcerpt(response: Response, max: number): Promise<string> {
  try {
    const text = await readTextWithLimit(response, Math.min(max, 512));
    if (text.trim() === '') return `HTTP ${response.status}`;
    const parsed = JSON.parse(text) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const message = record.message ?? record.error;
      if (typeof message === 'string') return message.slice(0, 256);
    }
    return text.slice(0, 256);
  } catch {
    return `HTTP ${response.status}`;
  }
}
