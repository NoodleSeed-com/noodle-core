import {
  type ImportResponseSchemaContext,
  importSchemaTree,
  MAX_RESPONSE_SCHEMA_DEPTH,
  MAX_RESPONSE_SCHEMA_NODES,
  type OpenApiImportSchema,
} from './response-schema.js';

export interface OpenApiImportRequestBody {
  readonly required: boolean;
  readonly schema: OpenApiImportSchema;
}

/** Request inputs must not silently lose constraints or become an untyped body placeholder. */
export function importRequestBody(
  value: unknown,
  ctx: ImportResponseSchemaContext,
): OpenApiImportRequestBody | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || value.$ref !== undefined) {
    throw new Error('import openapi: inline the request body declaration before import');
  }
  if (value.required !== undefined && typeof value.required !== 'boolean') {
    throw new Error('import openapi: request body required must be boolean');
  }
  const content = isRecord(value.content) ? value.content : undefined;
  const media = content?.['application/json'];
  const raw = isRecord(media) ? media.schema : undefined;
  if (raw === undefined)
    throw new Error(
      'import openapi: request body must declare an application/json schema; map other encodings explicitly',
    );
  assertRequestSchema(raw, ctx);
  const warningCount = ctx.warnings.length;
  const schema = importSchemaTree(raw, ctx, true);
  if (schema.kind === 'unknown' || ctx.warnings.length !== warningCount) {
    throw new Error(
      'import openapi: request body schema cannot be imported faithfully; simplify it or author its mapping explicitly',
    );
  }
  return { required: value.required === true, schema };
}

function assertRequestSchema(raw: unknown, ctx: ImportResponseSchemaContext): void {
  const allowed = new Set([
    'type',
    'nullable',
    'properties',
    'required',
    'items',
    'enum',
    'additionalProperties',
    '$ref',
    'title',
    'description',
    'example',
    'examples',
    'deprecated',
  ]);
  let nodes = 0;
  const visit = (value: unknown, depth: number, refs: ReadonlySet<string>): void => {
    nodes++;
    if (
      !isRecord(value) ||
      depth > MAX_RESPONSE_SCHEMA_DEPTH ||
      nodes > MAX_RESPONSE_SCHEMA_NODES
    ) {
      throw new Error(
        'import openapi: request body schema exceeds supported structure/depth/size bounds',
      );
    }
    if (Object.keys(value).some((key) => !allowed.has(key))) {
      throw new Error(
        'import openapi: request body contains an unsupported schema keyword; author its validated mapping explicitly',
      );
    }
    if (value.$ref !== undefined) {
      if (
        Object.keys(value).some(
          (key) =>
            !['$ref', 'title', 'description', 'example', 'examples', 'deprecated'].includes(key),
        )
      ) {
        throw new Error(
          'import openapi: request body reference siblings cannot be imported faithfully; inline the schema',
        );
      }
      if (
        typeof value.$ref !== 'string' ||
        !value.$ref.startsWith('#/components/schemas/') ||
        refs.has(value.$ref)
      ) {
        throw new Error(
          'import openapi: request body has an external, circular or unsupported reference; bundle it into an inline schema',
        );
      }
      const name = value.$ref
        .slice('#/components/schemas/'.length)
        .replace(/~1/g, '/')
        .replace(/~0/g, '~');
      visit(ctx.componentSchemas[name], depth + 1, new Set([...refs, value.$ref]));
      return;
    }
    const types: readonly unknown[] = Array.isArray(value.type) ? value.type : [value.type];
    const concrete = types.filter((type) => type !== 'null');
    const type = concrete[0];
    if (
      concrete.length !== 1 ||
      typeof type !== 'string' ||
      !['string', 'number', 'integer', 'boolean', 'object', 'array'].includes(type) ||
      types.length > 2
    ) {
      throw new Error(
        'import openapi: request body requires a supported explicit type at every schema node',
      );
    }
    if (value.nullable !== undefined && typeof value.nullable !== 'boolean') {
      throw new Error('import openapi: request body nullable must be boolean');
    }
    if (
      (value.properties !== undefined ||
        value.required !== undefined ||
        value.additionalProperties !== undefined) &&
      type !== 'object'
    ) {
      throw new Error('import openapi: request body object keywords require an object type');
    }
    if (
      (type === 'array' && value.items === undefined) ||
      (value.items !== undefined && type !== 'array')
    ) {
      throw new Error('import openapi: request body arrays require one typed items schema');
    }
    if (
      value.additionalProperties !== undefined &&
      typeof value.additionalProperties !== 'boolean'
    ) {
      throw new Error('import openapi: request body additionalProperties must be boolean');
    }
    if (
      value.enum !== undefined &&
      (!Array.isArray(value.enum) ||
        value.enum.length === 0 ||
        !value.enum.every((item) => typeof item === 'string'))
    ) {
      throw new Error('import openapi: request body supports only nonempty string enums');
    }
    if (
      value.enum !== undefined &&
      (type !== 'string' || types.includes('null') || value.nullable === true)
    ) {
      throw new Error(
        'import openapi: request body enum/nullable combination requires an explicit mapping',
      );
    }
    if (
      value.required !== undefined &&
      (!Array.isArray(value.required) ||
        !value.required.every(
          (name) =>
            typeof name === 'string' &&
            isRecord(value.properties) &&
            Object.hasOwn(value.properties, name),
        ))
    ) {
      throw new Error('import openapi: request body required fields must have declared properties');
    }
    if (value.properties !== undefined) {
      if (!isRecord(value.properties))
        throw new Error('import openapi: request body properties must be an object');
      for (const child of Object.values(value.properties)) visit(child, depth + 1, refs);
    }
    if (value.items !== undefined) visit(value.items, depth + 1, refs);
  };
  visit(raw, 0, new Set());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
