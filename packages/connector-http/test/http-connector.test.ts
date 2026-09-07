import type { OperationSignature } from '@noodle-borg/compiler';
import { ConnectorInvocationError } from '@noodle-borg/runtime';
import { describe, expect, it, vi } from 'vitest';
import { HttpConnector, type HttpConnectorConfig } from '../src/index.js';
import {
  baseUrl,
  baseUrl2,
  connector,
  createSig,
  credential,
  getAlwaysUnavailableCount,
  getFlakyCount,
  getPostSig,
  getRateLimitedCount,
  getUnauthorizedCount,
  lastRequest,
  lastRequest2,
  origin,
  origin2,
  resetAlwaysUnavailableCount,
  resetFlakyCount,
  resetRateLimitedCount,
  resetUnauthorizedCount,
} from './http-connector-fixture.js';

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (e: unknown) => e,
  );
}

describe('HttpConnector', () => {
  it('substitutes path args, fetches, and maps the response to declared fields', async () => {
    const result = await connector().invoke({
      operation: 'get_post',
      args: { post_id: '5' },
      credential,
    });
    expect(result).toEqual({ title: 't5', body: 'b5' }); // `extra` dropped by mapResponse
    expect(lastRequest.url).toBe('/posts/5');
  });

  it('appends query args', async () => {
    await connector().invoke({ operation: 'list_posts', args: { user_id: '2' }, credential });
    expect(lastRequest.url).toBe('/posts?user_id=2');
  });

  it('omits undefined query args', async () => {
    await connector().invoke({ operation: 'list_posts', args: {}, credential });
    expect(lastRequest.url).toBe('/posts');
  });

  it('URL-encodes path args before substitution', async () => {
    await connector().invoke({
      operation: 'encoded',
      args: { value: 'a/b? c' },
      credential,
    });
    expect(lastRequest.url).toBe('/encoded/a%2Fb%3F%20c');
  });

  it('rejects a request that resolves to a disallowed origin', async () => {
    await expect(
      connector().invoke({ operation: 'bad_origin', args: { post_id: '1' }, credential }),
    ).rejects.toThrow(/disallowed origin/);
  });

  it('resolves one managed exact origin for the base URL and egress allowlist', async () => {
    const c = connector({
      baseUrl: '${env.STORE_ORIGIN}',
      allowedOrigins: ['${env.STORE_ORIGIN}'],
    });

    await expect(
      c.invoke({
        operation: 'get_post',
        args: { post_id: '1' },
        credential,
        env: { STORE_ORIGIN: baseUrl },
      }),
    ).resolves.toEqual({ title: 't1', body: 'b1' });
  });

  it('fails closed when a managed egress origin is missing, non-canonical, or different', async () => {
    const c = connector({
      baseUrl: '${env.STORE_ORIGIN}',
      allowedOrigins: ['${env.ALLOWED_STORE_ORIGIN}'],
    });
    const call = (env: Record<string, string>) =>
      c.invoke({ operation: 'get_post', args: { post_id: '1' }, credential, env });

    await expect(call({ STORE_ORIGIN: baseUrl })).rejects.toThrow(/managed variable/i);
    await expect(
      call({ STORE_ORIGIN: baseUrl, ALLOWED_STORE_ORIGIN: `${baseUrl}/products` }),
    ).rejects.toThrow(/canonical.*origin/i);
    await expect(
      call({
        STORE_ORIGIN: 'http://merchant.example.com',
        ALLOWED_STORE_ORIGIN: 'http://merchant.example.com',
      }),
    ).rejects.toThrow(/HTTPS origin/i);
    await expect(call({ STORE_ORIGIN: baseUrl, ALLOWED_STORE_ORIGIN: baseUrl2 })).rejects.toThrow(
      /disallowed origin/i,
    );
  });

  it('throws on a non-2xx response', async () => {
    await expect(
      connector().invoke({ operation: 'missing', args: { post_id: '1' }, credential }),
    ).rejects.toThrow(/responded 404/);
  });

  it('exposes only safe status and excerpt details for non-2xx responses', async () => {
    const error = await captureError(
      connector().invoke({ operation: 'missing', args: { post_id: '1' }, credential }),
    );
    expect(error).toBeInstanceOf(ConnectorInvocationError);
    expect(error).toMatchObject({
      status: 404,
      responseExcerpt: '{}',
    });
    expect(JSON.stringify(error)).not.toContain('svc-token');
  });

  it('attaches auth headers from the broker credential when configured', async () => {
    const c = connector({ authHeader: (cred) => ({ authorization: `Bearer ${cred.token}` }) });
    await c.invoke({ operation: 'get_post', args: { post_id: '1' }, credential });
    expect(lastRequest.headers.authorization).toBe('Bearer svc-token');
  });

  it('sends configured headers and lets auth headers win on conflicts', async () => {
    const c = connector({
      headers: { authorization: 'Bearer static-token', 'x-custom': 'configured' },
      authHeader: (cred) => ({ authorization: `Bearer ${cred.token}` }),
    });
    await c.invoke({ operation: 'get_post', args: { post_id: '1' }, credential });
    expect(lastRequest.headers['x-custom']).toBe('configured');
    expect(lastRequest.headers.authorization).toBe('Bearer svc-token');
  });

  it('sends no auth header by default', async () => {
    await connector().invoke({ operation: 'get_post', args: { post_id: '1' }, credential });
    expect(lastRequest.headers.authorization).toBeUndefined();
  });

  it('sends cookie credentials without an Authorization header', async () => {
    const c = connector({ auth: { kind: 'cookie' } });
    await c.invoke({
      operation: 'get_post',
      args: { post_id: '1' },
      credential: { kind: 'cookie', cookie: 'session=abc; other=def' },
    });
    expect(lastRequest.headers.cookie).toBe('session=abc; other=def');
    expect(lastRequest.headers.authorization).toBeUndefined();
  });

  it('rejects oversized responses declared by Content-Length', async () => {
    await expect(
      connector({ maxBytes: 10 }).invoke({ operation: 'large_declared', args: {}, credential }),
    ).rejects.toThrow(/size limit/);
  });

  it('rejects oversized chunked responses without Content-Length', async () => {
    await expect(
      connector({ maxBytes: 10 }).invoke({ operation: 'large_chunked', args: {}, credential }),
    ).rejects.toThrow(/size limit/);
  });

  it('throws on invalid JSON responses', async () => {
    await expect(
      connector().invoke({ operation: 'invalid_json', args: {}, credential }),
    ).rejects.toThrow();
  });

  const textSig: OperationSignature = {
    type: 'read',
    input: {},
    output: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
  };
  const textConnector = (extra: Partial<HttpConnectorConfig> = {}): HttpConnector =>
    new HttpConnector({
      id: 'docs',
      version: '1.0.0',
      baseUrl,
      operations: {
        fetch_full: {
          path: '/plain-text',
          signature: textSig,
          responseType: 'text',
          mapResponse: (raw) => ({ text: raw }),
        },
        raw_invalid: {
          path: '/invalid-json', // body is "not json" — a JSON-mode op would throw here
          signature: textSig,
          responseType: 'text',
          mapResponse: (raw) => ({ text: raw }),
        },
        big: { path: '/plain-large', signature: textSig, responseType: 'text' },
      },
      ...extra,
    });

  it('reads a text/plain body verbatim when responseType is "text"', async () => {
    const result = await textConnector().invoke({
      operation: 'fetch_full',
      args: {},
      credential,
    });
    expect(result).toEqual({
      text: '# Getting Started\nURL: /getting-started\nInstall the CLI, then run noodle dev.',
    });
    // Text operations advertise a text Accept header rather than application/json.
    expect(String(lastRequest.headers.accept)).toMatch(/text\/plain/);
    expect(String(lastRequest.headers.accept)).not.toMatch(/application\/json/);
  });

  it('does not JSON-parse a text response (succeeds where JSON mode would throw)', async () => {
    await expect(
      textConnector().invoke({ operation: 'raw_invalid', args: {}, credential }),
    ).resolves.toEqual({ text: 'not json' });
  });

  it('still enforces the response size cap in text mode', async () => {
    await expect(
      textConnector({ maxBytes: 10 }).invoke({ operation: 'big', args: {}, credential }),
    ).rejects.toThrow(/size limit/);
  });

  it('aborts slow requests at the configured timeout', async () => {
    await expect(
      connector({ timeoutMs: 5 }).invoke({ operation: 'slow', args: {}, credential }),
    ).rejects.toThrow();
  });

  it('retries transient read failures and returns the eventual response', async () => {
    resetFlakyCount();
    const c = connector({
      operations: {
        flaky: {
          path: '/flaky',
          signature: { type: 'read', input: {}, output: { count: { type: 'number' } } },
          resilience: { retry: { maxAttempts: 2, baseDelayMs: 1 } },
        },
      } as never,
    });
    await expect(c.invoke({ operation: 'flaky', args: {}, credential })).resolves.toEqual({
      count: 2,
    });
    expect(getFlakyCount()).toBe(2);
  });

  it('reports safe retry metadata after exhausting transient read failures', async () => {
    resetAlwaysUnavailableCount();
    const c = connector({
      operations: {
        unavailable: {
          path: '/always-503',
          signature: { type: 'read', input: {}, output: {} },
          resilience: { retry: { maxAttempts: 3, baseDelayMs: 1 } },
        },
      },
    });
    const err = await captureError(c.invoke({ operation: 'unavailable', args: {}, credential }));
    expect(err).toBeInstanceOf(ConnectorInvocationError);
    expect(err).toMatchObject({
      status: 503,
      category: 'upstream_5xx',
      attempts: 3,
      retryable: true,
      responseExcerpt: 'still unavailable',
    });
    expect(JSON.stringify(err)).not.toContain('svc-token');
    expect(getAlwaysUnavailableCount()).toBe(3);
  });

  it('does not retry non-retryable upstream statuses', async () => {
    resetUnauthorizedCount();
    const c = connector({
      operations: {
        unauthorized: {
          path: '/unauthorized',
          signature: { type: 'read', input: {}, output: {} },
          resilience: { retry: { maxAttempts: 3, baseDelayMs: 1 } },
        },
      },
    });
    await expect(
      c.invoke({ operation: 'unauthorized', args: {}, credential }),
    ).rejects.toMatchObject({
      status: 401,
      category: 'upstream_4xx',
      attempts: 1,
      retryable: false,
    });
    expect(getUnauthorizedCount()).toBe(1);
  });

  it('retries bounded rate-limit responses', async () => {
    resetRateLimitedCount();
    const c = connector({
      operations: {
        rate_limited: {
          path: '/rate-limited',
          signature: { type: 'read', input: {}, output: { count: { type: 'number' } } },
          resilience: { retry: { maxAttempts: 2, baseDelayMs: 1 } },
        },
      },
    });
    await expect(c.invoke({ operation: 'rate_limited', args: {}, credential })).resolves.toEqual({
      count: 2,
    });
    expect(getRateLimitedCount()).toBe(2);
  });

  it('applies projection hidden fields and emits widget-only metadata', async () => {
    const c = connector({
      operations: {
        projected: {
          path: '/posts/{post_id}',
          signature: {
            type: 'read',
            input: {
              type: 'object',
              properties: { post_id: { type: 'string' } },
              required: ['post_id'],
              additionalProperties: false,
            },
            output: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                internal: { type: 'string' },
                nested: { type: 'object' },
              },
              additionalProperties: false,
            },
          },
          mapResponse: (j) => ({
            title: (j as { title: string }).title,
            internal: 'hide-me',
            nested: { keep: 'yes', traceId: `trace-${(j as { id: number }).id}` },
          }),
          projection: {
            hiddenFields: ['internal', 'nested.traceId'],
            sourceLabel: 'Posts API',
            freshness: { ttlMs: 60_000 },
            widgetMeta: (_json, args, output) => ({
              internalId: String(args.post_id),
              traceId: (output.nested as { traceId: string }).traceId,
            }),
          },
        },
      },
    });

    const result = await c.invoke({
      operation: 'projected',
      args: { post_id: '5' },
      credential,
    });
    expect(result).toEqual({
      title: 't5',
      nested: { keep: 'yes' },
      __noodleResultMeta: {
        noodle: {
          projection: {
            widgetMeta: { internalId: '5', traceId: 'trace-5' },
            source: { label: 'Posts API' },
            freshness: expect.objectContaining({ ttlMs: 60_000, stale: false }),
          },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain('hide-me');
  });

  it('attaches partial-result projection metadata for paginated reads', async () => {
    const c = connector({
      operations: {
        list: {
          path: '/ignored',
          signature: {
            type: 'read',
            input: {},
            output: { items: { type: 'array' }, partial: { type: 'boolean' } },
          },
          fake: {
            pages: [
              { results: [{ id: 'a', internal: 'x' }], next_cursor: 'next' },
              { results: [{ id: 'b', internal: 'y' }], next_cursor: 'more' },
            ],
          },
          pagination: {
            kind: 'cursor',
            cursorParam: 'cursor',
            maxPages: 1,
            items: (json) => (json as { results: unknown[] }).results,
            nextCursor: (json) => (json as { next_cursor: string | null }).next_cursor,
          },
          mapResponse: (json) => ({
            items: (json as { items: unknown[] }).items,
            partial: (json as { partial: boolean }).partial,
          }),
          projection: { hiddenFields: ['items.internal'], sourceLabel: 'Fake catalog' },
        },
      },
      fakeMode: true,
    });

    await expect(c.invoke({ operation: 'list', args: {}, credential })).resolves.toEqual({
      items: [{ id: 'a' }],
      partial: true,
      __noodleResultMeta: {
        noodle: {
          projection: {
            source: { label: 'Fake catalog' },
            partial: { value: true, stopReason: 'max_pages' },
          },
        },
      },
    });
  });

  it('does not retry action operations through direct runtime config', async () => {
    resetAlwaysUnavailableCount();
    const c = connector({
      operations: {
        create: {
          method: 'POST',
          path: '/always-503',
          signature: { type: 'action', input: {}, output: {} },
          resilience: { retry: { maxAttempts: 3, baseDelayMs: 1 } },
        },
      },
    });
    await expect(c.invoke({ operation: 'create', args: {}, credential })).rejects.toMatchObject({
      attempts: 1,
      retryable: false,
    });
    expect(getAlwaysUnavailableCount()).toBe(1);
  });
});

describe('HttpConnector (POST, declarative auth, multi-host)', () => {
  function poster(): HttpConnector {
    return new HttpConnector({
      id: 'echo',
      version: '1.0.0',
      baseUrl,
      allowedOrigins: [origin, origin2],
      operations: {
        create: {
          method: 'POST',
          path: '/anything',
          auth: { kind: 'bearer' },
          body: (a) => ({ label: a.label }),
          signature: createSig,
        },
        with_apikey: {
          method: 'POST',
          path: '/anything',
          auth: { kind: 'apiKey', header: 'X-API-Key' },
          body: (a) => ({ label: a.label }),
          signature: createSig,
        },
        plain: {
          method: 'POST',
          path: '/anything',
          body: (a) => ({ label: a.label }),
          signature: createSig,
        },
        versioned_base_path: {
          method: 'POST',
          path: '/anything',
          baseUrl: `${baseUrl}/api/v1`,
          body: (a) => ({ label: a.label }),
          signature: createSig,
        },
        on_secondary: {
          method: 'POST',
          path: '/anything',
          baseUrl: baseUrl2,
          auth: { kind: 'bearer' },
          body: (a) => ({ label: a.label }),
          signature: createSig,
        },
        undeclared_host: {
          method: 'POST',
          path: '/anything',
          baseUrl: 'http://127.0.0.1:1/',
          auth: { kind: 'bearer' },
          body: (a) => ({ label: a.label }),
          signature: createSig,
        },
      },
    });
  }

  it('sends a JSON POST body with a content-type header', async () => {
    await poster().invoke({ operation: 'create', args: { label: 'hello' }, credential });
    expect(lastRequest.method).toBe('POST');
    expect(lastRequest.headers['content-type']).toMatch(/application\/json/);
    expect(lastRequest.body).toEqual({ label: 'hello' });
  });

  it('preserves a versioned base URL path when the operation path starts with a slash', async () => {
    await poster().invoke({
      operation: 'versioned_base_path',
      args: { label: 'hello' },
      credential,
    });
    expect(lastRequest.url).toBe('/api/v1/anything');
  });

  it('attaches a bearer auth header from the broker credential', async () => {
    await poster().invoke({ operation: 'create', args: { label: 'x' }, credential });
    expect(lastRequest.headers.authorization).toBe('Bearer svc-token');
  });

  it('attaches an apiKey auth header (and no Authorization)', async () => {
    await poster().invoke({ operation: 'with_apikey', args: { label: 'x' }, credential });
    expect(lastRequest.headers['x-api-key']).toBe('svc-token');
    expect(lastRequest.headers.authorization).toBeUndefined();
  });

  it('sends no auth header when the operation declares none', async () => {
    await poster().invoke({ operation: 'plain', args: { label: 'x' }, credential });
    expect(lastRequest.headers.authorization).toBeUndefined();
    expect(lastRequest.headers['x-api-key']).toBeUndefined();
  });

  it('accepts a declared second host', async () => {
    await poster().invoke({ operation: 'on_secondary', args: { label: 'two' }, credential });
    expect(lastRequest2.method).toBe('POST');
    expect(lastRequest2.body).toEqual({ label: 'two' });
  });

  it('rejects a request to an undeclared host', async () => {
    await expect(
      poster().invoke({ operation: 'undeclared_host', args: { label: 'x' }, credential }),
    ).rejects.toThrow(/disallowed origin/);
  });

  it('never leaks the credential secret in a thrown error', async () => {
    const err = await captureError(
      poster().invoke({
        operation: 'undeclared_host',
        args: { label: 'x' },
        credential: { token: 'super-secret-xyz' },
      }),
    );
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).not.toContain('super-secret-xyz');
  });

  it('applies connector-level declarative auth when an operation has no auth', async () => {
    const c = new HttpConnector({
      id: 'echo',
      version: '1.0.0',
      baseUrl,
      auth: { kind: 'bearer' },
      operations: {
        plain: {
          method: 'POST',
          path: '/anything',
          body: (a) => ({ label: a.label }),
          signature: createSig,
        },
      },
    });
    await c.invoke({ operation: 'plain', args: { label: 'x' }, credential });
    expect(lastRequest.headers.authorization).toBe('Bearer svc-token');
  });

  it('lets operation-level auth override connector-level auth', async () => {
    const c = new HttpConnector({
      id: 'echo',
      version: '1.0.0',
      baseUrl,
      auth: { kind: 'apiKey', header: 'X-Connector-Key' },
      operations: {
        create: {
          method: 'POST',
          path: '/anything',
          auth: { kind: 'bearer' },
          body: (a) => ({ label: a.label }),
          signature: createSig,
        },
      },
    });
    await c.invoke({ operation: 'create', args: { label: 'x' }, credential });
    expect(lastRequest.headers.authorization).toBe('Bearer svc-token');
    expect(lastRequest.headers['x-connector-key']).toBeUndefined();
  });

  it('uses legacy authHeader only when no declarative auth resolves', async () => {
    const c = new HttpConnector({
      id: 'echo',
      version: '1.0.0',
      baseUrl,
      authHeader: (cred) => ({ 'x-legacy-key': cred.token }),
      operations: {
        plain: {
          method: 'POST',
          path: '/anything',
          body: (a) => ({ label: a.label }),
          signature: createSig,
        },
      },
    });
    await c.invoke({ operation: 'plain', args: { label: 'x' }, credential });
    expect(lastRequest.headers['x-legacy-key']).toBe('svc-token');
    expect(lastRequest.headers.authorization).toBeUndefined();
  });

  it('prefers declarative connector auth over legacy authHeader', async () => {
    const c = new HttpConnector({
      id: 'echo',
      version: '1.0.0',
      baseUrl,
      auth: { kind: 'apiKey', header: 'X-Api-Key' },
      authHeader: (cred) => ({ authorization: `Bearer ${cred.token}` }),
      operations: {
        plain: {
          method: 'POST',
          path: '/anything',
          body: (a) => ({ label: a.label }),
          signature: createSig,
        },
      },
    });
    await c.invoke({ operation: 'plain', args: { label: 'x' }, credential });
    expect(lastRequest.headers['x-api-key']).toBe('svc-token');
    expect(lastRequest.headers.authorization).toBeUndefined();
  });

  it('defaults allowedOrigins to the connector baseUrl origin', async () => {
    const c = new HttpConnector({
      id: 'echo',
      version: '1.0.0',
      baseUrl,
      operations: {
        create: {
          method: 'POST',
          path: '/anything',
          body: (a) => ({ label: a.label }),
          signature: createSig,
        },
      },
    });
    await c.invoke({ operation: 'create', args: { label: 'x' }, credential });
    expect(lastRequest.url).toBe('/anything');
  });

  it('rejects an operation baseUrl on a second origin when allowedOrigins is omitted', async () => {
    const c = new HttpConnector({
      id: 'echo',
      version: '1.0.0',
      baseUrl,
      operations: {
        on_secondary: {
          method: 'POST',
          path: '/anything',
          baseUrl: baseUrl2,
          body: (a) => ({ label: a.label }),
          signature: createSig,
        },
      },
    });
    await expect(
      c.invoke({ operation: 'on_secondary', args: { label: 'x' }, credential }),
    ).rejects.toThrow(/disallowed origin/);
  });

  it('permits an operation baseUrl on a second origin when explicitly allowlisted', async () => {
    const c = new HttpConnector({
      id: 'echo',
      version: '1.0.0',
      baseUrl,
      allowedOrigins: [origin, origin2],
      operations: {
        on_secondary: {
          method: 'POST',
          path: '/anything',
          baseUrl: baseUrl2,
          body: (a) => ({ label: a.label }),
          signature: createSig,
        },
      },
    });
    await c.invoke({ operation: 'on_secondary', args: { label: 'secondary' }, credential });
    expect(lastRequest2.body).toEqual({ label: 'secondary' });
  });

  it('sends no body or content-type for POST operations without a body builder', async () => {
    const c = new HttpConnector({
      id: 'echo',
      version: '1.0.0',
      baseUrl,
      operations: {
        empty_post: { method: 'POST', path: '/anything', signature: createSig },
      },
    });
    await c.invoke({ operation: 'empty_post', args: { label: 'x' }, credential });
    expect(lastRequest.method).toBe('POST');
    expect(lastRequest.body).toBeUndefined();
    expect(lastRequest.headers['content-type']).toBeUndefined();
  });

  it('ignores a configured body builder for GET operations', async () => {
    const body = vi.fn(() => {
      throw new Error('GET body builder should not run');
    });
    const c = new HttpConnector({
      id: 'echo',
      version: '1.0.0',
      baseUrl,
      operations: {
        get_with_body: {
          method: 'GET',
          path: '/posts/{post_id}',
          body,
          signature: getPostSig,
        },
      },
    });
    await c.invoke({ operation: 'get_with_body', args: { post_id: '8' }, credential });
    expect(body).not.toHaveBeenCalled();
    expect(lastRequest.method).toBe('GET');
    expect(lastRequest.url).toBe('/posts/8');
    expect(lastRequest.headers['content-type']).toBeUndefined();
  });

  it('normalizes mixed-case apiKey header names before sending the request', async () => {
    const c = new HttpConnector({
      id: 'echo',
      version: '1.0.0',
      baseUrl,
      auth: { kind: 'apiKey', header: 'X-Mixed-Case-Key' },
      operations: {
        plain: {
          method: 'POST',
          path: '/anything',
          body: (a) => ({ label: a.label }),
          signature: createSig,
        },
      },
    });
    await c.invoke({ operation: 'plain', args: { label: 'x' }, credential });
    expect(lastRequest.headers['x-mixed-case-key']).toBe('svc-token');
  });

  it('rejects an empty apiKey header name instead of sending a credential header', async () => {
    const c = new HttpConnector({
      id: 'echo',
      version: '1.0.0',
      baseUrl,
      auth: { kind: 'apiKey', header: '' },
      operations: {
        plain: {
          method: 'POST',
          path: '/anything',
          body: (a) => ({ label: a.label }),
          signature: createSig,
        },
      },
    });
    const err = await captureError(
      c.invoke({
        operation: 'plain',
        args: { label: 'x' },
        credential: { token: 'empty-header-secret' },
      }),
    );
    expect(err).toBeInstanceOf(ConnectorInvocationError);
    expect(err).toMatchObject({ category: 'network_error', attempts: 1 });
    expect(String(err)).not.toContain('empty-header-secret');
  });

  it('does not leak the credential secret on backend error responses', async () => {
    const err = await captureError(
      connector({ auth: { kind: 'bearer' } }).invoke({
        operation: 'missing',
        args: { post_id: '1' },
        credential: { token: 'backend-secret-xyz' },
      }),
    );
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toContain('backend responded 404');
    expect(String(err)).not.toContain('backend-secret-xyz');
  });

  it('does not leak the credential secret on invalid JSON responses', async () => {
    const err = await captureError(
      connector({ auth: { kind: 'bearer' } }).invoke({
        operation: 'invalid_json',
        args: {},
        credential: { token: 'json-secret-xyz' },
      }),
    );
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).not.toContain('json-secret-xyz');
  });

  it('does not leak the credential secret on timeout errors', async () => {
    const err = await captureError(
      connector({ auth: { kind: 'bearer' }, timeoutMs: 5 }).invoke({
        operation: 'slow',
        args: {},
        credential: { token: 'timeout-secret-xyz' },
      }),
    );
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).not.toContain('timeout-secret-xyz');
  });
});
