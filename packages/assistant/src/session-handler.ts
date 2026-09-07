import {
  AssistantSessionExchangeError,
  type CreateAssistantSessionInput,
  createAssistantSession,
} from './server.js';

/** Only the application's verified session/membership and bound login transaction may supply this. */
export type AssistantSessionIdentity = Pick<
  CreateAssistantSessionInput,
  'user' | 'claims' | 'preferences' | 'routing' | 'restoreConversation'
> &
  (
    | { readonly signInTicket?: undefined; readonly resume?: undefined }
    | { readonly signInTicket: string; readonly resume?: boolean }
  );

export interface AssistantSessionHandlerOptions {
  /** Exact HTTPS origins, or exact HTTP loopback origins for local development. No request-derived URLs. */
  readonly origin: string | undefined;
  readonly serviceUrl: string | undefined;
  readonly clientId: string | undefined;
  readonly clientSecret: string | undefined;
  /** Return null when signed out. Preserve the application's additional CSRF checks; never redirect. */
  readonly authenticate: (
    request: Request,
  ) => AssistantSessionIdentity | null | Promise<AssistantSessionIdentity | null>;
}

type Configuration = Required<
  Pick<CreateAssistantSessionInput, 'serviceUrl' | 'origin' | 'clientId' | 'clientSecret'>
>;
type Context = Readonly<Record<string, string | number | boolean | null>>;
const MAX_BODY_BYTES = 16 * 1024;
const DEADLINE_MS = 15_000;

/**
 * A same-origin Web Request/Response POST handler. Standard guards, bounded parsing, exchange and
 * secret-free JSON failures remain library-owned; application identity remains customer-owned.
 * No exchange retries: spending a sign-in ticket is a single-use operation.
 */
export function createAssistantSessionHandler(
  options: AssistantSessionHandlerOptions,
  dependencies: { readonly fetch?: typeof fetch } = {},
): (request: Request) => Promise<Response> {
  const configuration = configured(options);
  return async (request) => {
    if (request.method !== 'POST') {
      return error(405, 'method_not_allowed', 'POST required', { Allow: 'POST' });
    }
    if (!configuration)
      return error(503, 'assistant_not_configured', 'assistant is not configured');
    if (request.headers.get('origin') !== configuration.origin) {
      return error(403, 'origin_not_allowed', 'origin is not allowed');
    }
    if (
      request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !==
      'application/json'
    ) {
      return error(415, 'unsupported_media_type', 'application/json required');
    }
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, request.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<Response>((resolve) => {
      timer = setTimeout(() => {
        abort.abort();
        resolve(error(504, 'session_request_timeout', 'assistant session request timed out'));
      }, DEADLINE_MS);
    });
    try {
      return await Promise.race([
        exchange(request, configuration, options.authenticate, dependencies.fetch ?? fetch, signal),
        deadline,
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
}

async function exchange(
  request: Request,
  configuration: Configuration,
  authenticate: AssistantSessionHandlerOptions['authenticate'],
  fetchRequest: typeof fetch,
  signal: AbortSignal,
): Promise<Response> {
  let identity: AssistantSessionIdentity | null;
  try {
    identity = await authenticate(request);
  } catch {
    return error(503, 'authentication_unavailable', 'application authentication is unavailable');
  }
  if (identity === null) return error(401, 'authentication_required', 'authentication required');
  if (
    !isRecord(identity) ||
    !isRecord(identity.user) ||
    typeof identity.user.id !== 'string' ||
    identity.user.id.length < 1 ||
    identity.user.id.length > 240
  ) {
    return error(503, 'authentication_unavailable', 'application authentication is unavailable');
  }
  if (signal.aborted) return error(408, 'request_aborted', 'request was aborted');
  let body: unknown;
  try {
    body = await readBody(request, signal);
  } catch (cause) {
    return cause instanceof RangeError
      ? error(413, 'request_too_large', 'request must not exceed 16 KiB')
      : error(400, 'invalid_request', 'invalid JSON request');
  }
  if (
    !isRecord(body) ||
    Object.keys(body).some((key) => key !== 'context') ||
    (body.context !== undefined && !isContext(body.context))
  ) {
    return error(400, 'invalid_request', 'invalid request body');
  }
  if (identity.signInTicket !== undefined && body.context !== undefined) {
    return error(400, 'invalid_request', 'context does not apply during sign-in continuation');
  }
  if (signal.aborted) return error(408, 'request_aborted', 'request was aborted');
  try {
    const input: CreateAssistantSessionInput =
      identity.signInTicket !== undefined
        ? { ...identity, ...configuration }
        : {
            ...identity,
            ...configuration,
            ...(isContext(body.context) ? { context: body.context } : {}),
          };
    const session = await createAssistantSession(input, {
      fetch: (url, init) => fetchRequest(url, { ...init, signal, redirect: 'error' }),
    });
    return Response.json(session, { headers: { 'Cache-Control': 'no-store' } });
  } catch (cause) {
    if (cause instanceof AssistantSessionExchangeError && cause.elevationRefusal) {
      return error(cause.detail.status, cause.elevationRefusal, 'assistant sign-in was refused');
    }
    return error(502, 'session_exchange_failed', 'assistant session exchange failed');
  }
}

async function readBody(request: Request, signal: AbortSignal): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new SyntaxError('missing body');
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) return JSON.parse(text + decoder.decode());
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        cancel();
        throw new RangeError('body exceeds limit');
      }
      text += decoder.decode(value, { stream: true });
    }
    throw new Error('request aborted');
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

function configured(options: AssistantSessionHandlerOptions): Configuration | undefined {
  const { origin, serviceUrl, clientId, clientSecret } = options;
  if (
    !origin ||
    !serviceUrl ||
    !clientId?.trim() ||
    !clientSecret?.trim() ||
    clientId.includes(':')
  )
    return;
  const serviceOrigin = serviceUrl.replace(/\/$/, '');
  if (!safeOrigin(origin) || !safeOrigin(serviceOrigin)) return;
  return { origin, serviceUrl: serviceOrigin, clientId, clientSecret };
}

function safeOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.origin === value &&
      !url.hostname.includes('*') &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Mirrors the service's flat session-context boundary, not the nested per-turn page context. */
function isContext(value: unknown): value is Context {
  return (
    isRecord(value) &&
    Object.keys(value).length <= 32 &&
    Object.entries(value).every(
      ([key, entry]) =>
        key.length <= 80 &&
        (entry === null ||
          typeof entry === 'boolean' ||
          (typeof entry === 'number' && Number.isFinite(entry)) ||
          (typeof entry === 'string' && entry.length <= 2_000)),
    )
  );
}

function error(status: number, code: string, message: string, headers: HeadersInit = {}): Response {
  return Response.json(
    { code, error: message },
    { status, headers: { 'Cache-Control': 'no-store', ...headers } },
  );
}
