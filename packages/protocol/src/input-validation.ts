import { type JsonSchema, validateJsonSchemaWithDefaults } from '@noodle-borg/compiler';

export interface InputValidationIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * Validate MCP arguments AND apply schema `default` values on a defensive copy. Execution
 * boundaries must pass the returned `value` (not the caller's original) to the tool, so an
 * argument the model omitted arrives with its advertised default.
 */
export function coerceToolArguments(
  schema: JsonSchema,
  value: unknown,
): { readonly value: unknown; readonly issues: readonly InputValidationIssue[] } {
  const result = validateJsonSchemaWithDefaults(schema, value);
  return {
    value: result.value,
    issues: result.issues.map(({ path, message }) => ({ path, message })),
  };
}
