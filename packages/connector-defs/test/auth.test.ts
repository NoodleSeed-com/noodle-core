import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { computeSignatureHash } from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import { compileConnectors } from '../src/index.js';

/** A stub backing server that echoes the request's auth headers so tests can assert what was attached. */
function authEchoServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        authorization: req.headers.authorization ?? null,
        apiKey: req.headers['x-api-key'] ?? null,
      }),
    );
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

describe('declarative connector auth — schema + compile', () => {
  it('accepts connector-level bearer auth and emits its secret binding', () => {
    const result = compileConnectors(`
connectors:
  - id: api
    version: 2.0.0
    http:
      baseUrl: https://example.test
      auth: { kind: bearer, secret: api_token }
    operations:
      ping:
        type: read
        method: GET
        path: /ping
        output:
          type: object
          properties:
            ok: { type: string }
          additionalProperties: false
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.secretBindings).toEqual([
      { connectorId: 'api', connectorVersion: '2.0.0', secretRef: 'api_token' },
    ]);
  });

  it('accepts a per-operation apiKey auth override and binds it to that operation', () => {
    const result = compileConnectors(`
connectors:
  - id: api
    version: 1.0.0
    http:
      baseUrl: https://example.test
      auth: { kind: bearer, secret: default_token }
    operations:
      ping:
        type: read
        method: GET
        path: /ping
        output: { type: object, properties: { ok: { type: string } }, additionalProperties: false }
      special:
        type: read
        method: GET
        path: /special
        auth: { kind: apiKey, header: X-API-Key, secret: special_key }
        output: { type: object, properties: { ok: { type: string } }, additionalProperties: false }
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The per-op binding carries the operation name; the connector-level default has no operation.
    expect(result.secretBindings).toContainEqual({
      connectorId: 'api',
      connectorVersion: '1.0.0',
      operation: 'special',
      secretRef: 'special_key',
    });
    expect(result.secretBindings).toContainEqual({
      connectorId: 'api',
      connectorVersion: '1.0.0',
      secretRef: 'default_token',
    });
  });

  it('emits no secret bindings for a public (no-auth) connector', () => {
    const result = compileConnectors(`
connectors:
  - id: api
    version: 1.0.0
    http:
      baseUrl: https://example.test
    operations:
      ping:
        type: read
        method: GET
        path: /ping
        output: { type: object, properties: { ok: { type: string } }, additionalProperties: false }
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.secretBindings).toEqual([]);
  });

  it('accepts Microsoft delegated OAuth metadata and emits a client-secret binding', () => {
    const result = compileConnectors(`
connectors:
  - id: sharepoint_graph
    version: 1.0.0
    http:
      baseUrl: https://graph.microsoft.com/v1.0
      allowedOrigins:
        - https://graph.microsoft.com
        - https://login.microsoftonline.com
      auth:
        kind: delegatedOAuth
        provider: microsoft
        tokenUrl: https://login.microsoftonline.com/tenant/oauth2/v2.0/token
        clientId: app-client-id
        clientSecret: MS_CLIENT_SECRET
        scopes:
          - https://graph.microsoft.com/Sites.Selected
        authMethod: client_secret_post
    operations:
      list_children:
        type: read
        method: GET
        path: /sites/{siteId}/drive/root/children
        input:
          type: object
          properties:
            siteId: { type: string }
          required: [siteId]
          additionalProperties: false
        output:
          type: object
          properties:
            ok: { type: string }
          additionalProperties: false
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.secretBindings).toEqual([
      {
        connectorId: 'sharepoint_graph',
        connectorVersion: '1.0.0',
        secretRef: 'MS_CLIENT_SECRET',
        authKind: 'delegatedOAuth',
        delegated: {
          provider: 'microsoft',
          tokenUrl: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/token',
          clientId: 'app-client-id',
          scopes: ['https://graph.microsoft.com/Sites.Selected'],
          authMethod: 'client_secret_post',
        },
      },
    ]);
  });

  it('collects managed variables from Microsoft delegated OAuth metadata', () => {
    const result = compileConnectors(`
connectors:
  - id: sharepoint_graph
    version: 1.0.0
    http:
      baseUrl: https://graph.microsoft.com/v1.0
      allowedOrigins:
        - https://graph.microsoft.com
        - https://login.microsoftonline.com
      auth:
        kind: delegatedOAuth
        provider: microsoft
        tokenUrl: https://login.microsoftonline.com/\${env.MICROSOFT_TENANT_ID}/oauth2/v2.0/token
        clientId: \${env.MICROSOFT_CLIENT_ID}
        clientSecret: MS_CLIENT_SECRET
    operations:
      list_children:
        type: read
        method: GET
        path: /sites/{siteId}/drive/root/children
        input:
          type: object
          properties:
            siteId: { type: string }
          required: [siteId]
          additionalProperties: false
        output:
          type: object
          properties:
            ok: { type: string }
          additionalProperties: false
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.variableBindings).toEqual(['MICROSOFT_CLIENT_ID', 'MICROSOFT_TENANT_ID']);
    expect(result.secretBindings[0]).toMatchObject({
      delegated: {
        tokenUrl: 'https://login.microsoftonline.com/${env.MICROSOFT_TENANT_ID}/oauth2/v2.0/token',
        clientId: '${env.MICROSOFT_CLIENT_ID}',
      },
    });
  });

  it('rejects Microsoft delegated OAuth token URLs outside the connector allowed origins', () => {
    const result = compileConnectors(`
connectors:
  - id: sharepoint_graph
    version: 1.0.0
    http:
      baseUrl: https://graph.microsoft.com/v1.0
      allowedOrigins:
        - https://graph.microsoft.com
      auth:
        kind: delegatedOAuth
        provider: microsoft
        tokenUrl: https://login.microsoftonline.com/tenant/oauth2/v2.0/token
        clientId: app-client-id
        clientSecret: MS_CLIENT_SECRET
    operations:
      list_children:
        type: read
        method: GET
        path: /sites/{siteId}/drive/root/children
        input:
          type: object
          properties:
            siteId: { type: string }
          required: [siteId]
          additionalProperties: false
        output:
          type: object
          properties:
            ok: { type: string }
          additionalProperties: false
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'disallowed_token_origin',
        path: 'connectors.sharepoint_graph.http.auth.tokenUrl',
      }),
    );
  });

  it('accepts delegated token exchange metadata and emits a client-secret binding', () => {
    const result = compileConnectors(`
connectors:
  - id: acmehr_api
    version: 1.0.0
    http:
      baseUrl: https://app.acmehr.example/api/v1
      allowedOrigins:
        - https://app.acmehr.example
      auth:
        kind: delegatedTokenExchange
        tokenUrl: https://app.acmehr.example/api/assistant/oauth/token
        clientId: deleg-client-id
        clientSecret: ACMEHR_DELEG_CLIENT_SECRET
        scopes:
          - time_off
        audience: acmehr-api
    operations:
      list_time_off:
        type: read
        method: GET
        path: /teams/{team}/time-off
        input:
          type: object
          properties:
            team: { type: string }
          required: [team]
          additionalProperties: false
        output:
          type: object
          properties:
            ok: { type: string }
          additionalProperties: false
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.secretBindings).toEqual([
      {
        connectorId: 'acmehr_api',
        connectorVersion: '1.0.0',
        secretRef: 'ACMEHR_DELEG_CLIENT_SECRET',
        authKind: 'delegatedTokenExchange',
        tokenExchange: {
          tokenUrl: 'https://app.acmehr.example/api/assistant/oauth/token',
          clientId: 'deleg-client-id',
          scopes: ['time_off'],
          audience: 'acmehr-api',
          authMethod: 'client_secret_basic',
        },
      },
    ]);
  });

  it('collects managed variables from delegated token exchange metadata', () => {
    const result = compileConnectors(`
connectors:
  - id: acmehr_api
    version: 1.0.0
    http:
      baseUrl: https://app.acmehr.example/api/v1
      allowedOrigins:
        - https://app.acmehr.example
      auth:
        kind: delegatedTokenExchange
        tokenUrl: https://app.acmehr.example/api/assistant/oauth/token
        clientId: \${env.ACMEHR_DELEG_CLIENT_ID}
        clientSecret: ACMEHR_DELEG_CLIENT_SECRET
    operations:
      list_time_off:
        type: read
        method: GET
        path: /teams/{team}/time-off
        input:
          type: object
          properties:
            team: { type: string }
          required: [team]
          additionalProperties: false
        output:
          type: object
          properties:
            ok: { type: string }
          additionalProperties: false
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.variableBindings).toEqual(['ACMEHR_DELEG_CLIENT_ID']);
    expect(result.secretBindings[0]).toMatchObject({
      tokenExchange: { clientId: '${env.ACMEHR_DELEG_CLIENT_ID}' },
    });
  });

  it('rejects delegated token exchange token URLs outside the connector allowed origins', () => {
    const result = compileConnectors(`
connectors:
  - id: acmehr_api
    version: 1.0.0
    http:
      baseUrl: https://app.acmehr.example/api/v1
      allowedOrigins:
        - https://app.acmehr.example
      auth:
        kind: delegatedTokenExchange
        tokenUrl: https://elsewhere.example.com/oauth/token
        clientId: deleg-client-id
        clientSecret: ACMEHR_DELEG_CLIENT_SECRET
    operations:
      list_time_off:
        type: read
        method: GET
        path: /teams/{team}/time-off
        input:
          type: object
          properties:
            team: { type: string }
          required: [team]
          additionalProperties: false
        output:
          type: object
          properties:
            ok: { type: string }
          additionalProperties: false
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'disallowed_token_origin',
        path: 'connectors.acmehr_api.http.auth.tokenUrl',
      }),
    );
  });

  it('rejects a delegatedOAuth provider that is not a managed provider, naming the generic path', () => {
    const result = compileConnectors(`
connectors:
  - id: acmehr_api
    version: 1.0.0
    http:
      baseUrl: https://app.acmehr.example/api/v1
      allowedOrigins:
        - https://app.acmehr.example
      auth:
        kind: delegatedOAuth
        provider: acmehr
    operations:
      list_time_off:
        type: read
        method: GET
        path: /teams/{team}/time-off
        input:
          type: object
          properties:
            team: { type: string }
          required: [team]
          additionalProperties: false
        output:
          type: object
          properties:
            ok: { type: string }
          additionalProperties: false
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'unsupported_delegated_provider',
        path: 'connectors.acmehr_api.http.auth.provider',
        message: expect.stringContaining('delegatedTokenExchange'),
      }),
    );
  });

  it('rejects an inline secret value (only a named reference is allowed)', () => {
    const inlineValue = compileConnectors(`
connectors:
  - id: api
    version: 1.0.0
    http:
      baseUrl: https://example.test
      auth: { kind: bearer, value: sk-12345 }
    operations:
      ping: { type: read, method: GET, path: /ping, output: { type: object, properties: { ok: { type: string } }, additionalProperties: false } }
`);
    expect(inlineValue.ok).toBe(false);

    const inlineToken = compileConnectors(`
connectors:
  - id: api
    version: 1.0.0
    http:
      baseUrl: https://example.test
      auth: { kind: bearer, secret: t, token: sk-12345 }
    operations:
      ping: { type: read, method: GET, path: /ping, output: { type: object, properties: { ok: { type: string } }, additionalProperties: false } }
`);
    expect(inlineToken.ok).toBe(false);
  });

  it('keeps auth out of the operation signature hash (ADR 0002 parity)', () => {
    const withAuth = compileConnectors(`
connectors:
  - id: api
    version: 1.0.0
    http:
      baseUrl: https://example.test
      auth: { kind: bearer, secret: api_token }
    operations:
      ping:
        type: read
        method: GET
        path: /ping
        input: { type: object, properties: { q: { type: string } }, required: [q], additionalProperties: false }
        output: { type: object, properties: { ok: { type: string } }, additionalProperties: false }
`);
    const noAuth = compileConnectors(`
connectors:
  - id: api
    version: 1.0.0
    http:
      baseUrl: https://example.test
    operations:
      ping:
        type: read
        method: GET
        path: /ping
        input: { type: object, properties: { q: { type: string } }, required: [q], additionalProperties: false }
        output: { type: object, properties: { ok: { type: string } }, additionalProperties: false }
`);
    if (!withAuth.ok || !noAuth.ok) throw new Error('expected both to compile');
    const a = withAuth.catalog[0]?.operations.ping;
    const b = noAuth.catalog[0]?.operations.ping;
    if (!a || !b) throw new Error('expected a ping signature');
    expect(computeSignatureHash('ping', a)).toBe(computeSignatureHash('ping', b));
  });
});

describe('declarative connector auth — runtime header attachment', () => {
  it('attaches a bearer header from the broker credential', async () => {
    const { server, url } = await authEchoServer();
    try {
      const result = compileConnectors(`
connectors:
  - id: api
    version: 1.0.0
    http:
      baseUrl: ${url}
      allowedOrigins: [ ${url} ]
      auth: { kind: bearer, secret: api_token }
    operations:
      ping:
        type: read
        method: GET
        path: /ping
        output:
          type: object
          properties:
            authorization: { type: string }
          additionalProperties: false
        response:
          authorization: \${response.authorization}
`);
      if (!result.ok) throw new Error('expected ok');
      const out = await result.connectors[0]?.invoke({
        operation: 'ping',
        args: {},
        credential: { token: 'secret-abc' },
      });
      expect(out).toEqual({ authorization: 'Bearer secret-abc' });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    }
  });

  it('attaches a per-operation apiKey header overriding the connector default', async () => {
    const { server, url } = await authEchoServer();
    try {
      const result = compileConnectors(`
connectors:
  - id: api
    version: 1.0.0
    http:
      baseUrl: ${url}
      allowedOrigins: [ ${url} ]
      auth: { kind: bearer, secret: default_token }
    operations:
      special:
        type: read
        method: GET
        path: /special
        auth: { kind: apiKey, header: X-API-Key, secret: special_key }
        output:
          type: object
          properties:
            apiKey: { type: string }
            authorization: { type: string }
          additionalProperties: false
        response:
          apiKey: \${response.apiKey}
          authorization: \${response.authorization}
`);
      if (!result.ok) throw new Error('expected ok');
      const out = (await result.connectors[0]?.invoke({
        operation: 'special',
        args: {},
        credential: { token: 'key-xyz' },
      })) as { apiKey: string; authorization: string | null };
      expect(out.apiKey).toBe('key-xyz');
      // The apiKey scheme sets X-API-Key and NOT Authorization (the echo reports it as null).
      expect(out.authorization).toBeNull();
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    }
  });
});

describe('declarative connector auth — schema edge cases', () => {
  const ok = (yaml: string) => compileConnectors(yaml).ok;
  const conn = (authLine: string) => `
connectors:
  - id: api
    version: 1.0.0
    http:
      baseUrl: https://example.test
      auth: ${authLine}
    operations:
      ping: { type: read, method: GET, path: /ping, output: { type: object, properties: { ok: { type: string } }, additionalProperties: false } }
`;

  it('rejects an apiKey auth without a header', () => {
    expect(ok(conn('{ kind: apiKey, secret: k }'))).toBe(false);
  });

  it('rejects an apiKey auth with an empty header', () => {
    expect(ok(conn('{ kind: apiKey, header: "", secret: k }'))).toBe(false);
  });

  it('rejects an unknown auth kind', () => {
    expect(ok(conn('{ kind: oauth2, secret: k }'))).toBe(false);
  });

  it('rejects invalid secret reference names', () => {
    for (const bad of ['api-key', 'api.key', 'api key', '""']) {
      expect(ok(conn(`{ kind: bearer, secret: ${bad} }`))).toBe(false);
    }
  });

  it('accepts valid secret reference names (alnum + underscore)', () => {
    expect(ok(conn('{ kind: bearer, secret: API_token_1 }'))).toBe(true);
  });

  it('does not allow auth on a compute connector (no http block / strict compute op)', () => {
    const result = compileConnectors(`
connectors:
  - id: c
    version: 1.0.0
    operations:
      run:
        type: read
        code: "(i) => i"
        auth: { kind: bearer, secret: k }
`);
    expect(result.ok).toBe(false);
  });

  it('keeps an apiKey auth out of the operation signature hash (parity)', () => {
    const withAuth = compileConnectors(`
connectors:
  - id: api
    version: 1.0.0
    http:
      baseUrl: https://example.test
      auth: { kind: apiKey, header: X-API-Key, secret: k }
    operations:
      ping: { type: read, method: GET, path: /ping, input: { type: object, properties: { q: { type: string } }, required: [q], additionalProperties: false }, output: { type: object, properties: { ok: { type: string } }, additionalProperties: false } }
`);
    const noAuth = compileConnectors(`
connectors:
  - id: api
    version: 1.0.0
    http:
      baseUrl: https://example.test
    operations:
      ping: { type: read, method: GET, path: /ping, input: { type: object, properties: { q: { type: string } }, required: [q], additionalProperties: false }, output: { type: object, properties: { ok: { type: string } }, additionalProperties: false } }
`);
    if (!withAuth.ok || !noAuth.ok) throw new Error('expected both to compile');
    const a = withAuth.catalog[0]?.operations.ping;
    const b = noAuth.catalog[0]?.operations.ping;
    if (!a || !b) throw new Error('expected a ping signature');
    expect(computeSignatureHash('ping', a)).toBe(computeSignatureHash('ping', b));
  });

  it('emits a single connector-level binding for a secret shared across many operations', () => {
    const result = compileConnectors(`
connectors:
  - id: api
    version: 1.0.0
    http:
      baseUrl: https://example.test
      auth: { kind: bearer, secret: api_token }
    operations:
      a: { type: read, method: GET, path: /a, output: { type: object, properties: { ok: { type: string } }, additionalProperties: false } }
      b: { type: read, method: GET, path: /b, output: { type: object, properties: { ok: { type: string } }, additionalProperties: false } }
      c: { type: read, method: GET, path: /c, output: { type: object, properties: { ok: { type: string } }, additionalProperties: false } }
`);
    if (!result.ok) throw new Error('expected ok');
    expect(result.secretBindings).toEqual([
      { connectorId: 'api', connectorVersion: '1.0.0', secretRef: 'api_token' },
    ]);
  });

  it('emits one binding per connector when two connectors each declare their own secret', () => {
    const result = compileConnectors(`
connectors:
  - id: api
    version: 1.0.0
    http:
      baseUrl: https://a.test
      auth: { kind: bearer, secret: token_a }
    operations:
      a: { type: read, method: GET, path: /a, output: { type: object, properties: { ok: { type: string } }, additionalProperties: false } }
  - id: other
    version: 2.0.0
    http:
      baseUrl: https://b.test
      auth: { kind: apiKey, header: X-Key, secret: token_b }
    operations:
      b: { type: read, method: GET, path: /b, output: { type: object, properties: { ok: { type: string } }, additionalProperties: false } }
`);
    if (!result.ok) throw new Error('expected ok');
    expect(result.secretBindings).toEqual([
      { connectorId: 'api', connectorVersion: '1.0.0', secretRef: 'token_a' },
      { connectorId: 'other', connectorVersion: '2.0.0', secretRef: 'token_b' },
    ]);
  });

  it('compiles a custom-profile client-credentials token endpoint with defaulted wire fields', () => {
    const base = 'https://heymate.test';
    const result = compileConnectors(`
connectors:
  - id: heymate_api
    version: 1.0.0
    http:
      baseUrl: ${base}
      allowedOrigins:
        - ${base}
      auth:
        kind: clientCredentials
        profile: custom
        tokenUrl: ${base}/v1/ext/auth/token
        clientId: HM_CLIENT_ID
        clientSecret: HM_CLIENT_SECRET
        custom:
          requestFormat: json
          clientIdField: clientID
          clientSecretField: clientSecret
          tokenResponsePath: accessToken
          expirySource: [jwt, expiresIn, expiresAt]
    operations:
      get_post:
        type: read
        method: GET
        path: /posts/{post_id}
        input:
          type: object
          properties:
            post_id: { type: string }
          required: [post_id]
          additionalProperties: false
        output:
          type: object
          properties:
            title: { type: string }
          additionalProperties: false
        response:
          title: \${response.title}
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.secretBindings).toEqual([
      expect.objectContaining({
        secretRef: 'HM_CLIENT_SECRET',
        authKind: 'clientCredentials',
        clientCredentials: expect.objectContaining({
          profile: 'custom',
          tokenUrl: `${base}/v1/ext/auth/token`,
          clientId: 'HM_CLIENT_ID',
          custom: {
            requestFormat: 'json',
            clientIdField: 'clientID',
            clientSecretField: 'clientSecret',
            tokenResponsePath: 'accessToken',
            expirySource: ['jwt', 'expiresIn', 'expiresAt'],
            fallbackTtlSeconds: 300,
          },
        }),
      }),
    ]);
  });

  it('rejects a custom-profile client-credentials scheme that omits the custom descriptor', () => {
    const base = 'https://heymate.test';
    const result = compileConnectors(`
connectors:
  - id: bad_custom
    version: 1.0.0
    http:
      baseUrl: ${base}
      allowedOrigins:
        - ${base}
      auth:
        kind: clientCredentials
        profile: custom
        tokenUrl: ${base}/token
        clientId: client-a
        clientSecret: API_CLIENT_SECRET
    operations:
      op:
        type: read
        method: GET
        path: /x
        output:
          type: object
          properties:
            ok: { type: boolean }
          additionalProperties: false
`);
    expect(result.ok).toBe(false);
  });
});
