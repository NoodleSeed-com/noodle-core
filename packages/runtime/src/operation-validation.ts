import {
  computeSignatureHash,
  type ExprMap,
  type JsonSchema,
  type JsonSchemaValidationIssue,
  type OperationSignature,
  type ResolvedOperationRef,
  validateJsonSchema,
  validateJsonSchemaWithDefaults,
} from '@noodle-borg/compiler';
import { type EvalScope, evaluateValue } from './eval/evaluate.js';
import type { ExecutionError } from './result.js';

/** Verify the connector's live signature matches the hash the artifact was compiled against. */
export function checkSignature(
  ref: ResolvedOperationRef,
  signature: OperationSignature | undefined,
): ExecutionError | null {
  if (!signature) {
    return {
      code: 'signature_drift',
      message: `connector has no operation "${ref.operation}"`,
    };
  }
  const actual = computeSignatureHash(ref.operation, signature);
  if (actual !== ref.signatureHash) {
    return {
      code: 'signature_drift',
      message: `operation "${ref.operation}" signature has drifted from the compiled artifact`,
    };
  }
  return null;
}

/** Evaluate every value in an expression map; omit any key that resolves to `undefined`. */
/** @internal Shared with the suspension-aware flow executor. */
export function evalExprMap(
  map: ExprMap,
  scope: EvalScope,
  prefix: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, node] of Object.entries(map)) {
    const value = evaluateValue(node, scope, `${prefix}.${key}`);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Validate operation I/O with the same complete JSON Schema contract advertised to clients. */
/** @internal Shared with the ambient-context executor; not exported from the package barrel. */
export function validateAgainstSchema(
  value: unknown,
  schema: JsonSchema,
  pathPrefix: string,
  code: 'arg_invalid' | 'output_invalid',
  noun: string,
): ExecutionError | null {
  const issue = validateJsonSchema(schema, value)[0];
  if (issue === undefined) return null;
  return {
    code,
    path: issue.path.length === 0 ? pathPrefix : `${pathPrefix}.${issue.path}`,
    message: runtimeValidationMessage(noun, issue),
  };
}

/** Validate accepted interactive input and apply schema defaults on a defensive copy. */
/** @internal Shared by both confirmation and non-confirmation continuation kernels. */
export function validateAgainstSchemaWithDefaults(
  value: unknown,
  schema: JsonSchema,
  pathPrefix: string,
  code: 'arg_invalid' | 'output_invalid',
  noun: string,
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: ExecutionError } {
  const validated = validateJsonSchemaWithDefaults(schema, value);
  const issue = validated.issues[0];
  if (issue === undefined) return { ok: true, value: validated.value };
  return {
    ok: false,
    error: {
      code,
      path: issue.path.length === 0 ? pathPrefix : `${pathPrefix}.${issue.path}`,
      message: runtimeValidationMessage(noun, issue),
    },
  };
}

function runtimeValidationMessage(noun: string, issue: JsonSchemaValidationIssue): string {
  const field = issue.path.split('.').at(-1);
  if (issue.keyword === 'required' && field !== undefined) {
    return `missing required ${noun} "${field}"`;
  }
  if (issue.keyword === 'type' && issue.path.length === 0) {
    return `${noun} container must be a non-null object`;
  }
  if (issue.keyword === 'type' && field !== undefined) {
    return `${noun} "${field}" ${issue.message.replace(/^expected /, 'expects ')}`;
  }
  return `${noun}${field === undefined ? '' : ` "${field}"`} ${issue.message}`;
}
