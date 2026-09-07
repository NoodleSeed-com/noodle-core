import Ajv2020Module, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
/** A JSON Schema 2020-12 document (object-shaped). */
export type JsonSchema = Record<string, unknown>;

export interface JsonSchemaValidationIssue {
  readonly path: string;
  readonly message: string;
  readonly keyword: string;
}

const Ajv2020 = Ajv2020Module.default;
const addFormats = addFormatsModule.default;

const ajv = new Ajv2020({
  allErrors: true,
  strict: false,
  validateFormats: true,
});
addFormats(ajv);

// A second instance for boundary coercion: `useDefaults` mutates the value it validates, so it
// must never share compiled validators with the pure checker above.
const ajvWithDefaults = new Ajv2020({
  allErrors: true,
  strict: false,
  validateFormats: true,
  useDefaults: true,
});
addFormats(ajvWithDefaults);

const validators = new WeakMap<object, ValidateFunction>();
const defaultingValidators = new WeakMap<object, ValidateFunction>();

/** Validate data with the complete JSON Schema 2020-12 contract used by every runtime boundary. */
export function validateJsonSchema(
  schema: JsonSchema,
  value: unknown,
): readonly JsonSchemaValidationIssue[] {
  let validate: ValidateFunction;
  try {
    validate = cachedValidator(schema);
  } catch (error) {
    return [
      { path: '', message: `invalid JSON Schema: ${safeErrorMessage(error)}`, keyword: 'schema' },
    ];
  }
  if (validate(value)) return [];
  return (validate.errors ?? []).map(validationIssue);
}

/**
 * Validate AND apply schema `default` values on a defensive copy; the caller's value is never
 * mutated. Runtime tool-call boundaries use this so an argument the model omitted arrives in the
 * handler with its advertised default (roadmap S5).
 */
export function validateJsonSchemaWithDefaults(
  schema: JsonSchema,
  value: unknown,
): { readonly value: unknown; readonly issues: readonly JsonSchemaValidationIssue[] } {
  let validate: ValidateFunction;
  try {
    validate = cachedDefaultingValidator(schema);
  } catch (error) {
    return {
      value,
      issues: [
        { path: '', message: `invalid JSON Schema: ${safeErrorMessage(error)}`, keyword: 'schema' },
      ],
    };
  }
  const copy = structuredClone(value);
  if (validate(copy)) return { value: copy, issues: [] };
  return { value: copy, issues: (validate.errors ?? []).map(validationIssue) };
}

function cachedDefaultingValidator(schema: JsonSchema): ValidateFunction {
  const key = schema as object;
  const cached = defaultingValidators.get(key);
  if (cached !== undefined) return cached;
  const compiled = ajvWithDefaults.compile(schema);
  defaultingValidators.set(key, compiled);
  return compiled;
}

function cachedValidator(schema: JsonSchema): ValidateFunction {
  const key = schema as object;
  const cached = validators.get(key);
  if (cached !== undefined) return cached;
  const compiled = ajv.compile(schema);
  validators.set(key, compiled);
  return compiled;
}

function validationIssue(error: ErrorObject): JsonSchemaValidationIssue {
  const missingProperty =
    error.keyword === 'required' &&
    typeof (error.params as { missingProperty?: unknown }).missingProperty === 'string'
      ? (error.params as { missingProperty: string }).missingProperty
      : undefined;
  const additionalProperty =
    error.keyword === 'additionalProperties' &&
    typeof (error.params as { additionalProperty?: unknown }).additionalProperty === 'string'
      ? (error.params as { additionalProperty: string }).additionalProperty
      : undefined;
  const path = [pointerPath(error.instancePath), additionalProperty ?? missingProperty]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join('.');
  return { path, message: validationMessage(error), keyword: error.keyword };
}

function validationMessage(error: ErrorObject): string {
  const params = error.params as Record<string, unknown>;
  switch (error.keyword) {
    case 'required':
      return `missing required field "${String(params.missingProperty)}"`;
    case 'additionalProperties':
      return `unknown field "${String(params.additionalProperty)}"`;
    case 'type':
      return `expected ${String(params.type)}`;
    case 'minLength':
      return `must be at least ${String(params.limit)} characters`;
    case 'maxLength':
      return `must be at most ${String(params.limit)} characters`;
    case 'minimum':
      return `must be >= ${String(params.limit)}`;
    case 'maximum':
      return `must be <= ${String(params.limit)}`;
    case 'exclusiveMinimum':
      return `must be > ${String(params.limit)}`;
    case 'exclusiveMaximum':
      return `must be < ${String(params.limit)}`;
    case 'minItems':
      return `must contain at least ${String(params.limit)} item(s)`;
    case 'maxItems':
      return `must contain at most ${String(params.limit)} item(s)`;
    case 'pattern':
      return 'does not match pattern';
    case 'format':
      return `must match format "${String(params.format)}"`;
    case 'enum':
      return 'expected one of the declared values';
    case 'const':
      return 'must equal the declared constant';
    default:
      return error.message ?? `failed ${error.keyword} validation`;
  }
}

function pointerPath(pointer: string): string {
  return pointer
    .split('/')
    .slice(1)
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
    .join('.');
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'schema compilation failed';
}
