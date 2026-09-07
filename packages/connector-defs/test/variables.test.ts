import { describe, expect, it } from 'vitest';
import { compileConnectors } from '../src/index.js';

describe('connector managed variables', () => {
  it('extracts variable bindings from HTTP base URLs and request mappings', async () => {
    const compiled = compileConnectors(`
connectors:
  - id: api
    version: 1.0.0
    http:
      baseUrl: \${env.API_BASE_URL}
      allowedOrigins:
        - https://api.example.com
    operations:
      search:
        type: read
        method: POST
        path: /search
        input:
          type: object
          properties:
            q: { type: string }
          required: [q]
          additionalProperties: false
        request:
          q: \${args.q}
          region: \${env.REGION}
        response:
          ok: true
        output:
          type: object
          properties:
            ok: { type: boolean }
          additionalProperties: false
`);

    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.variableBindings).toEqual(['API_BASE_URL', 'REGION']);
  });

  it('extracts an exact managed origin used as both base URL and egress authority', () => {
    const compiled = compileConnectors(`
connectors:
  - id: shopify
    version: 1.0.0
    http:
      baseUrl: \${env.SHOPIFY_STORE_ORIGIN}
      allowedOrigins:
        - \${env.SHOPIFY_STORE_ORIGIN}
    operations:
      products:
        type: read
        method: GET
        path: /products.json
        output:
          type: object
          additionalProperties: false
`);

    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.variableBindings).toEqual(['SHOPIFY_STORE_ORIGIN']);
  });

  it('rejects secret expression roots in HTTP request mappings', () => {
    const compiled = compileConnectors(`
connectors:
  - id: api
    version: 1.0.0
    http:
      baseUrl: https://api.example.com
    operations:
      search:
        type: read
        method: POST
        path: /search
        request:
          token: \${secret.API_TOKEN}
        output:
          type: object
          properties:
            ok: { type: boolean }
          additionalProperties: false
`);

    expect(compiled.ok).toBe(false);
    if (compiled.ok) return;
    expect(compiled.errors).toEqual([
      expect.objectContaining({
        code: 'expr_unknown_root',
        path: 'connectors.api.operations.search.request.token',
      }),
    ]);
  });
});
