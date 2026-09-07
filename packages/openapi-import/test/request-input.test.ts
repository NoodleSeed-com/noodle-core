import { compileConnectors } from '@noodle-borg/connector-defs';
import { describe, expect, it } from 'vitest';
import {
  MAX_OPENAPI_SOURCE_BYTES,
  parseOpenApiToIr,
  renderOpenApiConnectorsYaml,
} from '../src/index.js';

function spec(operation: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    openapi: '3.1.0',
    servers: [{ url: 'https://api.example.com/v1' }],
    paths: { '/tickets': { post: { operationId: 'createTicket', responses: {}, ...operation } } },
    ...extra,
  });
}

describe('imported request fidelity', () => {
  it('bounds documents and rejects malformed input without echoing source values', () => {
    expect(() =>
      parseOpenApiToIr(' '.repeat(MAX_OPENAPI_SOURCE_BYTES + 1), { name: 'tickets' }),
    ).toThrow(/size|MiB/);
    for (const source of [
      'null',
      'paths: [secret-value',
      spec({}, { paths: { '/tickets': null } }),
    ]) {
      try {
        parseOpenApiToIr(source, { name: 'tickets' });
        expect.fail('expected a repairable parse failure');
      } catch (error) {
        expect(String(error)).toMatch(/import openapi:/);
        expect(String(error)).not.toContain('secret-value');
      }
    }
  });
  it('keeps one typed JSON body through the IR and connector request mapping', () => {
    const ir = parseOpenApiToIr(
      spec({
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['title', 'labels'],
                properties: {
                  title: { type: 'string' },
                  labels: { type: 'array', items: { type: 'string' } },
                  estimate: { type: 'integer' },
                  enabled: { type: ['boolean', 'null'] },
                },
              },
            },
          },
        },
      }),
      { name: 'tickets' },
    );
    expect(ir.operations[0]).toMatchObject({
      requestBody: { required: true, schema: { kind: 'object' } },
    });
    expect(ir.warnings).not.toContainEqual(expect.stringContaining('opaque'));
    const compiled = compileConnectors(renderOpenApiConnectorsYaml(ir));
    expect(compiled.ok, JSON.stringify(compiled)).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.catalog[0]?.operations.create_ticket?.input).toMatchObject({
      type: 'object',
      required: ['body'],
      properties: {
        body: {
          type: 'object',
          required: ['title', 'labels'],
          properties: {
            title: { type: 'string' },
            labels: { type: 'array', items: { type: 'string' } },
            estimate: { type: 'integer' },
            enabled: { type: ['boolean', 'null'] },
          },
        },
      },
    });
    expect(renderOpenApiConnectorsYaml(ir)).toContain('request: ${args.body}');
  });

  it('inherits path parameters, preserves query wire names, and rewrites path placeholders consistently', () => {
    const ir = parseOpenApiToIr(
      spec(
        {},
        {
          paths: {
            '/tickets/{ticket-id}': {
              parameters: [
                { name: 'ticket-id', in: 'path', required: true, schema: { type: 'string' } },
              ],
              get: {
                operationId: 'getTicket',
                responses: {},
                parameters: [{ name: 'includeNotes', in: 'query', schema: { type: 'boolean' } }],
              },
            },
          },
        },
      ),
      { name: 'tickets' },
    );
    expect(ir.operations[0]).toMatchObject({
      connectorPath: '/tickets/{ticket_id}',
      parameters: [
        { name: 'ticket_id', in: 'path' },
        { name: 'includeNotes', in: 'query' },
      ],
      query: ['includeNotes'],
    });
  });

  it('rejects query names the locked expression language cannot address instead of renaming wire keys', () => {
    expect(() =>
      parseOpenApiToIr(
        spec({ parameters: [{ name: 'include-notes', in: 'query', schema: { type: 'boolean' } }] }),
        { name: 'tickets' },
      ),
    ).toThrow(/query.*name|parameter.*name/i);
  });

  it.each([
    { content: { 'multipart/form-data': { schema: { type: 'object' } } } },
    {
      content: {
        'application/json': { schema: { $ref: 'https://private.invalid/schema?token=secret' } },
      },
    },
    {
      content: { 'application/json': { schema: { type: 'object', oneOf: [{ type: 'string' }] } } },
    },
  ])('rejects an unsupported body without silently emitting a body-less operation', (requestBody) => {
    expect(() => parseOpenApiToIr(spec({ requestBody }), { name: 'tickets' })).toThrow(
      /request body/i,
    );
  });

  it('rejects an input-name collision instead of dropping a query value or request body', () => {
    expect(() =>
      parseOpenApiToIr(
        spec({
          parameters: [{ name: 'body', in: 'query', schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        }),
        { name: 'tickets' },
      ),
    ).toThrow(/collision|body/);
  });

  it.each([
    {},
    { type: 'array' },
    { type: 'object', properties: { untyped: {} } },
    { type: 'number', enum: ['one'] },
    { type: 'string', enum: ['one'], nullable: true },
    { type: 'string', minLength: 3 },
    { type: 'string', format: 'password' },
    { type: 'object', required: ['undeclared'] },
    { type: 'object', additionalProperties: { type: 'string' } },
    { $ref: '#/components/schemas/Record', nullable: true },
  ])('refuses request constraints that cannot survive generated code: %j', (schema) => {
    expect(() =>
      parseOpenApiToIr(spec({ requestBody: { content: { 'application/json': { schema } } } }), {
        name: 'tickets',
      }),
    ).toThrow(/request body/i);
  });

  it('resolves a bounded internal request-body reference without changing its optionality', () => {
    const ir = parseOpenApiToIr(
      spec(
        {
          requestBody: {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Record' } } },
          },
        },
        {
          components: {
            schemas: {
              Record: {
                type: 'object',
                additionalProperties: false,
                properties: { title: { type: 'string' } },
              },
            },
          },
        },
      ),
      { name: 'tickets' },
    );
    expect(ir.operations[0]?.requestBody).toEqual({
      required: false,
      schema: {
        kind: 'object',
        additionalProperties: false,
        properties: [{ name: 'title', required: false, schema: { kind: 'string' } }],
      },
    });
  });

  it('rejects missing path bindings and normalized-name collisions', () => {
    for (const parameters of [
      [],
      [
        { name: 'ticket-id', in: 'path', schema: { type: 'string' } },
        { name: 'ticket_id', in: 'query', schema: { type: 'string' } },
      ],
    ]) {
      expect(() =>
        parseOpenApiToIr(spec({}, { paths: { '/tickets/{ticket-id}': { get: { parameters } } } }), {
          name: 'tickets',
        }),
      ).toThrow(/placeholder|collision/);
    }
  });
});
