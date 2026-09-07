import type { OpenApiImportParameter, OpenApiImportParameterSchema } from './types.js';

const FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_FIELDS = new Set([
  'then',
  'equals',
  'at',
  'optional',
  'toExpression',
  'toString',
  '__proto__',
  'constructor',
  'prototype',
]);

export function identifier(value: string): string {
  const out = value.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[A-Za-z_]/.test(out) ? out : `op_${out || 'operation'}`;
}

/** Keep wire query names intact; path placeholder names may be normalized with their arguments. */
export function importOperationParameters(
  path: string,
  inherited: unknown,
  own: unknown,
): { readonly parameters: readonly OpenApiImportParameter[]; readonly connectorPath: string } {
  const selected = new Map<string, Record<string, unknown>>();
  for (const list of [inherited, own]) {
    if (list === undefined) continue;
    if (!Array.isArray(list)) throw new Error('import openapi: parameters must be an array');
    for (const value of list) {
      if (
        !isRecord(value) ||
        typeof value.name !== 'string' ||
        value.name.length === 0 ||
        value.name.length > 128 ||
        /\p{Cc}/u.test(value.name)
      ) {
        throw new Error('import openapi: use inline parameters with bounded, non-control names');
      }
      if (value.in !== 'path' && value.in !== 'query') {
        throw new Error(
          'import openapi: only path/query parameters are supported; map other locations explicitly in TypeScript',
        );
      }
      if (value.style !== undefined && value.style !== (value.in === 'path' ? 'simple' : 'form')) {
        throw new Error(
          'import openapi: unsupported parameter serialization style; map it explicitly in TypeScript',
        );
      }
      if (
        value.allowReserved === true ||
        value.allowEmptyValue === true ||
        value.content !== undefined
      ) {
        throw new Error(
          'import openapi: unsupported parameter wire encoding; map it explicitly in TypeScript',
        );
      }
      selected.set(`${value.in}:${value.name}`, value);
    }
  }
  if (selected.size > 200) throw new Error('import openapi: operation exceeds 200 parameters');
  const names = new Set<string>();
  const pathNames = new Map<string, string>();
  const parameters = [...selected.values()].map((value): OpenApiImportParameter => {
    const rawName = String(value.name);
    let name = value.in === 'path' ? identifier(rawName) : rawName;
    if (value.in === 'path' && RESERVED_FIELDS.has(name)) name = `param_${name}`;
    if (!FIELD.test(name) || RESERVED_FIELDS.has(name)) {
      throw new Error(
        'import openapi: query parameter name cannot be addressed by the authoring expression contract; map this API through an application handler',
      );
    }
    if (names.has(name))
      throw new Error('import openapi: parameter input-name collision; map the inputs explicitly');
    names.add(name);
    if (value.in === 'path') pathNames.set(rawName, name);
    return {
      name,
      in: value.in === 'path' ? 'path' : 'query',
      required: value.in === 'path' || value.required === true,
      schema: parameterJsonSchema(value.schema),
    };
  });
  const placeholders = [...path.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]);
  if (
    placeholders.some((name) => name === undefined || !pathNames.has(name)) ||
    [...pathNames.keys()].some((name) => !placeholders.includes(name))
  ) {
    throw new Error('import openapi: every path placeholder must match a declared path parameter');
  }
  return {
    parameters,
    connectorPath: path.replace(
      /\{([^{}]+)\}/g,
      (_match, name: string) => `{${pathNames.get(name)}}`,
    ),
  };
}

function parameterJsonSchema(schema: unknown): OpenApiImportParameterSchema {
  if (schema === undefined) return { type: 'string' };
  if (!isRecord(schema)) throw new Error('import openapi: parameter schema must be an object');
  if (schema.$ref !== undefined)
    throw new Error(
      'import openapi: inline parameter schemas before import; references are not fetched',
    );
  const allowed = new Set([
    'type',
    'nullable',
    'enum',
    'format',
    'title',
    'description',
    'example',
    'examples',
    'deprecated',
  ]);
  if (Object.keys(schema).some((key) => !allowed.has(key))) {
    throw new Error(
      'import openapi: unsupported parameter schema constraint; author its validated mapping explicitly',
    );
  }
  const types: readonly unknown[] = Array.isArray(schema.type)
    ? schema.type
    : [schema.type ?? 'string'];
  const concrete = types.filter((type) => type !== 'null');
  const base = concrete[0];
  if (
    concrete.length !== 1 ||
    types.length > 2 ||
    typeof base !== 'string' ||
    !['string', 'number', 'integer', 'boolean'].includes(base)
  ) {
    throw new Error(
      'import openapi: unsupported parameter schema; use a scalar or an explicitly authored mapping',
    );
  }
  const enumValues = base === 'string' ? stringEnum(schema.enum) : undefined;
  if (
    schema.enum !== undefined &&
    (enumValues === undefined || types.includes('null') || schema.nullable === true)
  ) {
    throw new Error(
      'import openapi: unsupported parameter enum/nullable combination; author an explicit mapping',
    );
  }
  const format = typeof schema.format === 'string' ? schema.format : undefined;
  if (
    (schema.nullable !== undefined && typeof schema.nullable !== 'boolean') ||
    (schema.format !== undefined && format === undefined)
  ) {
    throw new Error('import openapi: invalid parameter nullable or format declaration');
  }
  return {
    type: schema.nullable === true || types.includes('null') ? [base, 'null'] : base,
    ...(enumValues !== undefined ? { enum: enumValues } : {}),
    ...(format !== undefined ? { format } : {}),
  };
}

function stringEnum(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  if (!value.every((entry): entry is string => typeof entry === 'string')) return undefined;
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
