import {
  type CredentialProfile,
  type CustomerEndpointRef,
  isCustomerEndpointRef,
  type OperationSignature,
} from '@noodle-borg/compiler';
import {
  type Connector,
  type ConnectorCall,
  ConnectorInvocationError,
  type DownstreamCredential,
  type OperationEvidence,
} from '@noodle-borg/runtime';
import {
  customerRouteUnavailable,
  frozenCustomerEndpointRef,
  isWithinCustomerBase,
  resolveCustomerBase,
  sanitizedCustomerRouteError,
} from './customer-route.js';
import {
  fetchResponseWithResilience,
  type HttpResponse,
  type HttpRetryPolicy,
} from './http-response.js';
import { applyProjection, type HttpOperationProjection } from './projection.js';
import { type HttpRequestEncoding, requestPayload, setOwnedHeader } from './request-encoding.js';
import { assertPublicResolution, type DnsLookup, needsGuard } from './ssrf.js';
import {
  isVariableBaseUrl,
  joinBaseAndOperationPath,
  resolveConfigString,
} from './url-resolution.js';

/**
 * A declarative downstream auth scheme. The secret always comes from the broker-minted credential —
 * never from the manifest, the inbound MCP token, or the connector config itself.
 */
export type HttpAuthScheme =
  | { readonly kind: 'bearer' } // Authorization: Bearer <token>
  | { readonly kind: 'apiKey'; readonly header: string } // <header>: <token>  (e.g. X-API-Key)
  | { readonly kind: 'cookie' }; // Cookie: <sealed downstream cookie header value>

interface HttpOperationResilience {
  readonly timeoutMs?: number;
  readonly retry?: HttpRetryPolicy;
}

export type HttpPaginationStopReason = 'max_pages' | 'max_items';

export interface HttpPaginationAggregate {
  readonly items: readonly unknown[];
  readonly pages: readonly unknown[];
  readonly last: unknown;
  readonly pageCount: number;
  readonly partial: boolean;
  readonly stopReason?: HttpPaginationStopReason;
}

export type HttpOperationPagination =
  | {
      readonly kind: 'cursor';
      readonly cursorParam: string;
      readonly nextCursor: (json: unknown, args: Readonly<Record<string, unknown>>) => unknown;
      readonly items: (json: unknown, args: Readonly<Record<string, unknown>>) => unknown;
      readonly maxPages?: number;
      readonly maxItems?: number;
    }
  | {
      readonly kind: 'pageNumber';
      readonly pageParam: string;
      readonly startPage?: number;
      readonly hasMore: (json: unknown, args: Readonly<Record<string, unknown>>) => unknown;
      readonly items: (json: unknown, args: Readonly<Record<string, unknown>>) => unknown;
      readonly maxPages?: number;
      readonly maxItems?: number;
    };

export interface HttpOperationFake {
  readonly response?: unknown;
  readonly pages?: readonly unknown[];
}

/** Explicit application outcomes for selected provider rejections, never transport/auth failures. */
export interface HttpStatusResponse {
  readonly responseType?: 'json' | 'text' | 'empty';
  readonly mapResponse: (
    body: unknown,
    args: Readonly<Record<string, unknown>>,
  ) => Record<string, unknown>;
  readonly evidence?: (body: unknown) => OperationEvidence;
}

/**
 * A single HTTP operation. `GET`, `POST`, `PUT`, `PATCH`, and `DELETE` are supported. The `path` template is
 * filled from validated args
 * (`{name}` → `encodeURIComponent(args.name)`), `query` args are appended as query parameters, `body`
 * builds a request body for non-GET methods, and `mapResponse` shapes the JSON response into the operation's
 * declared output fields.
 */
export interface HttpOperation {
  readonly responses?: Readonly<Record<string, HttpStatusResponse>>;
  readonly evidence?: (json: unknown) => OperationEvidence;
  /** Compiler-derived requirement for mappings that consume the trusted operation identity. */
  readonly requiresExecution?: boolean;
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly query?: readonly string[];
  readonly signature: OperationSignature;
  /** Per-operation base URL override. Its resolved request origin must still be in the allowlist. */
  readonly baseUrl?: string;
  /** Build a JSON request body from already-evaluated, validated args. Ignored for `GET`. */
  readonly body?: (
    args: Readonly<Record<string, unknown>>,
    env: Readonly<Record<string, unknown>>,
    execution?: ConnectorCall['execution'],
  ) => unknown;
  /** Encode the evaluated body as JSON (default) or a WHATWG URLSearchParams form body. */
  readonly requestEncoding?: HttpRequestEncoding;
  /** Per-operation auth scheme; overrides the connector-level `auth`. */
  readonly auth?: HttpAuthScheme;
  /**
   * Build extra request headers from evaluated, validated args + env. Merged over the connector
   * defaults but *below* the `auth` scheme, so a declared `auth` block always wins. Lets an operation
   * attach a runtime value — e.g. a token from a prior operation — as `Authorization: Bearer ${args.token}`.
   */
  readonly headers?: (
    args: Readonly<Record<string, unknown>>,
    env: Readonly<Record<string, unknown>>,
    execution?: ConnectorCall['execution'],
  ) => Record<string, string>;
  readonly mapResponse?: (
    json: unknown,
    args: Readonly<Record<string, unknown>>,
  ) => Record<string, unknown>;
  readonly resilience?: HttpOperationResilience;
  readonly pagination?: HttpOperationPagination;
  readonly fake?: HttpOperationFake;
  readonly projection?: HttpOperationProjection;
  /** Inclusive decoded-response byte limit for this operation. Omitted operations default to 1 MiB. */
  readonly maxResponseBytes?: number;
  /**
   * How to decode the response body. `'json'` (the default) parses JSON and binds the parsed value to
   * `${response}`; `'text'` skips parsing, reads the raw body, and binds the decoded string to
   * `${response}`; `'empty'` enforces the HTTP status and then binds `{}` for endpoints such as `204 No
   * Content`. Non-JSON modes are incompatible with `pagination`, which needs JSON item arrays.
   */
  readonly responseType?: 'json' | 'text' | 'empty';
}

export interface HttpConnectorConfig {
  readonly id: string;
  readonly version: string;
  /** Default base URL for operations that do not set their own. */
  readonly baseUrl: string | CustomerEndpointRef;
  /**
   * Egress allowlist: every resolved request origin must be one of these. Defaults to the origin of
   * `baseUrl` when omitted (so a single-host config keeps its old same-origin behavior).
   */
  readonly allowedOrigins?: readonly string[];
  readonly operations: Readonly<Record<string, HttpOperation>>;
  /** Extra request headers (merged over the defaults). */
  readonly headers?: Readonly<Record<string, string>>;
  /** Connector-default auth scheme (an operation's own `auth` overrides this). */
  readonly auth?: HttpAuthScheme;
  /** Independent deployment API key; account credentials still use their bound presentation. */
  readonly transportAuth?: { readonly kind: 'apiKey'; readonly header: string };
  /**
   * Legacy escape hatch: map the broker credential to arbitrary auth headers. Used only when no
   * declarative `auth` scheme resolves for the operation. Omitted for public, no-auth APIs.
   */
  readonly authHeader?: (credential: DownstreamCredential) => Record<string, string>;
  /** Request timeout in ms. Default 10_000. */
  readonly timeoutMs?: number;
  /** Internal connector-wide fallback that may only tighten the 1 MiB default. */
  readonly maxBytes?: number;
  /**
   * Test-fixture mode: bypass outbound HTTP, credentials, SSRF resolution, and request construction while
   * still applying the operation's response mapping and pagination aggregation to declared fake data.
   */
  readonly fakeMode?: boolean;
  /**
   * Advanced/test seam: override the DNS resolver the SSRF guard pins against (defaults to `node:dns`).
   * Used to exercise rebinding/private-IP rejection hermetically; not part of normal configuration.
   */
  readonly lookup?: DnsLookup;
}

const DEFAULT_MAX_PAGES = 5;
const DEFAULT_MAX_ITEMS = 100;

/**
 * A real outbound HTTP connector: it calls a backing JSON API and maps the response to the operation's
 * output. Supports authenticated `GET`/`POST`/`PATCH`/`DELETE` across one or more declared hosts.
 *
 * **Security posture.** It enforces a static origin allowlist (a request can never resolve to an
 * undeclared host), a request timeout, and a decoded streamed-response size bound, and it only ever sends the
 * broker-minted credential (never an inbound token, never a manifest secret). For DNS-name hosts it
 * additionally attaches an undici dispatcher that pins the resolved IP and rejects loopback/private/
 * link-local/reserved addresses (incl. cloud metadata `169.254.169.254`), defeating DNS rebinding —
 * the SSRF defenses required by
 * [ADR 0008](../../../docs/decisions/0008-custom-connector-ssrf-dns-pinning.md) /
 * [ADR 0026](../../../docs/decisions/0026-ssrf-egress-hardening-lib.md). Literal-IP hosts are allowed
 * only via the explicit, auditable origin allowlist.
 */
export class HttpConnector implements Connector {
  readonly id: string;
  readonly version: string;
  readonly #config: HttpConnectorConfig;
  readonly #allowedOrigins: readonly string[];
  readonly #customerBase: CustomerEndpointRef | undefined;

  constructor(config: HttpConnectorConfig) {
    this.id = config.id;
    this.version = config.version;
    this.#config = config;
    for (const operation of Object.values(config.operations)) validateStatusResponses(operation);
    const customerRouted = isCustomerEndpointRef(config.baseUrl);
    this.#customerBase = customerRouted ? frozenCustomerEndpointRef(config.baseUrl) : undefined;
    const origins = customerRouted
      ? []
      : (config.allowedOrigins ?? (isVariableBaseUrl(config.baseUrl) ? [] : [config.baseUrl]));
    if (!customerRouted && origins.length === 0) {
      throw new Error('http.allowedOrigins is required when baseUrl is a managed variable');
    }
    for (const origin of origins) {
      if (!isVariableBaseUrl(origin)) new URL(origin);
    }
    this.#allowedOrigins = [...origins];
  }

  signature(operation: string): OperationSignature | undefined {
    return this.#config.operations[operation]?.signature;
  }

  executionBoundMs(operation: string): number | undefined {
    const op = this.#config.operations[operation];
    // Actions never use automatic retry; read retries do not create durable effect evidence.
    return op?.signature.type === 'action'
      ? (op.resilience?.timeoutMs ?? this.#config.timeoutMs ?? 10_000)
      : undefined;
  }

  async invoke(call: ConnectorCall): Promise<unknown> {
    const op = this.#config.operations[call.operation];
    if (!op) throw new Error(`connector "${this.id}" has no operation "${call.operation}"`);
    if (op.requiresExecution && !call.execution?.id)
      throw new Error('Trusted operation identity unavailable');

    const configuredBase = this.#config.baseUrl;
    const customerBase = this.#customerBase
      ? resolveCustomerBase(this.#customerBase, op, call)
      : undefined;
    if (this.#customerBase === undefined && call.route !== undefined) {
      throw customerRouteUnavailable();
    }

    if (this.#config.fakeMode === true) {
      const json =
        op.pagination === undefined
          ? this.#fakeJson(call.operation, op)
          : await this.#fakePaginatedJson(call.operation, op, call.args);
      if (op.evidence) call.reportOutcome?.(op.evidence(json));
      return this.#mapOutput(op, json, call.args);
    }

    const env = call.env ?? {};
    const base = customerBase ?? resolveConfigString(op.baseUrl ?? (configuredBase as string), env);
    const allowed =
      customerBase === undefined ? this.#resolveAllowedOrigins(env) : new Set<string>();
    try {
      const url = this.#buildUrl(op, call.args, base);
      // Validate the *resolved* origin and, for customer routes, the frozen base path before auth
      // material is constructed.
      await this.#validateUrl(url, customerBase, allowed);

      const method = op.method ?? 'GET';
      const payload = requestPayload(
        op.requestEncoding,
        method !== 'GET' && op.body !== undefined
          ? () => op.body?.(call.args, env, call.execution)
          : undefined,
      );

      const transportHeaders = await this.#transportHeaders(call);
      const headers: Record<string, string> = {
        accept:
          op.responseType === 'text' ? 'text/plain, text/*;q=0.9, */*;q=0.8' : 'application/json',
        'user-agent': 'noodle-borg/0.0',
        ...this.#config.headers,
        // Per-operation dynamic headers sit below the auth scheme, so a declared `auth` block always wins.
        ...(op.headers !== undefined ? op.headers(call.args, env, call.execution) : {}),
        ...this.#authHeaders(op, call.credential, call.credentialPresentation),
      };
      for (const [name, value] of Object.entries(transportHeaders))
        setOwnedHeader(headers, name, value);
      if (payload !== undefined) {
        setOwnedHeader(
          headers,
          'content-type',
          op.requestEncoding === 'form-urlencoded'
            ? 'application/x-www-form-urlencoded;charset=UTF-8'
            : 'application/json',
        );
      }

      // For DNS-name hosts, route through the SSRF-guarded dispatcher (pins the resolved IP, rejects
      // private/reserved ranges). Literal-IP hosts were already vetted by the origin allowlist above.
      // `dispatcher` is an undici fetch option absent from the global `RequestInit` type, so the cast
      // carries it at runtime without a type clash between undici and @types/node's bundled undici-types.
      const init: RequestInit = {
        method,
        headers,
        ...(call.signal === undefined ? {} : { signal: call.signal }),
        ...(payload !== undefined ? { body: payload } : {}),
      };
      const response =
        op.pagination === undefined
          ? await this.#fetchResponseWithResilience(url, op, init)
          : {
              status: 200,
              body: await this.#fetchPaginatedJson(
                op,
                call.args,
                base,
                init,
                customerBase,
                allowed,
              ),
            };
      const json = response.body;
      const statusResponse = op.responses?.[String(response.status)];
      if (statusResponse !== undefined) {
        // Do not inherit a successful-response mapping or completion evidence for a provider rejection.
        const output = this.#mapOutput(
          { ...op, mapResponse: statusResponse.mapResponse },
          json,
          call.args,
        );
        const evidence = statusResponse.evidence?.(json) ?? { outcome: 'unknown' as const };
        call.reportOutcome?.(
          evidence.outcome === 'rejected' || evidence.outcome === 'unknown'
            ? evidence
            : { outcome: 'unknown' },
        );
        return output;
      }
      if (op.evidence) call.reportOutcome?.(op.evidence(json));
      return this.#mapOutput(op, json, call.args);
    } catch (error) {
      if (customerBase !== undefined) throw sanitizedCustomerRouteError(error);
      throw error;
    }
  }

  async #transportHeaders(call: ConnectorCall): Promise<Record<string, string>> {
    const transport = this.#config.transportAuth;
    if (transport === undefined) return {};
    const header = transport.header.toLowerCase();
    const account = call.credentialPresentation;
    if (
      !/^x-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(header) ||
      account === undefined ||
      (account.kind === 'apiKey' && account.header.toLowerCase() === header) ||
      call.acquireTransportCredential === undefined
    ) {
      throw new Error('Independent transport authentication is not configured safely');
    }
    const credential = await call.acquireTransportCredential();
    if (
      credential.kind === 'cookie' ||
      credential.token.length < 1 ||
      credential.token.length > 4096 ||
      /[\r\n]/u.test(credential.token)
    )
      throw new Error('Independent transport requires a valid bounded token credential');
    return { [header]: credential.token };
  }

  #mapOutput(op: HttpOperation, json: unknown, args: Readonly<Record<string, unknown>>): unknown {
    const mapped = op.mapResponse ? op.mapResponse(json, args) : json;
    if (op.projection === undefined) return mapped;
    return applyProjection(op.projection, mapped, json, args);
  }

  /**
   * Resolve auth headers by precedence: compiled binding profile → operation `auth` → connector `auth`
   * → legacy `authHeader`. A binding profile is authoritative and bypasses baked legacy auth config.
   * The secret only ever lands in a header value here — never a URL, query, log, or error.
   */
  #authHeaders(
    op: HttpOperation,
    credential: DownstreamCredential,
    presentation?: CredentialProfile,
  ): Record<string, string> {
    const scheme = presentation ?? op.auth ?? this.#config.auth;
    if (scheme) {
      if (scheme.kind === 'cookie') {
        if (credential.kind !== 'cookie') {
          throw new Error('cookie auth requires a cookie downstream credential');
        }
        return { cookie: credential.cookie };
      }
      if (credential.kind === 'cookie') {
        throw new Error('token auth requires a token downstream credential');
      }
      if (scheme.kind === 'bearer') return { authorization: `Bearer ${credential.token}` };
      return { [scheme.header.toLowerCase()]: credential.token };
    }
    return this.#config.authHeader ? this.#config.authHeader(credential) : {};
  }

  /** Build the request URL: substitute `{name}` path params and append `query` args. */
  #buildUrl(
    op: HttpOperation,
    args: Readonly<Record<string, unknown>>,
    base: string,
    extraQuery: Readonly<Record<string, string | number>> = {},
  ): URL {
    const path = op.path.replace(/\{(\w+)\}/g, (_match, name: string) =>
      encodeURIComponent(String(args[name])),
    );
    const url = joinBaseAndOperationPath(base, path);
    if (op.query) {
      for (const name of op.query) {
        const value = args[name];
        if (value !== undefined) url.searchParams.set(name, String(value));
      }
    }
    for (const [name, value] of Object.entries(extraQuery)) {
      url.searchParams.set(name, String(value));
    }
    return url;
  }

  #resolveAllowedOrigins(env: Readonly<Record<string, unknown>>): ReadonlySet<string> {
    return new Set(
      this.#allowedOrigins.map((configured) => {
        const resolved = resolveConfigString(configured, env);
        const url = new URL(resolved);
        if (isVariableBaseUrl(configured) && !isManagedOrigin(url, resolved)) {
          throw new ConnectorInvocationError(
            `managed origin variable must resolve to a canonical bare HTTPS origin (loopback HTTP is allowed for development)`,
            { category: 'invalid_response', retryable: false },
          );
        }
        return url.origin;
      }),
    );
  }

  async #validateUrl(
    url: URL,
    customerBase: string | undefined,
    allowed: ReadonlySet<string>,
  ): Promise<void> {
    if (customerBase !== undefined) {
      if (!isWithinCustomerBase(url, customerBase)) throw customerRouteUnavailable();
    } else if (!allowed.has(url.origin)) {
      throw new Error(`request resolved to a disallowed origin "${url.origin}"`);
    }
    if (needsGuard(url)) await assertPublicResolution(url.hostname, this.#config.lookup);
  }

  async #fetchPaginatedJson(
    op: HttpOperation,
    args: Readonly<Record<string, unknown>>,
    base: string,
    init: RequestInit,
    customerBase?: string,
    allowed: ReadonlySet<string> = new Set(),
  ): Promise<HttpPaginationAggregate> {
    return this.#collectPaginatedJson(op, args, async (_pageIndex, query) => {
      const url = this.#buildUrl(op, args, base, query);
      await this.#validateUrl(url, customerBase, allowed);
      return (await this.#fetchResponseWithResilience(url, op, init)).body;
    });
  }

  #fakeJson(operation: string, op: HttpOperation): unknown {
    if (op.fake?.response === undefined) {
      throw invalidPaginationResponse(`fake response missing for operation "${operation}"`);
    }
    return op.fake.response;
  }

  async #fakePaginatedJson(
    operation: string,
    op: HttpOperation,
    args: Readonly<Record<string, unknown>>,
  ): Promise<HttpPaginationAggregate> {
    const fakePages = op.fake?.pages;
    if (fakePages === undefined) {
      throw invalidPaginationResponse(`fake pages missing for operation "${operation}"`);
    }
    return this.#collectPaginatedJson(op, args, async (pageIndex) => {
      if (pageIndex >= fakePages.length) {
        throw invalidPaginationResponse(
          `fake pages for operation "${operation}" ended before pagination stopped`,
        );
      }
      return fakePages[pageIndex];
    });
  }

  async #collectPaginatedJson(
    op: HttpOperation,
    args: Readonly<Record<string, unknown>>,
    readPage: (
      pageIndex: number,
      query: Readonly<Record<string, string | number>>,
    ) => Promise<unknown>,
  ): Promise<HttpPaginationAggregate> {
    const pagination = op.pagination;
    if (pagination === undefined) throw new Error('missing pagination config');

    const maxPages = pagination.maxPages ?? DEFAULT_MAX_PAGES;
    const maxItems = pagination.maxItems ?? DEFAULT_MAX_ITEMS;
    const pages: unknown[] = [];
    const items: unknown[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let pageNumber = pagination.kind === 'pageNumber' ? (pagination.startPage ?? 1) : 1;

    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      const query =
        pagination.kind === 'cursor'
          ? cursor === undefined
            ? {}
            : { [pagination.cursorParam]: cursor }
          : { [pagination.pageParam]: pageNumber };
      const json = await readPage(pageIndex, query);
      pages.push(json);

      const pageItems = pagination.items(json, args);
      if (!Array.isArray(pageItems)) {
        throw invalidPaginationResponse('pagination items expression did not evaluate to an array');
      }
      if (pagination.kind === 'cursor') {
        const nextCursor = cursorValue(pagination.nextCursor(json, args));
        const remaining = maxItems - items.length;
        const hasMore = nextCursor !== undefined;
        if (pageItems.length > remaining || (hasMore && pageItems.length === remaining)) {
          items.push(...pageItems.slice(0, Math.max(remaining, 0)));
          return aggregate(pages, items, true, 'max_items');
        }
        items.push(...pageItems);
        if (nextCursor === undefined) return aggregate(pages, items, false, undefined);
        if (seenCursors.has(nextCursor)) {
          throw invalidPaginationResponse('pagination response repeated a cursor');
        }
        seenCursors.add(nextCursor);
        if (pageIndex + 1 >= maxPages) return aggregate(pages, items, true, 'max_pages');
        cursor = nextCursor;
      } else {
        const hasMore = pagination.hasMore(json, args);
        if (typeof hasMore !== 'boolean') {
          throw invalidPaginationResponse(
            'pagination hasMore expression did not evaluate to a boolean',
          );
        }
        const remaining = maxItems - items.length;
        if (pageItems.length > remaining || (hasMore && pageItems.length === remaining)) {
          items.push(...pageItems.slice(0, Math.max(remaining, 0)));
          return aggregate(pages, items, true, 'max_items');
        }
        items.push(...pageItems);
        if (!hasMore) return aggregate(pages, items, false, undefined);
        if (pageIndex + 1 >= maxPages) return aggregate(pages, items, true, 'max_pages');
        pageNumber += 1;
      }
    }

    return aggregate(pages, items, true, 'max_pages');
  }

  #fetchResponseWithResilience(
    url: URL,
    op: HttpOperation,
    init: RequestInit,
  ): Promise<HttpResponse> {
    return fetchResponseWithResilience(url, op, init, {
      ...(this.#config.maxBytes === undefined ? {} : { maxBytes: this.#config.maxBytes }),
      ...(this.#config.timeoutMs === undefined ? {} : { timeoutMs: this.#config.timeoutMs }),
      ...(this.#config.lookup === undefined ? {} : { lookup: this.#config.lookup }),
    });
  }
}

function validateStatusResponses(operation: HttpOperation): void {
  if (operation.responses === undefined) return;
  if (operation.pagination !== undefined)
    throw new Error('HTTP response status mappings cannot be combined with pagination');
  for (const [status, response] of Object.entries(operation.responses)) {
    if (!/^4\d\d$/u.test(status) || ['401', '403', '429'].includes(status))
      throw new Error('HTTP response status must be an explicit 4xx other than 401, 403, or 429');
    if (typeof response.mapResponse !== 'function')
      throw new Error('HTTP response status requires an explicit response mapping');
  }
}

function isManagedOrigin(url: URL, resolved: string): boolean {
  if (url.origin !== resolved || url.username !== '' || url.password !== '') return false;
  if (url.protocol === 'https:') return true;
  return (
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
  );
}

function aggregate(
  pages: readonly unknown[],
  items: readonly unknown[],
  partial: boolean,
  stopReason: HttpPaginationStopReason | undefined,
): HttpPaginationAggregate {
  const last = pages.at(-1);
  return {
    items,
    pages,
    last,
    pageCount: pages.length,
    partial,
    ...(stopReason !== undefined ? { stopReason } : {}),
  };
}

function cursorValue(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  throw invalidPaginationResponse('pagination cursor expression did not evaluate to a scalar');
}

function invalidPaginationResponse(message: string): ConnectorInvocationError {
  return new ConnectorInvocationError(message, {
    category: 'invalid_response',
    retryable: false,
  });
}
