import { compile } from '@noodle-borg/compiler';
import { compileConnectors } from '@noodle-borg/connector-defs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import {
  mergeOpenApiIntoDraft,
  parseOpenApiToIr,
  renderOpenApiConnectorsYaml,
  renderOpenApiManifestYaml,
} from '../src/index.js';

const SPEC_31 = `
openapi: 3.1.0
info: { title: Demo API, version: 1.0.0 }
servers:
  - url: https://api.example.com
paths:
  /tickets/{id}:
    parameters:
      - { name: id, in: path, required: true, schema: { type: string } }
    get:
      operationId: getTicket
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
        - { name: verbose, in: query, schema: { type: string } }
        - { name: state, in: query, schema: { type: string, enum: [open, closed] } }
        - { name: limit, in: query, schema: { type: integer, format: int32 } }
      responses:
        "200": { description: ok }
    post:
      operationId: create-ticket
      requestBody:
        required: true
        content:
          application/json:
            schema: { type: object }
      responses:
        "200": { description: ok }
`;

const SPEC_30 = `
openapi: 3.0.3
info: { title: Pets, version: 1.0.0 }
servers:
  - url: https://pets.example.com
paths:
  /pets:
    get:
      parameters:
        - { name: limit, in: query, schema: { type: integer, format: int32 } }
        - { name: cursor, in: query, schema: { type: string, nullable: true } }
      responses:
        "200": { description: ok }
`;

const SPEC_API_KEY = `
openapi: 3.1.0
info: { title: Jokes, version: 1.0.0 }
servers:
  - url: https://api.api-ninjas.com
security:
  - ApiKeyAuth: []
components:
  securitySchemes:
    ApiKeyAuth:
      type: apiKey
      in: header
      name: X-Api-Key
paths:
  /v1/jokes:
    get:
      operationId: getJoke
      responses:
        "200": { description: ok }
`;

const SPEC_BEARER_AND_OAUTH = `
openapi: 3.0.3
info: { title: Mixed, version: 1.0.0 }
servers:
  - url: https://mixed.example.com
security:
  - OAuth: []
  - BearerAuth: []
components:
  securitySchemes:
    BearerAuth:
      type: http
      scheme: bearer
    OAuth:
      type: oauth2
      flows:
        clientCredentials:
          tokenUrl: https://mixed.example.com/token
          scopes: {}
paths:
  /things:
    get:
      operationId: listThings
      responses:
        "200": { description: ok }
`;

describe('OpenAPI security scheme import', () => {
  it('maps an apiKey header scheme to a connector auth block with a named secret', () => {
    const ir = parseOpenApiToIr(SPEC_API_KEY, { name: 'jokes' });
    expect(ir.auth).toEqual({ kind: 'apiKey', header: 'X-Api-Key', secret: 'API_KEY_AUTH' });
    expect(ir.secretRefs).toEqual(['API_KEY_AUTH']);

    const connectors = renderOpenApiConnectorsYaml(ir);
    expect(connectors).toContain('kind: apiKey');
    expect(connectors).toContain('header: X-Api-Key');
    expect(connectors).toContain('secret: API_KEY_AUTH');
    const compiled = compileConnectors(connectors);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.secretBindings).toEqual([
      expect.objectContaining({ secretRef: 'API_KEY_AUTH' }),
    ]);
  });

  it('falls back to a mappable bearer scheme and warns about unmapped schemes', () => {
    const ir = parseOpenApiToIr(SPEC_BEARER_AND_OAUTH, { name: 'mixed' });
    expect(ir.auth).toEqual({ kind: 'bearer', secret: 'BEARER_AUTH' });
    expect(ir.warnings.join('\n')).toContain('OAuth');

    const merged = mergeOpenApiIntoDraft({
      ir,
      manifest: 'manifestVersion: "1"\nserver:\n  name: mixed\n  version: 1.0.0\n  title: Mixed\n',
    });
    expect(merged.secretRefs).toEqual(['BEARER_AUTH']);
    expect(merged.connectors).toContain('secret: BEARER_AUTH');
  });

  it('leaves auth absent and secretRefs empty when the spec declares no security', () => {
    const ir = parseOpenApiToIr(SPEC_30, { name: 'pets' });
    expect(ir.auth).toBeUndefined();
    expect(ir.secretRefs).toEqual([]);
    const merged = mergeOpenApiIntoDraft({
      ir,
      manifest: 'manifestVersion: "1"\nserver:\n  name: pets\n  version: 1.0.0\n  title: Pets\n',
    });
    expect(merged.secretRefs).toEqual([]);
  });
});

describe('OpenAPI import IR', () => {
  it('parses OpenAPI 3.1 into a deterministic connector/tool IR with warnings', () => {
    const ir = parseOpenApiToIr(SPEC_31, { name: 'demo-api' });

    expect(ir).toEqual({
      connectorId: 'demo_api',
      serverTitle: 'Demo Api',
      baseUrl: 'https://api.example.com',
      operations: [
        {
          name: 'getTicket',
          safeName: 'get_ticket',
          method: 'get',
          operationType: 'read',
          path: '/tickets/{id}',
          connectorPath: '/tickets/{id}',
          description: 'Call GET /tickets/{id}.',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'verbose', in: 'query', required: false, schema: { type: 'string' } },
            {
              name: 'state',
              in: 'query',
              required: false,
              schema: { type: 'string', enum: ['open', 'closed'] },
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', format: 'int32' },
            },
          ],
          query: ['verbose', 'state', 'limit'],
        },
        {
          name: 'create_ticket',
          safeName: 'create_ticket',
          method: 'post',
          operationType: 'action',
          path: '/tickets/{id}',
          connectorPath: '/tickets/{id}',
          description: 'Call POST /tickets/{id}.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            schema: { kind: 'object', properties: [], additionalProperties: true },
          },
          query: [],
        },
      ],
      secretRefs: [],
      warnings: [],
    });
  });

  it('parses OpenAPI 3.0 and accepts a baseUrl override', () => {
    const ir = parseOpenApiToIr(SPEC_30, {
      name: 'pets-api',
      baseUrl: 'https://override.example.com',
    });

    expect(ir.baseUrl).toBe('https://override.example.com');
    expect(ir.operations).toEqual([
      expect.objectContaining({
        name: 'get__pets',
        safeName: 'get_pets',
        method: 'get',
        operationType: 'read',
        query: ['limit', 'cursor'],
        parameters: [
          {
            name: 'limit',
            in: 'query',
            required: false,
            schema: { type: 'integer', format: 'int32' },
          },
          // OpenAPI 3.0 `nullable: true` is preserved as a JSON Schema nullable type union.
          { name: 'cursor', in: 'query', required: false, schema: { type: ['string', 'null'] } },
        ],
      }),
    ]);
  });
});

describe('OpenAPI YAML renderer', () => {
  it('renders connector and manifest YAML that compile together', () => {
    const ir = parseOpenApiToIr(SPEC_31, { name: 'demo-api' });
    const connectors = renderOpenApiConnectorsYaml(ir);
    const manifest = renderOpenApiManifestYaml(ir);

    expect(connectors).toContain('connectors:');
    expect(connectors).toContain('baseUrl: https://api.example.com');
    expect(manifest).toContain('manifestVersion: "1"');
    expect(manifest).toContain('use: api.get_ticket');
    expect(manifest).toContain('use: api.create_ticket');

    const compiledConnectors = compileConnectors(connectors);
    expect(compiledConnectors.ok).toBe(true);
    if (!compiledConnectors.ok) return;
    const compiledManifest = compile(manifest, {
      catalog: {
        get: (id, version) =>
          compiledConnectors.catalog.find(
            (connector) => connector.id === id && connector.version === version,
          ),
      },
    });
    expect(compiledManifest.ok).toBe(true);
  });

  it('emits lossless JSON Schema operation signatures on the connector and the tool', () => {
    const ir = parseOpenApiToIr(SPEC_31, { name: 'demo-api' });
    const connectorsDoc = YAML.parse(renderOpenApiConnectorsYaml(ir)) as {
      connectors: Array<{ operations: Record<string, Record<string, unknown>> }>;
    };
    const getTicket = connectorsDoc.connectors[0]?.operations.get_ticket;
    expect(getTicket?.input).toEqual({
      type: 'object',
      properties: {
        id: { type: 'string' },
        verbose: { type: 'string' },
        state: { type: 'string', enum: ['open', 'closed'] },
        limit: { type: 'integer', format: 'int32' },
      },
      required: ['id'],
      additionalProperties: false,
    });
    // No typed 2xx JSON response: the wrapped value subtree stays open ({}).
    expect(getTicket?.output).toEqual({
      type: 'object',
      properties: { value: {} },
      required: ['value'],
      additionalProperties: false,
    });
    expect(getTicket?.response).toEqual({ value: '${response}' });

    // The write operation retains both its inherited path input and typed body.
    const createTicket = connectorsDoc.connectors[0]?.operations.create_ticket;
    expect(createTicket?.input).toEqual({
      type: 'object',
      properties: { id: { type: 'string' }, body: { type: 'object', additionalProperties: true } },
      required: ['id', 'body'],
      additionalProperties: false,
    });

    // The tool inputSchema carries the same lossless parameter schemas (integer stays integer).
    const manifestDoc = YAML.parse(renderOpenApiManifestYaml(ir)) as {
      tools: Array<{ name: string; inputSchema: Record<string, unknown> }>;
    };
    const tool = manifestDoc.tools.find((entry) => entry.name === 'get_ticket');
    expect(tool?.inputSchema).toEqual({
      type: 'object',
      properties: {
        id: { type: 'string' },
        verbose: { type: 'string' },
        state: { type: 'string', enum: ['open', 'closed'] },
        limit: { type: 'integer', format: 'int32' },
      },
      required: ['id'],
      additionalProperties: false,
    });
  });

  it('maps the complete decoded JSON response body into the generated value output', async () => {
    const ir = parseOpenApiToIr(SPEC_31, { name: 'demo-api' });
    const rendered = YAML.parse(renderOpenApiConnectorsYaml(ir)) as {
      connectors: Array<{
        operations: Record<string, { fake?: { response: unknown } }>;
      }>;
    };
    const responseBody = { id: 'ticket-5', state: 'open' };
    const operation = rendered.connectors[0]?.operations.get_ticket;
    if (operation === undefined) throw new Error('expected imported get_ticket operation');
    operation.fake = { response: responseBody };

    const compiled = compileConnectors(YAML.stringify(rendered), { mode: 'fake' });
    expect(compiled.ok, compiled.ok ? '' : JSON.stringify(compiled.errors)).toBe(true);
    if (!compiled.ok) return;

    await expect(
      compiled.connectors[0]?.invoke({
        operation: 'get_ticket',
        args: { id: '5' },
        credential: { token: 'unused' },
      }),
    ).resolves.toEqual({ value: responseBody });
  });

  it('renders an OpenAPI 3.0 nullable parameter as a JSON Schema type union', () => {
    const ir = parseOpenApiToIr(SPEC_30, { name: 'pets' });
    const connectorsDoc = YAML.parse(renderOpenApiConnectorsYaml(ir)) as {
      connectors: Array<{ operations: Record<string, { input: Record<string, unknown> }> }>;
    };
    const input = connectorsDoc.connectors[0]?.operations.get_pets?.input as {
      properties: Record<string, unknown>;
    };
    expect(input.properties.cursor).toEqual({ type: ['string', 'null'] });
    const compiled = compileConnectors(renderOpenApiConnectorsYaml(ir));
    expect(compiled.ok).toBe(true);
  });

  it('merges rendered connector and tool sections into an existing draft without overwriting content', () => {
    const ir = parseOpenApiToIr(SPEC_31, { name: 'demo-api' });
    const result = mergeOpenApiIntoDraft({
      ir,
      manifest: `
manifestVersion: "1"
server:
  name: existing
  version: 1.0.0
  title: Existing
tools:
  - name: get_ticket
    description: Existing local tool.
    inputSchema:
      type: object
      additionalProperties: false
    fulfilment:
      steps:
        - id: ok
          map: { value: true }
      output:
        value: \${steps.ok.value}
`,
      connectors: `
connectors:
  - id: demo_api
    version: 1.0.0
    kind: custom
    http:
      baseUrl: https://old.example.com
      allowedOrigins: [https://old.example.com]
    operations: {}
`,
    });

    expect(result.addedTools).toEqual(['get_ticket_2', 'create_ticket']);
    expect(result.addedOperations).toEqual(['get_ticket', 'create_ticket']);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        'connector id "demo_api" already exists; imported as "demo_api_2"',
        'tool "get_ticket" already exists; imported as "get_ticket_2"',
      ]),
    );
    expect(result.manifest).toContain('name: get_ticket');
    expect(result.manifest).toContain('name: get_ticket_2');
    expect(result.manifest).toContain('use: api.get_ticket');
    expect(result.connectors).toContain('id: demo_api');
    expect(result.connectors).toContain('id: demo_api_2');

    const compiledConnectors = compileConnectors(result.connectors);
    expect(compiledConnectors.ok).toBe(true);
    if (!compiledConnectors.ok) return;
    const compiledManifest = compile(result.manifest, {
      catalog: {
        get: (id, version) =>
          compiledConnectors.catalog.find(
            (connector) => connector.id === id && connector.version === version,
          ),
      },
    });
    expect(compiledManifest.ok).toBe(true);
  });
});
