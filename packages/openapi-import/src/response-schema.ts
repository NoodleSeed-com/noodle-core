/**
 * Response-schema import: converts an operation's OpenAPI `responses` block into a bounded,
 * typed output tree (`OpenApiImportSchema`) used to render tool-level Zod/JSON-Schema output.
 * Parsed documents are untrusted: bounded depth/node budgets, no external `$ref` dereferencing,
 * and no network fetches — external refs are a structured, repairable import error.
 */

export type OpenApiImportSchema =
  | { readonly kind: 'string'; readonly nullable?: boolean; readonly enum?: readonly string[] }
  | { readonly kind: 'number'; readonly nullable?: boolean; readonly integer?: boolean }
  | { readonly kind: 'boolean'; readonly nullable?: boolean }
  | { readonly kind: 'array'; readonly nullable?: boolean; readonly items: OpenApiImportSchema }
  | {
      readonly kind: 'object';
      readonly nullable?: boolean;
      readonly properties: readonly OpenApiImportProperty[];
      readonly additionalProperties?: boolean;
    }
  | { readonly kind: 'unknown' };

export interface OpenApiImportProperty {
  readonly name: string;
  readonly required: boolean;
  readonly schema: OpenApiImportSchema;
}

export const MAX_RESPONSE_SCHEMA_DEPTH = 8;
export const MAX_RESPONSE_SCHEMA_NODES = 200;

export interface ImportResponseSchemaContext {
  readonly operationName: string;
  readonly componentSchemas: Record<string, unknown>;
  readonly warnings: string[];
}

const UNKNOWN: OpenApiImportSchema = { kind: 'unknown' };
const UNSUPPORTED_COMPOSITIONS = ['oneOf', 'anyOf', 'allOf', 'not'] as const;

/** Shared bounded conversion; request validation is owned by request-body.ts. */
export function importSchemaTree(
  raw: unknown,
  ctx: ImportResponseSchemaContext,
  request = false,
): OpenApiImportSchema {
  return convertSchema(raw, ctx, { nodes: 0, boundWarned: false, request }, 0, new Set());
}

/**
 * Picks the best 2xx `application/json` schema from an operation's `responses` block and
 * converts it. Returns `undefined` (with warnings pushed to the context) when the operation
 * has no typeable JSON response; throws only for external `$ref`s.
 */
export function importResponseSchema(
  responses: unknown,
  ctx: ImportResponseSchemaContext,
): OpenApiImportSchema | undefined {
  if (!isRecord(responses)) return undefined;
  const statusKey = pickSuccessStatus(Object.keys(responses));
  if (statusKey === undefined) {
    if (jsonMediaSchema(contentOf(responses.default)) !== undefined) {
      ctx.warnings.push(
        `${ctx.operationName}: only a "default" response declares a JSON schema; output left untyped`,
      );
    }
    return undefined;
  }
  const content = contentOf(responses[statusKey]);
  if (content === undefined) return undefined;
  const schema = jsonMediaSchema(content);
  if (schema === undefined) {
    ctx.warnings.push(
      `${ctx.operationName}: ${statusKey} response has no application/json content; output left untyped`,
    );
    return undefined;
  }
  const state: ConversionState = { nodes: 0, boundWarned: false };
  const converted = convertSchema(schema, ctx, state, 0, new Set());
  return converted.kind === 'unknown' ? undefined : converted;
}

/** Renders the schema tree as JSON Schema for a manifest tool `outputSchema` value subtree. */
export function toOutputJsonSchema(schema: OpenApiImportSchema): Record<string, unknown> {
  switch (schema.kind) {
    case 'string':
      return withNullable(
        { type: 'string', ...(schema.enum !== undefined ? { enum: [...schema.enum] } : {}) },
        schema.nullable,
      );
    case 'number':
      return withNullable(
        { type: schema.integer === true ? 'integer' : 'number' },
        schema.nullable,
      );
    case 'boolean':
      return withNullable({ type: 'boolean' }, schema.nullable);
    case 'array':
      return withNullable(
        { type: 'array', items: toOutputJsonSchema(schema.items) },
        schema.nullable,
      );
    case 'object': {
      const extra =
        schema.additionalProperties === undefined
          ? {}
          : { additionalProperties: schema.additionalProperties };
      if (schema.properties.length === 0)
        return withNullable({ type: 'object', ...extra }, schema.nullable);
      const required = schema.properties
        .filter((property) => property.required)
        .map((property) => property.name);
      return withNullable(
        {
          type: 'object',
          properties: Object.fromEntries(
            schema.properties.map((property) => [
              property.name,
              toOutputJsonSchema(property.schema),
            ]),
          ),
          ...(required.length > 0 ? { required } : {}),
          ...extra,
        },
        schema.nullable,
      );
    }
    case 'unknown':
      return {};
  }
}

interface ConversionState {
  nodes: number;
  boundWarned: boolean;
  readonly request?: boolean;
}

function convertSchema(
  raw: unknown,
  ctx: ImportResponseSchemaContext,
  state: ConversionState,
  depth: number,
  visitedRefs: ReadonlySet<string>,
): OpenApiImportSchema {
  if (!isRecord(raw)) return UNKNOWN;
  state.nodes += 1;
  if (depth > MAX_RESPONSE_SCHEMA_DEPTH || state.nodes > MAX_RESPONSE_SCHEMA_NODES) {
    if (!state.boundWarned) {
      state.boundWarned = true;
      ctx.warnings.push(
        `${ctx.operationName}: response schema exceeds the import depth/size bound (depth ${MAX_RESPONSE_SCHEMA_DEPTH}, ${MAX_RESPONSE_SCHEMA_NODES} nodes); deeper parts left untyped`,
      );
    }
    return UNKNOWN;
  }

  if (typeof raw.$ref === 'string') {
    return convertRef(raw.$ref, ctx, state, depth, visitedRefs);
  }
  for (const keyword of UNSUPPORTED_COMPOSITIONS) {
    if (raw[keyword] !== undefined) {
      ctx.warnings.push(
        `${ctx.operationName}: response schema uses unsupported "${keyword}"; that part is left untyped`,
      );
      return UNKNOWN;
    }
  }

  const normalized = normalizeType(raw, ctx);
  if (normalized === undefined) return UNKNOWN;
  const { type, nullable } = normalized;
  const nullableSpread = nullable ? { nullable: true as const } : {};

  switch (type) {
    case 'string': {
      const enumValues = stringEnum(raw.enum);
      return {
        kind: 'string',
        ...nullableSpread,
        ...(enumValues !== undefined ? { enum: enumValues } : {}),
      };
    }
    case 'number':
    case 'integer':
      return {
        kind: 'number',
        ...nullableSpread,
        ...(state.request && type === 'integer' ? { integer: true } : {}),
      };
    case 'boolean':
      return { kind: 'boolean', ...nullableSpread };
    case 'array':
      return {
        kind: 'array',
        ...nullableSpread,
        items:
          raw.items === undefined
            ? UNKNOWN
            : convertSchema(raw.items, ctx, state, depth + 1, visitedRefs),
      };
    case 'object': {
      const properties = isRecord(raw.properties) ? raw.properties : {};
      const required = new Set(
        Array.isArray(raw.required)
          ? raw.required.filter((name): name is string => typeof name === 'string')
          : [],
      );
      return {
        kind: 'object',
        ...nullableSpread,
        ...(state.request ? { additionalProperties: raw.additionalProperties !== false } : {}),
        properties: Object.entries(properties).map(([name, propertySchema]) => ({
          name,
          required: required.has(name),
          schema: convertSchema(propertySchema, ctx, state, depth + 1, visitedRefs),
        })),
      };
    }
    default:
      ctx.warnings.push(
        `${ctx.operationName}: response schema type "${type}" is not supported; that part is left untyped`,
      );
      return UNKNOWN;
  }
}

function convertRef(
  ref: string,
  ctx: ImportResponseSchemaContext,
  state: ConversionState,
  depth: number,
  visitedRefs: ReadonlySet<string>,
): OpenApiImportSchema {
  if (!ref.startsWith('#')) {
    throw new Error(
      `import openapi: operation "${ctx.operationName}" response schema references external $ref "${ref}"; ` +
        'external references are not fetched during import — bundle the document into one file ' +
        '(e.g. `npx @redocly/cli bundle`) and re-run',
    );
  }
  const prefix = '#/components/schemas/';
  if (!ref.startsWith(prefix)) {
    ctx.warnings.push(
      `${ctx.operationName}: response schema $ref "${ref}" is not a component schema reference; that part is left untyped`,
    );
    return UNKNOWN;
  }
  const name = ref.slice(prefix.length).replace(/~1/g, '/').replace(/~0/g, '~');
  if (visitedRefs.has(name)) {
    ctx.warnings.push(
      `${ctx.operationName}: response schema $ref "${ref}" is circular; the repeated part is left untyped`,
    );
    return UNKNOWN;
  }
  const target = ctx.componentSchemas[name];
  if (target === undefined) {
    ctx.warnings.push(
      `${ctx.operationName}: response schema $ref "${ref}" does not resolve; that part is left untyped`,
    );
    return UNKNOWN;
  }
  return convertSchema(target, ctx, state, depth, new Set([...visitedRefs, name]));
}

function normalizeType(
  raw: Record<string, unknown>,
  ctx: ImportResponseSchemaContext,
): { type: string; nullable: boolean } | undefined {
  const nullable30 = raw.nullable === true;
  if (typeof raw.type === 'string') return { type: raw.type, nullable: nullable30 };
  if (Array.isArray(raw.type)) {
    const entries = raw.type.filter((entry): entry is string => typeof entry === 'string');
    const nonNull = entries.filter((entry) => entry !== 'null');
    const nullable = nullable30 || nonNull.length < entries.length;
    if (nonNull.length === 1 && nonNull[0] !== undefined) {
      return { type: nonNull[0], nullable };
    }
    ctx.warnings.push(
      `${ctx.operationName}: response schema type array [${entries.join(', ')}] is not supported; that part is left untyped`,
    );
    return undefined;
  }
  if (isRecord(raw.properties)) return { type: 'object', nullable: nullable30 };
  if (raw.items !== undefined) return { type: 'array', nullable: nullable30 };
  return undefined;
}

function stringEnum(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  if (!value.every((entry): entry is string => typeof entry === 'string')) return undefined;
  return value;
}

function pickSuccessStatus(keys: readonly string[]): string | undefined {
  if (keys.includes('200')) return '200';
  const numeric = keys
    .filter((key) => /^2\d\d$/.test(key))
    .sort((a, b) => Number(a) - Number(b))[0];
  if (numeric !== undefined) return numeric;
  return keys.find((key) => key.toUpperCase() === '2XX');
}

function contentOf(response: unknown): Record<string, unknown> | undefined {
  if (!isRecord(response) || !isRecord(response.content)) return undefined;
  return response.content;
}

function jsonMediaSchema(content: Record<string, unknown> | undefined): unknown {
  if (content === undefined) return undefined;
  for (const [mediaType, media] of Object.entries(content)) {
    const bare = mediaType.split(';')[0]?.trim().toLowerCase() ?? '';
    if (bare === 'application/json' || /^application\/[\w.-]+\+json$/.test(bare)) {
      if (isRecord(media) && media.schema !== undefined) return media.schema;
    }
  }
  return undefined;
}

function withNullable(
  schema: Record<string, unknown>,
  nullable: boolean | undefined,
): Record<string, unknown> {
  if (nullable !== true) return schema;
  const type = schema.type;
  return { ...schema, type: [type, 'null'] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
