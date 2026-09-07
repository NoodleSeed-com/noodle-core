import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type CatalogConnector,
  compile,
  computeSignatureHash,
  InMemoryCatalog,
} from '@noodle-borg/compiler';
import {
  type ExecuteDeps,
  executeTool,
  InMemoryConnectorRegistry,
  StaticServiceBroker,
} from '@noodle-borg/runtime';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileConnectors } from '../src/index.js';

interface Recorded {
  method: string;
  url: string;
  body: unknown;
}
let server: Server;
let base: string;
let last: Recorded;
let sometimesAttempts = 0;
let cursorAttempts = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      last = {
        method: req.method ?? '',
        url: req.url ?? '',
        body: raw ? JSON.parse(raw) : undefined,
      };
      const url = new URL(req.url ?? '/', 'http://localhost');
      const getPost = /^\/posts\/(\w+)$/.exec(url.pathname);
      if (req.method === 'GET' && getPost) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: getPost[1],
            title: `t${getPost[1]}`,
            body: `b${getPost[1]}`,
            extra: 'x',
          }),
        );
        return;
      }
      if (req.method === 'POST' && url.pathname === '/echo') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ echoed: last.body }));
        return;
      }
      if (req.method === 'PATCH' && url.pathname === '/fields') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(last.body));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/sometimes') {
        sometimesAttempts += 1;
        if (sometimesAttempts === 1) {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'try again' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/cursor-items') {
        cursorAttempts += 1;
        const cursor = url.searchParams.get('cursor');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify(
            cursor === 'next'
              ? { results: [{ id: 'b' }], next_cursor: null }
              : { results: [{ id: 'a' }], next_cursor: 'next' },
          ),
        );
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

function postsCatalog(): string {
  return `
connectors:
  - id: jsonplaceholder
    version: 1.0.0
    http:
      baseUrl: ${base}
      allowedOrigins:
        - ${base}
    operations:
      get_post:
        type: read
        method: GET
        path: /posts/{post_id}
        input: { type: object, properties: { post_id: { type: string } }, required: [post_id], additionalProperties: false }
        output: { type: object, properties: { title: { type: string }, body: { type: string } }, additionalProperties: false }
        response:
          title: \${response.title}
          body: \${response.body}
`;
}

const credential = { token: 'svc' };

describe('compileConnectors', () => {
  it('rejects tenant-declared builtin HTTP connectors', () => {
    const result = compileConnectors(`
connectors:
  - id: platform
    version: 1.0.0
    kind: builtin
    http:
      baseUrl: ${base}
    operations:
      ping:
        type: read
        method: GET
        path: /ping
        output: { type: object, properties: { ok: { type: boolean } }, additionalProperties: false }
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'reserved_connector_kind',
        path: 'connectors.platform.kind',
      }),
    );
  });

  it('rejects tenant-declared builtin compute connectors', () => {
    const result = compileConnectors(`
connectors:
  - id: platform_compute
    version: 1.0.0
    kind: builtin
    operations:
      ping:
        type: read
        output: { type: object, properties: { ok: { type: boolean } }, additionalProperties: false }
        code: |
          function ping() {
            return { ok: true };
          }
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'reserved_connector_kind',
        path: 'connectors.platform_compute.kind',
      }),
    );
  });

  it('compiles a GET connector whose response mapping shapes the output', async () => {
    const result = compileConnectors(postsCatalog());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const connector = result.connectors[0];
    const out = await connector?.invoke({
      operation: 'get_post',
      args: { post_id: '5' },
      credential,
    });
    expect(out).toEqual({ title: 't5', body: 'b5' }); // `extra`/`id` dropped by the response map
    expect(last.url).toBe('/posts/5');
  });

  it('compiles a whole-body request expression', async () => {
    const result = compileConnectors(`
connectors:
  - id: fields
    version: 1.0.0
    http:
      baseUrl: ${base}
      allowedOrigins:
        - ${base}
    operations:
      update:
        type: action
        method: PATCH
        path: /fields
        input: { type: object, properties: { fields: { type: object } }, required: [fields], additionalProperties: false }
        output: { type: object, properties: { title: { type: string } }, additionalProperties: false }
        request: \${args.fields}
        response:
          title: \${response.Title}
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = await result.connectors[0]?.invoke({
      operation: 'update',
      args: { fields: { Title: 'Updated' } },
      credential,
    });
    expect(last.method).toBe('PATCH');
    expect(last.body).toEqual({ Title: 'Updated' });
    expect(out).toEqual({ title: 'Updated' });
  });

  it('compiles HTTP operation projection metadata and keeps hidden fields out of output', async () => {
    const result = compileConnectors(`
connectors:
  - id: projected_api
    version: 1.0.0
    http:
      baseUrl: ${base}
      allowedOrigins:
        - ${base}
    operations:
      get_post:
        type: read
        method: GET
        path: /posts/{post_id}
        input: { type: object, properties: { post_id: { type: string } }, required: [post_id], additionalProperties: false }
        output: { type: object, properties: { title: { type: string }, internal: { type: string }, nested: { type: object } }, additionalProperties: false }
        response:
          title: \${response.title}
          internal: \${response.extra}
          nested:
            keep: yes
            traceId: \${response.id}
        projection:
          hiddenFields:
            - internal
            - nested.traceId
          widgetMeta:
            rawId: \${response.id}
            postId: \${args.post_id}
            traceId: \${output.nested.traceId}
          sourceLabel: Posts API
          freshness:
            ttlMs: 60000
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const out = await result.connectors[0]?.invoke({
      operation: 'get_post',
      args: { post_id: '5' },
      credential,
    });
    expect(out).toEqual({
      title: 't5',
      nested: { keep: 'yes' },
      __noodleResultMeta: {
        noodle: {
          projection: {
            widgetMeta: { rawId: '5', postId: '5', traceId: '5' },
            source: { label: 'Posts API' },
            freshness: expect.objectContaining({ ttlMs: 60_000, stale: false }),
          },
        },
      },
    });
  });

  it('rejects projection widgetMeta expressions with unknown roots', () => {
    const result = compileConnectors(`
connectors:
  - id: bad_projection_api
    version: 1.0.0
    http:
      baseUrl: ${base}
    operations:
      get_post:
        type: read
        method: GET
        path: /posts/{post_id}
        output: { type: object, properties: { title: { type: string } }, additionalProperties: false }
        response:
          title: \${response.title}
        projection:
          widgetMeta:
            secret: \${env.SECRET}
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        path: 'connectors.bad_projection_api.operations.get_post.projection.widgetMeta.secret',
      }),
    );
  });

  it('compiles client-credentials auth into bearer runtime auth and secret bindings', async () => {
    const result = compileConnectors(`
connectors:
  - id: oauth_api
    version: 1.0.0
    http:
      baseUrl: ${base}
      allowedOrigins:
        - ${base}
      auth:
        kind: clientCredentials
        tokenUrl: ${base}/oauth/token
        clientId: client-a
        clientSecret: API_CLIENT_SECRET
        scopes: [read:items]
        audience: https://api.example.com
    operations:
      get_post:
        type: read
        method: GET
        path: /posts/{post_id}
        input: { type: object, properties: { post_id: { type: string } }, required: [post_id], additionalProperties: false }
        output: { type: object, properties: { title: { type: string } }, additionalProperties: false }
        response:
          title: \${response.title}
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.secretBindings).toEqual([
      expect.objectContaining({
        connectorId: 'oauth_api',
        connectorVersion: '1.0.0',
        secretRef: 'API_CLIENT_SECRET',
        authKind: 'clientCredentials',
        clientCredentials: expect.objectContaining({
          profile: 'oauth2',
          tokenUrl: `${base}/oauth/token`,
          clientId: 'client-a',
          scopes: ['read:items'],
          audience: 'https://api.example.com',
          authMethod: 'client_secret_basic',
        }),
      }),
    ]);
    const out = await result.connectors[0]?.invoke({
      operation: 'get_post',
      args: { post_id: '5' },
      credential: { token: 'access-token' },
    });
    expect(out).toEqual({ title: 't5' });
  });

  it('compiles operation resilience into HTTP connector retry behavior', async () => {
    sometimesAttempts = 0;
    const result = compileConnectors(`
connectors:
  - id: resilient_api
    version: 1.0.0
    http:
      baseUrl: ${base}
      allowedOrigins:
        - ${base}
    operations:
      get_post:
        type: read
        method: GET
        path: /sometimes
        resilience:
          timeoutMs: 500
          retry:
            maxAttempts: 2
            baseDelayMs: 1
        output: { type: object, properties: { ok: { type: boolean } }, additionalProperties: false }
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await expect(
      result.connectors[0]?.invoke({ operation: 'get_post', args: {}, credential }),
    ).resolves.toEqual({ ok: true });
    expect(sometimesAttempts).toBe(2);
  });

  it('compiles cursor pagination and maps the aggregate response', async () => {
    cursorAttempts = 0;
    const result = compileConnectors(`
connectors:
  - id: paginated_api
    version: 1.0.0
    http:
      baseUrl: ${base}
      allowedOrigins:
        - ${base}
    operations:
      list:
        type: read
        method: GET
        path: /cursor-items
        output: { type: object, properties: { items: { type: array }, pageCount: { type: number }, partial: { type: boolean } }, additionalProperties: false }
        pagination:
          kind: cursor
          cursorParam: cursor
          nextCursor: \${response.next_cursor}
          items: \${response.results}
          maxPages: 5
          maxItems: 10
        response:
          items: \${response.items}
          pageCount: \${response.pageCount}
          partial: \${response.partial}
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await expect(
      result.connectors[0]?.invoke({ operation: 'list', args: {}, credential }),
    ).resolves.toEqual({
      items: [{ id: 'a' }, { id: 'b' }],
      pageCount: 2,
      partial: false,
    });
    expect(cursorAttempts).toBe(2);
  });

  it('compiles fake response mode and maps output without live HTTP', async () => {
    const result = compileConnectors(
      `
connectors:
  - id: fake_posts
    version: 1.0.0
    http:
      baseUrl: https://api.example.test
    operations:
      get_post:
        type: read
        method: GET
        path: /posts/{post_id}
        input: { type: object, properties: { post_id: { type: string } }, required: [post_id], additionalProperties: false }
        output: { type: object, properties: { title: { type: string } }, additionalProperties: false }
        fake:
          response:
            title: Fake title
        response:
          title: \${response.title}
`,
      { mode: 'fake' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await expect(
      result.connectors[0]?.invoke({ operation: 'get_post', args: { post_id: '5' }, credential }),
    ).resolves.toEqual({ title: 'Fake title' });
  });

  it('ignores fake responses in live mode', async () => {
    const result = compileConnectors(`
connectors:
  - id: live_posts
    version: 1.0.0
    http:
      baseUrl: ${base}
      allowedOrigins:
        - ${base}
    operations:
      get_post:
        type: read
        method: GET
        path: /posts/{post_id}
        input: { type: object, properties: { post_id: { type: string } }, required: [post_id], additionalProperties: false }
        output: { type: object, properties: { title: { type: string } }, additionalProperties: false }
        fake:
          response:
            title: Fake title
        response:
          title: \${response.title}
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await expect(
      result.connectors[0]?.invoke({ operation: 'get_post', args: { post_id: '5' }, credential }),
    ).resolves.toEqual({ title: 't5' });
  });

  it('rejects fake pages on non-paginated operations', () => {
    const result = compileConnectors(`
connectors:
  - id: invalid_fake
    version: 1.0.0
    http:
      baseUrl: ${base}
    operations:
      get:
        type: read
        method: GET
        path: /items
        output: { type: object, properties: { items: { type: array } }, additionalProperties: false }
        fake:
          pages:
            - results: []
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'fake_pages_without_pagination',
        path: 'connectors.invalid_fake.operations.get.fake.pages',
      }),
    );
  });

  it('rejects fake responses on paginated operations', () => {
    const result = compileConnectors(`
connectors:
  - id: invalid_paginated_fake
    version: 1.0.0
    http:
      baseUrl: ${base}
    operations:
      list:
        type: read
        method: GET
        path: /items
        output: { type: object, properties: { items: { type: array } }, additionalProperties: false }
        pagination:
          kind: cursor
          cursorParam: cursor
          nextCursor: \${response.next_cursor}
          items: \${response.results}
        fake:
          response:
            results: []
            next_cursor: null
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'fake_response_for_paginated_operation',
        path: 'connectors.invalid_paginated_fake.operations.list.fake.response',
      }),
    );
  });

  it('rejects retry resilience on side-effecting action operations', () => {
    const result = compileConnectors(`
connectors:
  - id: unsafe_api
    version: 1.0.0
    http:
      baseUrl: ${base}
    operations:
      create:
        type: action
        method: POST
        path: /echo
        resilience:
          retry:
            maxAttempts: 2
        output: { type: object, properties: { ok: { type: boolean } }, additionalProperties: false }
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'unsafe_retry_action',
        path: 'connectors.unsafe_api.operations.create.resilience.retry',
      }),
    );
  });

  it('rejects invalid resilience values during schema validation', () => {
    const result = compileConnectors(`
connectors:
  - id: invalid_resilience
    version: 1.0.0
    http:
      baseUrl: ${base}
    operations:
      read:
        type: read
        method: GET
        path: /x
        resilience:
          timeoutMs: -1
          retry:
            maxAttempts: 0
        output: { type: object, properties: { ok: { type: boolean } }, additionalProperties: false }
`);
    expect(result.ok).toBe(false);
  });

  it('rejects pagination on side-effecting action operations', () => {
    const result = compileConnectors(`
connectors:
  - id: unsafe_pagination
    version: 1.0.0
    http:
      baseUrl: ${base}
    operations:
      create:
        type: action
        method: POST
        path: /echo
        output: { type: object, properties: { ok: { type: boolean } }, additionalProperties: false }
        pagination:
          kind: cursor
          cursorParam: cursor
          nextCursor: \${response.next_cursor}
          items: \${response.results}
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'unsafe_pagination_action',
        path: 'connectors.unsafe_pagination.operations.create.pagination',
      }),
    );
  });

  it('rejects invalid pagination values during schema validation', () => {
    const result = compileConnectors(`
connectors:
  - id: invalid_pagination
    version: 1.0.0
    http:
      baseUrl: ${base}
    operations:
      read:
        type: read
        method: GET
        path: /x
        output: { type: object, properties: { ok: { type: boolean } }, additionalProperties: false }
        pagination:
          kind: cursor
          cursorParam: cursor
          nextCursor: \${response.next_cursor}
          items: \${response.results}
          maxPages: 26
`);
    expect(result.ok).toBe(false);
  });

  it('rejects OAuth2 token URLs outside the connector allowed origins', () => {
    const result = compileConnectors(`
connectors:
  - id: oauth_api
    version: 1.0.0
    http:
      baseUrl: ${base}
      allowedOrigins:
        - ${base}
      auth:
        kind: clientCredentials
        tokenUrl: https://auth.example.com/token
        clientId: client-a
        clientSecret: API_CLIENT_SECRET
    operations:
      op:
        type: read
        method: GET
        path: /x
        output: { type: object, properties: { ok: { type: boolean } }, additionalProperties: false }
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'disallowed_token_origin',
        path: 'connectors.oauth_api.http.auth.tokenUrl',
      }),
    );
  });

  it('emits delegated OAuth auth bindings without requiring a managed secret', () => {
    const result = compileConnectors(`
connectors:
  - id: delegated_api
    version: 1.0.0
    http:
      baseUrl: ${base}
      auth:
        kind: delegatedOAuth
        provider: firebase
    operations:
      op:
        type: read
        method: GET
        path: /x
        output: { type: object, properties: { ok: { type: boolean } }, additionalProperties: false }
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.secretBindings).toEqual([
      {
        connectorId: 'delegated_api',
        connectorVersion: '1.0.0',
        authKind: 'delegatedOAuth',
        delegated: { provider: 'firebase' },
      },
    ]);
  });

  it('emits delegated session-cookie auth bindings without requiring a managed secret', () => {
    const result = compileConnectors(`
connectors:
  - id: session_api
    version: 1.0.0
    http:
      baseUrl: ${base}
      allowedOrigins:
        - ${base}
      auth:
        kind: delegatedSessionCookie
        provider: firebase
        sessionUrl: ${base}/api/auth/session
        tokenField: idToken
    operations:
      op:
        type: read
        method: GET
        path: /x
        output: { type: object, properties: { ok: { type: boolean } }, additionalProperties: false }
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.secretBindings).toEqual([
      {
        connectorId: 'session_api',
        connectorVersion: '1.0.0',
        authKind: 'delegatedSessionCookie',
        delegated: {
          provider: 'firebase',
          sessionUrl: `${base}/api/auth/session`,
          tokenField: 'idToken',
        },
      },
    ]);
  });

  it('rejects delegated session-cookie auth when the session URL origin is not allowlisted', () => {
    const result = compileConnectors(`
connectors:
  - id: session_api
    version: 1.0.0
    http:
      baseUrl: ${base}
      allowedOrigins:
        - ${base}
      auth:
        kind: delegatedSessionCookie
        provider: firebase
        sessionUrl: https://evil.example/api/auth/session
    operations:
      op:
        type: read
        method: GET
        path: /x
        output: { type: object, properties: { ok: { type: boolean } }, additionalProperties: false }
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'disallowed_session_origin',
        path: 'connectors.session_api.http.auth.sessionUrl',
      }),
    );
  });

  it('emits catalog signatures that match what the connector reports', () => {
    const result = compileConnectors(postsCatalog());
    if (!result.ok) throw new Error('expected ok');
    const cat = result.catalog[0] as CatalogConnector;
    const sig = cat.operations.get_post;
    const connectorSig = result.connectors[0]?.signature('get_post');
    if (!sig || !connectorSig) throw new Error('expected a signature');
    expect(connectorSig).toEqual(sig);
    // identical signatures hash identically -> the manifest signature-drift check will pass
    expect(computeSignatureHash('get_post', connectorSig)).toBe(
      computeSignatureHash('get_post', sig),
    );
  });

  it('compiles a POST connector with a request body and an args-aware response map', async () => {
    const result = compileConnectors(`
connectors:
  - id: echo
    version: 1.0.0
    http:
      baseUrl: ${base}
      allowedOrigins:
        - ${base}
    operations:
      send:
        type: action
        method: POST
        path: /echo
        input: { type: object, properties: { label: { type: string } }, required: [label], additionalProperties: false }
        output: { type: object, properties: { sent: { type: string }, got: { type: string } }, additionalProperties: false }
        request:
          label: \${args.label}
        response:
          sent: \${args.label}
          got: \${response.echoed.label}
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = await result.connectors[0]?.invoke({
      operation: 'send',
      args: { label: 'hi' },
      credential,
    });
    expect(last.method).toBe('POST');
    expect(last.body).toEqual({ label: 'hi' });
    expect(out).toEqual({ sent: 'hi', got: 'hi' });
  });

  it('spreads a dynamic request object for PATCH operations', async () => {
    const result = compileConnectors(`
connectors:
  - id: fields
    version: 1.0.0
    http:
      baseUrl: ${base}
      allowedOrigins:
        - ${base}
    operations:
      update:
        type: action
        method: PATCH
        path: /fields
        input: { type: object, properties: { fields: { type: object } }, required: [fields], additionalProperties: false }
        output: { type: object, properties: { title: { type: string }, status: { type: string } }, additionalProperties: false }
        request:
          \${spread}: \${args.fields}
        response:
          title: \${response.Title}
          status: \${response.Status}
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = await result.connectors[0]?.invoke({
      operation: 'update',
      args: { fields: { Title: 'Launch', Status: 'Open' } },
      credential,
    });
    expect(last.method).toBe('PATCH');
    expect(last.body).toEqual({ Title: 'Launch', Status: 'Open' });
    expect(out).toEqual({ title: 'Launch', status: 'Open' });
  });

  it('rejects an expression with an out-of-scope root', () => {
    const result = compileConnectors(`
connectors:
  - id: bad
    version: 1.0.0
    http:
      baseUrl: ${base}
    operations:
      op:
        type: read
        method: GET
        path: /x
        output: { type: object, properties: { v: { type: string } }, additionalProperties: false }
        response:
          v: \${input.v}
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => /unknown expression root/.test(e.message))).toBe(true);
  });

  it('rejects a malformed connector document', () => {
    const result = compileConnectors('connectors: []');
    expect(result.ok).toBe(false);
  });
});

describe('declarative connector through the runtime (end to end)', () => {
  const MANIFEST = `
manifestVersion: "1"
server:
  name: posts
  version: 1.0.0
  title: Posts
connectors:
  posts:
    id: jsonplaceholder
    version: 1.0.0
tools:
  - name: get_post
    description: Fetch a post by id.
    inputSchema:
      type: object
      properties:
        post_id:
          type: string
      required:
        - post_id
      additionalProperties: false
    fulfilment:
      use: posts.get_post
      args:
        post_id: \${input.post_id}
`;

  it('compiles the manifest against the declarative catalog and fetches live (local) data', async () => {
    const compiled = compileConnectors(postsCatalog());
    if (!compiled.ok) throw new Error('connector compile failed');

    const manifest = compile(MANIFEST, { catalog: new InMemoryCatalog(compiled.catalog) });
    if (!manifest.ok)
      throw new Error(`manifest compile failed: ${JSON.stringify(manifest.errors)}`);

    const deps: ExecuteDeps = {
      connectors: new InMemoryConnectorRegistry(compiled.connectors),
      broker: new StaticServiceBroker(credential),
    };
    const result = await executeTool(manifest.artifact, 'get_post', { post_id: '9' }, deps);
    expect(result).toEqual({ ok: true, output: { title: 't9', body: 'b9' } });
  });

  it('executes a tool backed by a paginated declarative connector', async () => {
    cursorAttempts = 0;
    const compiled = compileConnectors(`
connectors:
  - id: paginated_api
    version: 1.0.0
    http:
      baseUrl: ${base}
      allowedOrigins:
        - ${base}
    operations:
      list:
        type: read
        method: GET
        path: /cursor-items
        output: { type: object, properties: { items: { type: array }, pageCount: { type: number }, partial: { type: boolean } }, additionalProperties: false }
        pagination:
          kind: cursor
          cursorParam: cursor
          nextCursor: \${response.next_cursor}
          items: \${response.results}
          maxPages: 5
          maxItems: 10
        response:
          items: \${response.items}
          pageCount: \${response.pageCount}
          partial: \${response.partial}
`);
    if (!compiled.ok)
      throw new Error(`connector compile failed: ${JSON.stringify(compiled.errors)}`);

    const manifest = compile(
      `
manifestVersion: "1"
server:
  name: paginated
  version: 1.0.0
  title: Paginated
connectors:
  api:
    id: paginated_api
    version: 1.0.0
tools:
  - name: list_items
    description: Fetch items.
    inputSchema:
      type: object
      properties: {}
      additionalProperties: false
    outputSchema:
      type: object
      properties:
        items:
          type: array
        pageCount:
          type: number
        partial:
          type: boolean
    fulfilment:
      use: api.list
      args: {}
`,
      { catalog: new InMemoryCatalog(compiled.catalog) },
    );
    if (!manifest.ok)
      throw new Error(`manifest compile failed: ${JSON.stringify(manifest.errors)}`);

    const deps: ExecuteDeps = {
      connectors: new InMemoryConnectorRegistry(compiled.connectors),
      broker: new StaticServiceBroker(credential),
    };
    const result = await executeTool(manifest.artifact, 'list_items', {}, deps);
    expect(result).toEqual({
      ok: true,
      output: {
        items: [{ id: 'a' }, { id: 'b' }],
        pageCount: 2,
        partial: false,
      },
    });
    expect(cursorAttempts).toBe(2);
  });

  it('executes a tool backed by fake paginated connector data', async () => {
    const compiled = compileConnectors(
      `
connectors:
  - id: fake_paginated_api
    version: 1.0.0
    http:
      baseUrl: https://api.example.test
    operations:
      list:
        type: read
        method: GET
        path: /cursor-items
        output: { type: object, properties: { items: { type: array }, pageCount: { type: number }, partial: { type: boolean } }, additionalProperties: false }
        pagination:
          kind: cursor
          cursorParam: cursor
          nextCursor: \${response.next_cursor}
          items: \${response.results}
          maxPages: 5
          maxItems: 10
        fake:
          pages:
            - results:
                - id: fake-a
              next_cursor: next
            - results:
                - id: fake-b
              next_cursor: null
        response:
          items: \${response.items}
          pageCount: \${response.pageCount}
          partial: \${response.partial}
`,
      { mode: 'fake' },
    );
    if (!compiled.ok)
      throw new Error(`connector compile failed: ${JSON.stringify(compiled.errors)}`);

    const manifest = compile(
      `
manifestVersion: "1"
server:
  name: fake_paginated
  version: 1.0.0
  title: Fake Paginated
connectors:
  api:
    id: fake_paginated_api
    version: 1.0.0
tools:
  - name: list_items
    description: Fetch items.
    inputSchema:
      type: object
      properties: {}
      additionalProperties: false
    outputSchema:
      type: object
      properties:
        items:
          type: array
        pageCount:
          type: number
        partial:
          type: boolean
    fulfilment:
      use: api.list
      args: {}
`,
      { catalog: new InMemoryCatalog(compiled.catalog) },
    );
    if (!manifest.ok)
      throw new Error(`manifest compile failed: ${JSON.stringify(manifest.errors)}`);

    const deps: ExecuteDeps = {
      connectors: new InMemoryConnectorRegistry(compiled.connectors),
      broker: new StaticServiceBroker(credential),
    };
    const result = await executeTool(manifest.artifact, 'list_items', {}, deps);
    expect(result).toEqual({
      ok: true,
      output: {
        items: [{ id: 'fake-a' }, { id: 'fake-b' }],
        pageCount: 2,
        partial: false,
      },
    });
  });
});

describe('http operation path expressions', () => {
  it('rejects ${...} expressions left in an http operation path', () => {
    const result = compileConnectors(`
connectors:
  - id: projects
    version: 1.0.0
    http:
      baseUrl: https://api.example.test
    operations:
      list_apps:
        type: read
        method: GET
        path: /api/organizations/\${args.org_id}/apps
        output: { type: object, properties: { result: {} }, additionalProperties: false }
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'unsupported_path_expression',
        path: 'connectors.projects.operations.list_apps.path',
      }),
    );
  });

  it('accepts {name} placeholders in an http operation path', () => {
    const result = compileConnectors(`
connectors:
  - id: projects
    version: 1.0.0
    http:
      baseUrl: https://api.example.test
    operations:
      get_app:
        type: read
        method: GET
        path: /api/organizations/{org_id}/apps/{app_id}
        output: { type: object, properties: { result: {} }, additionalProperties: false }
`);
    expect(result.ok).toBe(true);
  });
});
