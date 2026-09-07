import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CatalogConnector } from '@noodle-borg/compiler';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileConnectors } from '../src/index.js';

// JSON Schema operation signatures at the catalog parse boundary (ADR 0139): JSON-Schema-authored
// operations parse and execute; retired legacy field maps, non-object I/O, and schema-valued
// additionalProperties are rejected.

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const getPost = /^\/posts\/(\w+)$/.exec(url.pathname);
    if (req.method === 'GET' && getPost) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ title: `t${getPost[1]}`, body: `b${getPost[1]}` }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

const credential = { token: 'svc' };

function jsonSchemaCatalog(): string {
  return `
connectors:
  - id: posts_js
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
            body: { type: string }
          additionalProperties: false
        response:
          title: \${response.title}
          body: \${response.body}
`;
}

describe('JSON Schema operation signatures (ADR 0139)', () => {
  it('parses and executes operations authored with JSON Schema input/output', async () => {
    const result = compileConnectors(jsonSchemaCatalog());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sig = (result.catalog[0] as CatalogConnector).operations.get_post;
    expect(sig?.input).toMatchObject({
      type: 'object',
      properties: { post_id: { type: 'string' } },
      required: ['post_id'],
      additionalProperties: false,
    });
    const out = await result.connectors[0]?.invoke({
      operation: 'get_post',
      args: { post_id: '9' },
      credential,
    });
    expect(out).toEqual({ title: 't9', body: 'b9' });
  });

  it('rejects the retired field-map form with a precise error naming JSON Schema authoring', () => {
    const legacy = compileConnectors(`
connectors:
  - id: posts_js
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
        input:
          post_id: { type: string, required: true }
        output:
          title: { type: string }
          body: { type: string }
        response:
          title: \${response.title}
          body: \${response.body}
`);
    expect(legacy.ok).toBe(false);
    if (legacy.ok) return;
    expect(legacy.errors).toContainEqual(
      expect.objectContaining({
        code: 'invalid_connector',
        message: expect.stringContaining('JSON Schema'),
      }),
    );
  });

  it('rejects a non-object operation input schema', () => {
    const result = compileConnectors(`
connectors:
  - id: bad_io
    version: 1.0.0
    http:
      baseUrl: ${base}
    operations:
      get:
        type: read
        method: GET
        path: /posts/1
        input:
          type: string
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'invalid_connector' }));
  });

  it('rejects a schema-valued top-level additionalProperties', () => {
    const result = compileConnectors(`
connectors:
  - id: bad_ap
    version: 1.0.0
    http:
      baseUrl: ${base}
    operations:
      get:
        type: read
        method: GET
        path: /posts/1
        input:
          type: object
          additionalProperties:
            type: string
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'invalid_connector' }));
  });
});
