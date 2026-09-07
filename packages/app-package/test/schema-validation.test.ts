import { describe, expect, it } from 'vitest';
import { validateJsonSchema } from '../src/index.js';

describe('validateJsonSchema', () => {
  const schema = {
    type: 'object',
    properties: {
      profile: {
        type: 'object',
        properties: {
          email: { type: 'string', format: 'email' },
          age: { type: 'integer', minimum: 18 },
        },
        required: ['email', 'age'],
        additionalProperties: false,
      },
      tags: {
        type: 'array',
        minItems: 1,
        items: { type: 'string', minLength: 2 },
      },
      destination: {
        oneOf: [
          { type: 'string', const: 'local' },
          { type: 'string', format: 'uri' },
        ],
      },
    },
    required: ['profile', 'tags', 'destination'],
    additionalProperties: false,
  } as const;

  it('accepts values satisfying the complete JSON Schema contract', () => {
    expect(
      validateJsonSchema(schema, {
        profile: { email: 'user@example.com', age: 21 },
        tags: ['ok'],
        destination: 'local',
      }),
    ).toEqual([]);
  });

  it('reports nested, collection, format, combinator, and unknown-key failures with stable paths', () => {
    const issues = validateJsonSchema(schema, {
      profile: { email: 'not-an-email', age: 17, secret: true },
      tags: ['x'],
      destination: false,
      extra: true,
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'profile.email' }),
        expect.objectContaining({ path: 'profile.age' }),
        expect.objectContaining({ path: 'profile.secret' }),
        expect.objectContaining({ path: 'tags.0' }),
        expect.objectContaining({ path: 'destination' }),
        expect.objectContaining({ path: 'extra' }),
      ]),
    );
  });

  it('fails closed when the schema itself is invalid', () => {
    expect(validateJsonSchema({ type: 'not-a-json-schema-type' }, 'value')).toEqual([
      expect.objectContaining({
        path: '',
        message: expect.stringContaining('invalid JSON Schema'),
      }),
    ]);
  });
});
