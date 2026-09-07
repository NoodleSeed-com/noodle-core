import type { JsonSchema } from '@noodle-borg/compiler';
import { validateAgainstSchemaWithDefaults } from './execute.js';
import type { ExecutionError } from './result.js';

type ElicitationContentResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: ExecutionError };

/** Validate one accepted portable-form response as a closed set of declared fields. */
export function validateElicitationContent(
  value: unknown,
  schema: JsonSchema,
  pathPrefix: string,
): ElicitationContentResult {
  const undeclared = firstUndeclaredKey(value, schema);
  if (undeclared !== undefined) {
    return {
      ok: false,
      error: {
        code: 'arg_invalid',
        path: `${pathPrefix}.${undeclared}`,
        message: `elicitation field "${undeclared}" is not declared in the requested schema`,
      },
    };
  }
  return validateAgainstSchemaWithDefaults(
    value,
    schema,
    pathPrefix,
    'arg_invalid',
    'elicitation field',
  );
}

function firstUndeclaredKey(value: unknown, schema: JsonSchema): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const properties = schema.properties;
  const declared =
    properties !== null && typeof properties === 'object' && !Array.isArray(properties)
      ? properties
      : undefined;
  return Object.keys(value).find((key) => declared === undefined || !Object.hasOwn(declared, key));
}
