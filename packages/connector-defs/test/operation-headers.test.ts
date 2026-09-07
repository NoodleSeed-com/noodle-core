import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { compileConnectors } from '../src/index.js';

/** A stub backing server that echoes back the request headers it received. */
function echoHeadersServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        authorization: req.headers.authorization ?? null,
        xCustom: req.headers['x-custom'] ?? null,
        xOptional: req.headers['x-optional'] ?? null,
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

describe('declarative connector — per-operation request headers', () => {
  it('attaches runtime metadata headers and omits undefined ones', async () => {
    const { server, url } = await echoHeadersServer();
    try {
      const result = compileConnectors(`
connectors:
  - id: api
    version: 1.0.0
    http:
      baseUrl: ${url}
      allowedOrigins: [ ${url} ]
    operations:
      fetchThing:
        type: read
        method: GET
        path: /thing
        input:
          type: object
          properties:
            custom: { type: string }
            optional: { type: string }
          additionalProperties: false
        output:
          type: object
          properties:
            authorization: { type: string }
            xCustom: { type: string }
            xOptional: { type: string }
          additionalProperties: false
        headers:
          X-Custom: \${args.custom}
          # resolves to undefined when 'optional' isn't supplied -> header omitted
          X-Optional: \${args.optional}
        response:
          authorization: \${response.authorization}
          xCustom: \${response.xCustom}
          xOptional: \${response.xOptional}
`);
      if (!result.ok) throw new Error(`compile failed: ${JSON.stringify(result.errors)}`);
      const out = await result.connectors[0]?.invoke({
        operation: 'fetchThing',
        args: { custom: 'hello' },
        credential: { token: '' },
      });
      expect(out).toEqual({
        authorization: null,
        xCustom: 'hello',
        xOptional: null, // undefined expression => header not sent
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    }
  });

  it('rejects credential-bearing per-operation headers', () => {
    const result = compileConnectors(`
connectors:
  - id: api
    version: 1.0.0
    http:
      baseUrl: https://api.test
      allowedOrigins: [ https://api.test ]
    operations:
      fetchThing:
        type: read
        method: GET
        path: /thing
        input:
          type: object
          properties:
            token: { type: string }
          required: [token]
          additionalProperties: false
        output:
          type: object
          properties:
            ok: { type: string }
          additionalProperties: false
        headers:
          Authorization: Bearer \${args.token}
          Cookie: session=\${args.token}
          X-API-Key: \${args.token}
`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.filter((e) => e.code === 'credential_header_not_allowed')).toHaveLength(
        3,
      );
    }
  });

  it('rejects credential-bearing per-operation headers even when connector auth exists', () => {
    const result = compileConnectors(`
connectors:
  - id: api
    version: 1.0.0
    http:
      baseUrl: https://api.test
      allowedOrigins: [ https://api.test ]
      auth: { kind: bearer, secret: api_token }
    operations:
      fetchThing:
        type: read
        method: GET
        path: /thing
        input:
          type: object
          properties:
            token: { type: string }
          required: [token]
          additionalProperties: false
        output:
          type: object
          properties:
            authorization: { type: string }
          additionalProperties: false
        headers:
          Authorization: Bearer \${args.token}
        response:
          authorization: \${response.authorization}
`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === 'credential_header_not_allowed')).toBe(true);
    }
  });
});
