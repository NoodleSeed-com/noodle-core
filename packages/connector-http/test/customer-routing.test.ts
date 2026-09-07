import type { CustomerEndpointRef, OperationSignature } from '@noodle-borg/compiler';
import { ConnectorInvocationError, type CustomerConnectorRoute } from '@noodle-borg/runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DnsLookup } from '../src/ssrf.js';

const { guardedFetch } = vi.hoisted(() => ({ guardedFetch: vi.fn() }));

vi.mock('../src/ssrf.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/ssrf.js')>();
  return { ...original, guardedFetch };
});

import { isWithinCustomerBase, sanitizedCustomerRouteError } from '../src/customer-route.js';
import { HttpConnector } from '../src/index.js';

const readSignature: OperationSignature = { type: 'read', input: {}, output: {} };
const routedBase: CustomerEndpointRef = {
  kind: 'customerEndpoint',
  name: 'customer_api',
  policy: { allowedHttpsHostSuffixes: ['noodleseed.dev'] },
};
const routeA: CustomerConnectorRoute = {
  key: 'customer_api',
  fingerprint: 'sha256:route-a',
  baseUrl: 'https://tenant-a.api.noodleseed.dev/v1',
};
const publicAddress = { address: '93.184.216.34', family: 4 };

afterEach(() => {
  guardedFetch.mockReset();
});

function lookupSpy(): ReturnType<typeof vi.fn<DnsLookup>> {
  return vi.fn<DnsLookup>((_hostname, _options, callback) => {
    callback(null, [publicAddress]);
  });
}

function connector(
  options: {
    readonly lookup?: DnsLookup;
    readonly path?: string;
    readonly baseUrl?: CustomerEndpointRef | string;
    readonly allowedOrigins?: readonly string[];
    readonly operationBaseUrl?: string;
    readonly authHeader?: (credential: { readonly token: string }) => Record<string, string>;
    readonly pagination?: boolean;
    readonly retry?: boolean;
  } = {},
): HttpConnector {
  return new HttpConnector({
    id: 'customer_records',
    version: '1.0.0',
    baseUrl: options.baseUrl ?? routedBase,
    ...(options.allowedOrigins === undefined ? {} : { allowedOrigins: options.allowedOrigins }),
    ...(options.lookup === undefined ? {} : { lookup: options.lookup }),
    ...(options.authHeader === undefined ? {} : { authHeader: options.authHeader }),
    operations: {
      list: {
        path: options.path ?? '/records',
        signature: readSignature,
        ...(options.operationBaseUrl === undefined ? {} : { baseUrl: options.operationBaseUrl }),
        ...(options.retry ? { resilience: { retry: { maxAttempts: 2, baseDelayMs: 0 } } } : {}),
        ...(options.pagination
          ? {
              pagination: {
                kind: 'cursor' as const,
                cursorParam: 'cursor',
                nextCursor: (json: unknown) => (json as { readonly next: string | null }).next,
                items: (json: unknown) => (json as { readonly items: unknown[] }).items,
              },
            }
          : {}),
      },
    },
  });
}

function invoke(current: HttpConnector, route: CustomerConnectorRoute = routeA): Promise<unknown> {
  return current.invoke({
    operation: 'list',
    args: {},
    credential: { token: 'downstream-secret' },
    route,
  });
}

function invokeWithoutRoute(current: HttpConnector): Promise<unknown> {
  return current.invoke({
    operation: 'list',
    args: {},
    credential: { token: 'downstream-secret' },
  });
}

describe('HttpConnector customer routing', () => {
  it('uses a canonical, independently policy-authorized route as the invocation-local base', async () => {
    const lookup = lookupSpy();
    guardedFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await expect(invoke(connector({ lookup }))).resolves.toEqual({ ok: true });

    expect(guardedFetch).toHaveBeenCalledOnce();
    expect(guardedFetch.mock.calls[0]?.[0].toString()).toBe(
      'https://tenant-a.api.noodleseed.dev/v1/records',
    );
    expect(lookup).toHaveBeenCalledWith(
      'tenant-a.api.noodleseed.dev',
      expect.anything(),
      expect.any(Function),
    );
  });

  it.each([
    ['wrong key', { ...routeA, key: 'other_api' }],
    ['non-canonical', { ...routeA, baseUrl: `${routeA.baseUrl}/` }],
    ['disallowed', { ...routeA, baseUrl: 'https://tenant.example.com/v1' }],
    ['non-HTTPS', { ...routeA, baseUrl: 'http://tenant-a.api.noodleseed.dev/v1' }],
  ])('rejects a %s route before auth, DNS, or fetch', async (_name, route) => {
    const lookup = lookupSpy();
    const authHeader = vi.fn(() => ({ authorization: 'Bearer downstream-secret' }));
    const current = connector({ lookup, authHeader });

    const error = await invoke(current, route).catch((reason: unknown) => reason);

    expect(error).toMatchObject({
      message: 'connector route unavailable',
      retryable: false,
    });
    expect(JSON.stringify(error)).not.toContain(route.baseUrl);
    expect(authHeader).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it('rejects a missing route before auth, DNS, or fetch', async () => {
    const lookup = lookupSpy();
    const authHeader = vi.fn(() => ({ authorization: 'Bearer downstream-secret' }));

    await expect(invokeWithoutRoute(connector({ lookup, authHeader }))).rejects.toMatchObject({
      message: 'connector route unavailable',
      retryable: false,
    });
    expect(authHeader).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it('rejects an operation base URL override for a customer-routed connector', async () => {
    const lookup = lookupSpy();
    const authHeader = vi.fn(() => ({ authorization: 'Bearer downstream-secret' }));
    const current = connector({
      lookup,
      authHeader,
      operationBaseUrl: 'https://other.api.noodleseed.dev',
    });

    await expect(invoke(current)).rejects.toThrow('connector route unavailable');

    expect(authHeader).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it('rejects a route override for a static connector without changing legacy unrouted calls', async () => {
    const lookup = lookupSpy();
    guardedFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const current = connector({
      lookup,
      baseUrl: 'https://static.api.noodleseed.dev/v1',
    });

    await expect(invoke(current)).rejects.toThrow('connector route unavailable');
    expect(guardedFetch).not.toHaveBeenCalled();

    await expect(invokeWithoutRoute(current)).resolves.toEqual({ ok: true });
    expect(guardedFetch.mock.calls[0]?.[0].toString()).toBe(
      'https://static.api.noodleseed.dev/v1/records',
    );
  });

  it('rejects a route override for a managed-variable connector before variable resolution', async () => {
    const lookup = lookupSpy();
    const authHeader = vi.fn(() => ({ authorization: 'Bearer downstream-secret' }));
    const current = connector({
      lookup,
      authHeader,
      baseUrl: '${env.CUSTOMER_API_URL}',
      allowedOrigins: ['https://static.api.noodleseed.dev'],
    });

    await expect(invoke(current)).rejects.toThrow('connector route unavailable');

    expect(authHeader).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it.each([
    'https://other.api.noodleseed.dev/records',
    'https://tenant-a.api.noodleseed.dev/escape',
    'https://tenant-a.api.noodleseed.dev/v10/records',
    'https://tenant-a.api.noodleseed.dev/v1/../private',
    'https://tenant-a.api.noodleseed.dev/v1/%2e%2e/private',
    'https://tenant-a.api.noodleseed.dev/v1/%2Fprivate',
    'https://tenant-a.api.noodleseed.dev/v1/%25private',
    'https://tenant-a.api.noodleseed.dev/v1/%252e%252e/private',
    'https://tenant-a.api.noodleseed.dev/v1/%252Fprivate',
    'https://tenant-a.api.noodleseed.dev/v1/%255cprivate',
    'https://tenant-a.api.noodleseed.dev/v1/%25252fprivate',
    '../private',
    '%2e%2e/private',
    '%25private',
    '%252e%252e/private',
    '%252Fprivate',
    '%255cprivate',
    '//other.api.noodleseed.dev/records',
  ])('prevents an authored path from escaping the frozen base: %s', async (path) => {
    const lookup = lookupSpy();
    const authHeader = vi.fn(() => ({ authorization: 'Bearer downstream-secret' }));

    const error = await invoke(connector({ path, lookup, authHeader })).catch(
      (reason: unknown) => reason,
    );

    expect(error).toMatchObject({ message: 'connector route unavailable' });
    expect(JSON.stringify(error)).not.toContain(routeA.baseUrl);
    expect(authHeader).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it.each([
    'https://tenant-a.api.noodleseed.dev/v1/%25private',
    'https://tenant-a.api.noodleseed.dev/v1/%252e%252e/private',
    'https://tenant-a.api.noodleseed.dev/v1/%252fprivate',
    'https://tenant-a.api.noodleseed.dev/v1/%255cprivate',
    'https://tenant-a.api.noodleseed.dev/v1/%25252fprivate',
  ])('rejects encoded percent and separators in a final routed URL: %s', (url) => {
    expect(isWithinCustomerBase(new URL(url), routeA.baseUrl)).toBe(false);
  });

  it.each([
    'https://tenant-a.api.noodleseed.dev/v1',
    'https://tenant-a.api.noodleseed.dev/v1/records',
    'https://tenant-a.api.noodleseed.dev/v1/customer%20records',
  ])('preserves safe canonical paths within the frozen base: %s', (url) => {
    expect(isWithinCustomerBase(new URL(url), routeA.baseUrl)).toBe(true);
  });

  it('keeps concurrent requests on their own immutable route', async () => {
    const lookup = lookupSpy();
    const urls: string[] = [];
    guardedFetch.mockImplementation(async (url: URL) => {
      urls.push(url.toString());
      await Promise.resolve();
      return new Response(JSON.stringify({ url: url.toString() }), { status: 200 });
    });
    const current = connector({ lookup });
    const routeB = {
      ...routeA,
      fingerprint: 'sha256:route-b',
      baseUrl: 'https://tenant-b.api.noodleseed.dev/v2',
    };

    await Promise.all([invoke(current, routeA), invoke(current, routeB)]);

    expect(urls.sort()).toEqual([
      'https://tenant-a.api.noodleseed.dev/v1/records',
      'https://tenant-b.api.noodleseed.dev/v2/records',
    ]);
  });

  it('cannot be widened by mutating the authored endpoint policy after construction', async () => {
    const lookup = lookupSpy();
    const suffixes = ['noodleseed.dev'];
    const mutableBase = {
      kind: 'customerEndpoint' as const,
      name: 'customer_api',
      policy: { allowedHttpsHostSuffixes: suffixes },
    };
    const authHeader = vi.fn(() => ({ authorization: 'Bearer downstream-secret' }));
    const current = connector({ lookup, authHeader, baseUrl: mutableBase });
    suffixes[0] = 'example.org';
    const mutatedRoute = {
      ...routeA,
      baseUrl: 'https://tenant.api.example.org/v1',
    };

    await expect(invoke(current, mutatedRoute)).rejects.toThrow('connector route unavailable');

    expect(authHeader).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it('retains the same route and DNS pinning across retry and pagination', async () => {
    const lookup = lookupSpy();
    const responses = [
      new Response(JSON.stringify({ error: 'again' }), { status: 503 }),
      new Response(JSON.stringify({ items: [{ id: 1 }], next: 'second' }), { status: 200 }),
      new Response(JSON.stringify({ items: [{ id: 2 }], next: null }), { status: 200 }),
    ];
    guardedFetch.mockImplementation(async () => {
      const response = responses.shift();
      if (response === undefined) throw new Error('unexpected request');
      return response;
    });

    await expect(
      invoke(connector({ lookup, retry: true, pagination: true })),
    ).resolves.toMatchObject({
      items: [{ id: 1 }, { id: 2 }],
      pageCount: 2,
    });

    expect(guardedFetch.mock.calls.map((call) => call[0].toString())).toEqual([
      'https://tenant-a.api.noodleseed.dev/v1/records',
      'https://tenant-a.api.noodleseed.dev/v1/records',
      'https://tenant-a.api.noodleseed.dev/v1/records?cursor=second',
    ]);
    expect(
      guardedFetch.mock.calls.every(
        (call) => call[2]?.lookup === lookup && call[1]?.redirect === 'manual',
      ),
    ).toBe(true);
  });

  it('strips customer URLs and response excerpts from routed connector failures', async () => {
    const lookup = lookupSpy();
    guardedFetch.mockResolvedValue(
      new Response(`failed while contacting ${routeA.baseUrl}/private`, { status: 503 }),
    );

    const error = await invoke(connector({ lookup })).catch((reason: unknown) => reason);
    const serialized = JSON.stringify(error);

    expect(error).toMatchObject({
      message: 'connector request failed',
      status: 503,
      category: 'upstream_5xx',
      retryable: false,
    });
    expect(error.responseExcerpt).toBeUndefined();
    expect(serialized).not.toContain(routeA.baseUrl);
  });

  it('reconstructs even route-shaped connector failures without retaining attacker fields', async () => {
    const lookup = lookupSpy();
    const crafted = new ConnectorInvocationError('connector route unavailable', {
      category: 'invalid_response',
      retryable: false,
      responseExcerpt: routeA.baseUrl,
    }) as ConnectorInvocationError & { route?: string };
    crafted.route = routeA.baseUrl;
    guardedFetch.mockRejectedValue(crafted);

    const error = await invoke(connector({ lookup })).catch((reason: unknown) => reason);

    expect(error).toMatchObject({
      message: 'connector request failed',
    });
    expect(error.responseExcerpt).toBeUndefined();
    expect(error).not.toHaveProperty('route');
    expect(JSON.stringify(error)).not.toContain(routeA.baseUrl);
  });

  it('drops runtime-poisoned allowlisted metadata from routed connector failures', () => {
    const poison = `${routeA.key} ${routeA.fingerprint} ${routeA.baseUrl}`;
    const crafted = new ConnectorInvocationError(
      'connector request failed',
    ) as ConnectorInvocationError & Record<string, unknown>;
    Object.assign(crafted, {
      status: poison,
      category: poison,
      attempts: poison,
      retryable: poison,
      retryAfterMs: poison,
      responseExcerpt: poison,
    });

    const error = sanitizedCustomerRouteError(crafted);

    expect(error).toMatchObject({ message: 'connector request failed' });
    expect(error.status).toBeUndefined();
    expect(error.category).toBeUndefined();
    expect(error.attempts).toBeUndefined();
    expect(error.retryable).toBeUndefined();
    expect(error.retryAfterMs).toBeUndefined();
    expect(error.responseExcerpt).toBeUndefined();
    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain(routeA.key);
    expect(serialized).not.toContain(routeA.fingerprint);
    expect(serialized).not.toContain(routeA.baseUrl);
  });

  it('normalizes a getPrototypeOf-throwing HTTP rejection without invoking its trap', async () => {
    const lookup = lookupSpy();
    guardedFetch.mockRejectedValue(
      new Proxy(
        {},
        {
          getPrototypeOf() {
            throw new Error(`HTTP proxy trap ${routeA.baseUrl}`);
          },
        },
      ),
    );

    const error = await invoke(connector({ lookup })).catch((reason: unknown) => reason);

    expect(error).toMatchObject({
      message: 'connector request failed',
      category: 'network_error',
      retryable: false,
    });
    expect(JSON.stringify(error)).not.toContain(routeA.baseUrl);
  });

  it('ignores hostile message and metadata accessors on branded routed failures', () => {
    const crafted = new ConnectorInvocationError('safe');
    for (const key of [
      'message',
      'status',
      'category',
      'attempts',
      'retryable',
      'retryAfterMs',
      'responseExcerpt',
    ]) {
      Object.defineProperty(crafted, key, {
        configurable: true,
        get() {
          throw new Error(`hostile ${key} ${routeA.baseUrl}`);
        },
      });
    }

    const error = sanitizedCustomerRouteError(crafted);

    expect(error).toMatchObject({ message: 'connector request failed' });
    expect(JSON.stringify(error)).not.toContain(routeA.baseUrl);
  });
});
