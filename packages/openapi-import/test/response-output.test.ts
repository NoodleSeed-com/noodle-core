import { compile } from '@noodle-borg/compiler';
import { compileConnectors } from '@noodle-borg/connector-defs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import {
  parseOpenApiToIr,
  renderOpenApiConnectorsYaml,
  renderOpenApiManifestYaml,
  toOutputJsonSchema,
} from '../src/index.js';

/** The connector operation output emitted for `getThing` in a rendered connectors document. */
function connectorOutputOf(connectorsYaml: string): unknown {
  const doc = YAML.parse(connectorsYaml) as {
    connectors: Array<{ operations: Record<string, { output?: unknown }> }>;
  };
  return doc.connectors[0]?.operations.get_thing?.output;
}

function specWith(responsesBlock: string, componentsBlock = ''): string {
  return `
openapi: 3.0.3
info: { title: Typed, version: 1.0.0 }
servers:
  - url: https://typed.example.com
${componentsBlock}
paths:
  /things/{id}:
    get:
      operationId: getThing
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      responses:
${responsesBlock}
`;
}

const RICH_OBJECT_RESPONSES = `
        "200":
          description: ok
          content:
            application/json:
              schema:
                type: object
                required: [id, state]
                properties:
                  id: { type: string }
                  count: { type: integer }
                  tags: { type: array, items: { type: string } }
                  owner:
                    type: object
                    required: [name]
                    properties:
                      name: { type: string }
                  total-count: { type: number }
                  state: { type: string, enum: [open, closed] }
                  deleted_at: { type: string, nullable: true }
`;

describe('OpenAPI response schema import', () => {
  it('imports a rich 200 application/json object schema as a typed output tree', () => {
    const ir = parseOpenApiToIr(specWith(RICH_OBJECT_RESPONSES), { name: 'typed' });
    expect(ir.warnings).toEqual([]);
    expect(ir.operations[0]?.output).toEqual({
      kind: 'object',
      properties: [
        { name: 'id', required: true, schema: { kind: 'string' } },
        { name: 'count', required: false, schema: { kind: 'number' } },
        {
          name: 'tags',
          required: false,
          schema: { kind: 'array', items: { kind: 'string' } },
        },
        {
          name: 'owner',
          required: false,
          schema: {
            kind: 'object',
            properties: [{ name: 'name', required: true, schema: { kind: 'string' } }],
          },
        },
        { name: 'total-count', required: false, schema: { kind: 'number' } },
        {
          name: 'state',
          required: true,
          schema: { kind: 'string', enum: ['open', 'closed'] },
        },
        { name: 'deleted_at', required: false, schema: { kind: 'string', nullable: true } },
      ],
    });
  });

  it('imports a top-level array response schema', () => {
    const ir = parseOpenApiToIr(
      specWith(`
        "200":
          description: ok
          content:
            application/json:
              schema: { type: array, items: { type: string } }
`),
      { name: 'typed' },
    );
    expect(ir.operations[0]?.output).toEqual({ kind: 'array', items: { kind: 'string' } });
  });

  it('prefers the 200 response over other 2xx responses', () => {
    const ir = parseOpenApiToIr(
      specWith(`
        "201":
          description: created
          content:
            application/json:
              schema: { type: array, items: { type: string } }
        "200":
          description: ok
          content:
            application/json:
              schema:
                type: object
                properties: { a: { type: string } }
`),
      { name: 'typed' },
    );
    expect(ir.operations[0]?.output?.kind).toBe('object');
  });

  it('falls back to the lowest 2xx status when there is no 200', () => {
    const ir = parseOpenApiToIr(
      specWith(`
        "202":
          description: accepted
          content:
            application/json:
              schema: { type: array, items: { type: string } }
        "201":
          description: created
          content:
            application/json:
              schema:
                type: object
                properties: { a: { type: string } }
`),
      { name: 'typed' },
    );
    expect(ir.operations[0]?.output?.kind).toBe('object');
  });

  it('accepts the 2XX wildcard status', () => {
    const ir = parseOpenApiToIr(
      specWith(`
        "2XX":
          description: ok
          content:
            application/json:
              schema: { type: boolean }
`),
      { name: 'typed' },
    );
    expect(ir.operations[0]?.output).toEqual({ kind: 'boolean' });
  });

  it('never types from a default response, and warns when default is the only JSON schema', () => {
    const ir = parseOpenApiToIr(
      specWith(`
        default:
          description: any
          content:
            application/json:
              schema: { type: object, properties: { a: { type: string } } }
`),
      { name: 'typed' },
    );
    expect(ir.operations[0]?.output).toBeUndefined();
    expect(ir.warnings.join('\n')).toContain('default');
    expect(ir.warnings.join('\n')).toContain('getThing');
  });

  it('warns and stays untyped when the 2xx response has content but no JSON media type', () => {
    const ir = parseOpenApiToIr(
      specWith(`
        "200":
          description: ok
          content:
            text/plain:
              schema: { type: string }
`),
      { name: 'typed' },
    );
    expect(ir.operations[0]?.output).toBeUndefined();
    expect(ir.warnings.join('\n')).toContain('application/json');
    expect(ir.warnings.join('\n')).toContain('getThing');
  });

  it('accepts parameterized and +json media types', () => {
    const charset = parseOpenApiToIr(
      specWith(`
        "200":
          description: ok
          content:
            application/json; charset=utf-8:
              schema: { type: string }
`),
      { name: 'typed' },
    );
    expect(charset.operations[0]?.output).toEqual({ kind: 'string' });

    const hal = parseOpenApiToIr(
      specWith(`
        "200":
          description: ok
          content:
            application/hal+json:
              schema: { type: number }
`),
      { name: 'typed' },
    );
    expect(hal.operations[0]?.output).toEqual({ kind: 'number' });
  });

  it('leaves output absent with no new warnings when a 2xx response has no content', () => {
    const ir = parseOpenApiToIr(
      specWith(`
        "200": { description: ok }
`),
      { name: 'typed' },
    );
    expect(ir.operations[0]).not.toHaveProperty('output');
    expect(ir.warnings).toEqual([]);
  });

  it('resolves internal component schema refs, including ref chains', () => {
    const ir = parseOpenApiToIr(
      specWith(
        `
        "200":
          description: ok
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Thing' }
`,
        `
components:
  schemas:
    Thing:
      type: object
      required: [owner]
      properties:
        owner: { $ref: '#/components/schemas/Owner' }
    Owner:
      type: object
      properties:
        name: { type: string }
`,
      ),
      { name: 'typed' },
    );
    expect(ir.operations[0]?.output).toEqual({
      kind: 'object',
      properties: [
        {
          name: 'owner',
          required: true,
          schema: {
            kind: 'object',
            properties: [{ name: 'name', required: false, schema: { kind: 'string' } }],
          },
        },
      ],
    });
  });

  it('breaks ref cycles with a warning and an unknown subtree', () => {
    const ir = parseOpenApiToIr(
      specWith(
        `
        "200":
          description: ok
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Node' }
`,
        `
components:
  schemas:
    Node:
      type: object
      properties:
        next: { $ref: '#/components/schemas/Node' }
`,
      ),
      { name: 'typed' },
    );
    expect(ir.operations[0]?.output).toEqual({
      kind: 'object',
      properties: [{ name: 'next', required: false, schema: { kind: 'unknown' } }],
    });
    expect(ir.warnings.join('\n')).toContain('circular');
  });

  it('rejects external $refs with a structured repairable error and never fetches', () => {
    for (const ref of ['./common.yaml#/components/schemas/X', 'https://example.com/api.yaml#/X']) {
      expect(() =>
        parseOpenApiToIr(
          specWith(`
        "200":
          description: ok
          content:
            application/json:
              schema: { $ref: '${ref}' }
`),
          { name: 'typed' },
        ),
      ).toThrow(/getThing.*external \$ref.*bundle/s);
    }
  });

  it('warns and stays untyped for unsupported top-level compositions like oneOf', () => {
    const ir = parseOpenApiToIr(
      specWith(`
        "200":
          description: ok
          content:
            application/json:
              schema:
                oneOf:
                  - { type: string }
                  - { type: number }
`),
      { name: 'typed' },
    );
    expect(ir.operations[0]?.output).toBeUndefined();
    expect(ir.warnings.join('\n')).toContain('oneOf');
  });

  it('imports nested unsupported compositions as unknown subtrees', () => {
    const ir = parseOpenApiToIr(
      specWith(`
        "200":
          description: ok
          content:
            application/json:
              schema:
                type: object
                properties:
                  poly:
                    anyOf:
                      - { type: string }
                      - { type: number }
`),
      { name: 'typed' },
    );
    expect(ir.operations[0]?.output).toEqual({
      kind: 'object',
      properties: [{ name: 'poly', required: false, schema: { kind: 'unknown' } }],
    });
    expect(ir.warnings.join('\n')).toContain('anyOf');
  });

  it('supports OpenAPI 3.1 nullable type arrays and rejects mixed type arrays as unknown', () => {
    const spec31 = (schema: string) => `
openapi: 3.1.0
info: { title: Typed, version: 1.0.0 }
servers:
  - url: https://typed.example.com
paths:
  /things:
    get:
      operationId: getThing
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema: ${schema}
`;
    const nullable = parseOpenApiToIr(spec31("{ type: ['string', 'null'] }"), { name: 'typed' });
    expect(nullable.operations[0]?.output).toEqual({ kind: 'string', nullable: true });

    const mixed = parseOpenApiToIr(spec31("{ type: ['string', 'number'] }"), { name: 'typed' });
    expect(mixed.operations[0]?.output).toBeUndefined();
    expect(mixed.warnings.join('\n')).toContain('type');
  });

  it('bounds schema depth with a warning instead of recursing without limit', () => {
    let schema = '{ type: string }';
    for (let i = 0; i < 12; i += 1) {
      schema = `{ type: object, properties: { nested: ${schema} } }`;
    }
    const ir = parseOpenApiToIr(
      specWith(`
        "200":
          description: ok
          content:
            application/json:
              schema: ${schema}
`),
      { name: 'typed' },
    );
    expect(ir.operations[0]?.output?.kind).toBe('object');
    expect(ir.warnings.join('\n')).toContain('depth');
  });

  it('is deterministic and idempotent across repeated parses and renders', () => {
    const source = specWith(RICH_OBJECT_RESPONSES);
    const first = parseOpenApiToIr(source, { name: 'typed' });
    const second = parseOpenApiToIr(source, { name: 'typed' });
    expect(second).toEqual(first);
    expect(renderOpenApiConnectorsYaml(second)).toBe(renderOpenApiConnectorsYaml(first));
    expect(renderOpenApiManifestYaml(second)).toBe(renderOpenApiManifestYaml(first));
  });
});

describe('OpenAPI typed output rendering', () => {
  it('emits the lossless response tree as the connector { value } output and a tool outputSchema that compile end-to-end', () => {
    const ir = parseOpenApiToIr(
      specWith(`
        "200":
          description: ok
          content:
            application/json:
              schema: { type: array, items: { type: string } }
`),
      { name: 'typed' },
    );

    const connectors = renderOpenApiConnectorsYaml(ir);
    const output = ir.operations[0]?.output;
    expect(output).toBeDefined();
    if (output === undefined) return;
    expect(connectorOutputOf(connectors)).toEqual({
      type: 'object',
      properties: { value: { type: 'array', items: { type: 'string' } } },
      required: ['value'],
      additionalProperties: false,
    });
    expect(connectorOutputOf(connectors)).toEqual({
      type: 'object',
      properties: { value: toOutputJsonSchema(output) },
      required: ['value'],
      additionalProperties: false,
    });
    const compiledConnectors = compileConnectors(connectors);
    expect(compiledConnectors.ok).toBe(true);
    if (!compiledConnectors.ok) return;

    const manifest = renderOpenApiManifestYaml(ir);
    expect(manifest).toContain('outputSchema:');
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

  it('emits the full rich object tree (enum, nullable, nesting) losslessly into the connector output', () => {
    const ir = parseOpenApiToIr(specWith(RICH_OBJECT_RESPONSES), { name: 'typed' });
    const output = ir.operations[0]?.output;
    expect(output).toBeDefined();
    if (output === undefined) return;
    const emitted = connectorOutputOf(renderOpenApiConnectorsYaml(ir)) as {
      properties: { value: Record<string, unknown> };
    };
    expect(emitted.properties.value).toEqual(toOutputJsonSchema(output));
    expect(emitted.properties.value).toMatchObject({
      type: 'object',
      properties: {
        state: { type: 'string', enum: ['open', 'closed'] },
        deleted_at: { type: ['string', 'null'] },
        owner: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      },
      required: ['id', 'state'],
    });
  });

  it('keeps untyped operations on an open { value } output subtree', () => {
    const ir = parseOpenApiToIr(
      specWith(`
        "200": { description: ok }
`),
      { name: 'typed' },
    );
    const connectors = renderOpenApiConnectorsYaml(ir);
    expect(connectorOutputOf(connectors)).toEqual({
      type: 'object',
      properties: { value: {} },
      required: ['value'],
      additionalProperties: false,
    });
    const manifest = renderOpenApiManifestYaml(ir);
    expect(manifest).not.toContain('outputSchema:');
  });
});
