import {
  MIXED_CUSTOMER_AUTH_FEATURE_VERSION,
  serviceInfoClientResponseSchema,
} from '@noodle-borg/wire-contracts';
import { currentCliVersion } from './update.js';

export interface ServiceJsonOptions {
  readonly timeoutMs?: number;
}

export interface ServiceBinaryResponse {
  readonly bytes: Uint8Array;
  readonly headers: Headers;
}

const DEFAULT_SERVICE_TIMEOUT_MS = 15_000;

export async function serviceJson<T>(
  url: string,
  token: string | undefined,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch,
  options: ServiceJsonOptions = {},
): Promise<T> {
  return serviceRequest(
    url,
    token,
    init,
    fetchImpl,
    options,
    'application/json',
    async (response) => {
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    },
  );
}

/** Fetch authenticated service bytes through the same timeout, retry, and redaction seam as JSON. */
export async function serviceBinary(
  url: string,
  token: string | undefined,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch,
  options: ServiceJsonOptions = {},
): Promise<ServiceBinaryResponse> {
  return serviceRequest(
    url,
    token,
    init,
    fetchImpl,
    options,
    'application/zip',
    async (response) => ({
      bytes: new Uint8Array(await response.arrayBuffer()),
      headers: response.headers,
    }),
  );
}

async function serviceRequest<T>(
  url: string,
  token: string | undefined,
  init: RequestInit,
  fetchImpl: typeof fetch,
  options: ServiceJsonOptions,
  accept: string,
  read: (response: Response) => Promise<T>,
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SERVICE_TIMEOUT_MS;
  const method = (init.method ?? 'GET').toUpperCase();
  const maxAttempts = method === 'GET' ? 2 : 1;
  const sentRequestId = new Headers(init.headers).get('x-request-id') ?? undefined;
  let lastError: ServiceRequestError | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const startedAt = Date.now();
    try {
      return await fetchService(
        url,
        token,
        init,
        fetchImpl,
        timeoutMs,
        accept,
        async (response) => {
          if (response.ok) return read(response);
          throw await serviceErrorFromResponse(response, token);
        },
      );
    } catch (error) {
      const serviceError = error instanceof ServiceRequestError ? error : undefined;
      const timedOut =
        error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name);
      const requestId = serviceError?.requestId ?? sentRequestId;
      const code = serviceError?.code ?? (timedOut ? 'request_timeout' : undefined);
      const normalized = new ServiceRequestError({
        status: serviceError?.status ?? 0,
        message: timedOut
          ? `request timed out after ${timeoutMs}ms`
          : redactKnown(error instanceof Error ? error.message : String(error), token),
        ...(code !== undefined ? { code } : {}),
        ...(requestId !== undefined ? { requestId } : {}),
        elapsedMs: Date.now() - startedAt,
        ...(serviceError?.phase !== undefined ? { phase: serviceError.phase } : {}),
        ...(serviceError?.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: serviceError.retryAfterSeconds }
          : {}),
      });
      if (attempt < maxAttempts && isTransientStatus(normalized.status)) {
        lastError = normalized;
        continue;
      }
      throw normalized;
    }
  }
  throw lastError ?? new ServiceRequestError({ status: 0, message: 'request failed' });
}

async function fetchService<T>(
  url: string,
  token: string | undefined,
  init: RequestInit,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  accept: string,
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('accept', accept);
  headers.set('x-noodle-cli-version', currentCliVersion());
  if (token !== undefined) headers.set('authorization', `Bearer ${token}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await consume(await fetchImpl(url, { ...init, headers, signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

async function serviceErrorFromResponse(
  response: Response,
  token: string | undefined,
): Promise<ServiceRequestError> {
  let message = `request failed (${response.status})`;
  let code: string | undefined;
  let phase: string | undefined;
  try {
    const body = (await response.json()) as { error?: unknown; code?: unknown; phase?: unknown };
    if (typeof body.error === 'string') message = body.error;
    if (typeof body.code === 'string') code = body.code;
    if (typeof body.phase === 'string' && /^(body|validation|checks|admission)$/.test(body.phase))
      phase = body.phase;
  } catch (error) {
    if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) throw error;
  }
  const requestId =
    response.headers.get('x-request-id') ?? response.headers.get('x-correlation-id') ?? undefined;
  const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get('retry-after'));
  return new ServiceRequestError({
    status: response.status,
    message: redactKnown(message, token),
    ...(code !== undefined ? { code } : {}),
    ...(phase !== undefined ? { phase } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  });
}

function parseRetryAfterSeconds(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return undefined;
  return Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

function isTransientStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

function redactKnown(message: string, token: string | undefined): string {
  if (!token) return message;
  return message.split(token).join('[redacted]');
}

export class ServiceRequestError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly requestId?: string;
  readonly retryAfterSeconds?: number;
  readonly elapsedMs?: number;
  readonly phase?: string;

  constructor(input: {
    readonly status: number;
    readonly message: string;
    readonly code?: string;
    readonly requestId?: string;
    readonly retryAfterSeconds?: number;
    readonly elapsedMs?: number;
    readonly phase?: string;
  }) {
    super(input.message);
    this.name = 'ServiceRequestError';
    this.status = input.status;
    if (input.code !== undefined) this.code = input.code;
    if (input.requestId !== undefined) this.requestId = input.requestId;
    if (input.retryAfterSeconds !== undefined) this.retryAfterSeconds = input.retryAfterSeconds;
    if (input.elapsedMs !== undefined) this.elapsedMs = input.elapsedMs;
    if (input.phase !== undefined) this.phase = input.phase;
  }
}

/** Mixed access updates are adoption requests; an older service must not silently no-op them. */
export async function requireMixedCustomerAuth(
  service: string,
  token?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  let supported = false;
  try {
    const info = serviceInfoClientResponseSchema.parse(
      await serviceJson<unknown>(
        `${service.replace(/\/+$/, '')}/v1/service/info`,
        token,
        {},
        fetchImpl,
      ),
    );
    supported = (info.features?.mixedCustomerAuth ?? 0) >= MIXED_CUSTOMER_AUTH_FEATURE_VERSION;
  } catch {
    // Missing, unreadable and older feature contracts cannot establish adoption support.
  }
  if (!supported)
    throw new ServiceRequestError({
      status: 0,
      code: 'mixed_customer_auth_unsupported',
      message:
        'This service has not confirmed mixed customer authentication support. Upgrade the service, then retry; no access policy was changed.',
    });
}
