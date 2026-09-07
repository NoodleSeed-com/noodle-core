/**
 * Low-level expression helpers shared by the connector catalog compiler: parse mapping values into
 * expression ASTs (collecting parse errors) and evaluate a compiled map against a scope. Split out of
 * `compile.ts` so that file stays one concern per file; `compile.ts` re-exports `ConnectorCompileError` to
 * preserve the package's public API.
 */

import { type ExprNode, parseValue } from '@noodle-borg/compiler';
import { type EvalScope, evaluateValue } from '@noodle-borg/runtime';

/** A connector-definition compile error (structurally compatible with the compiler's `CompileError`). */
export interface ConnectorCompileError {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export type ArgsRecord = Readonly<Record<string, unknown>>;
export type OutputRecord = Readonly<Record<string, unknown>>;

/** Parse a single mapping value into an expression AST under the given roots; collect parse errors. */
export function compileExpr(
  value: unknown,
  roots: ReadonlySet<string>,
  path: string,
  errors: ConnectorCompileError[],
): ExprNode {
  const result = parseValue(value, path, roots);
  if (result.errors.length > 0) {
    errors.push(...result.errors.map((e) => ({ code: e.code, path: e.path, message: e.message })));
  }
  return result.node;
}

/** Parse each field of a mapping into an expression AST under the given roots; collect parse errors. */
export function compileExprMap(
  map: Readonly<Record<string, unknown>>,
  roots: ReadonlySet<string>,
  prefix: string,
  errors: ConnectorCompileError[],
): Record<string, ExprNode> {
  const out: Record<string, ExprNode> = {};
  for (const [field, value] of Object.entries(map)) {
    const result = parseValue(value, `${prefix}.${field}`, roots);
    if (result.errors.length > 0) {
      errors.push(
        ...result.errors.map((e) => ({ code: e.code, path: e.path, message: e.message })),
      );
    } else {
      out[field] = result.node;
    }
  }
  return out;
}

/** Evaluate every value in a compiled expression map against the scope; omit `undefined` results. */
export function evalMap(map: Record<string, ExprNode>, scope: EvalScope): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, node] of Object.entries(map)) {
    const value = evaluateValue(node, scope, field);
    if (field === '${spread}') {
      if (value === undefined) continue;
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('${spread} request mapping must evaluate to an object');
      }
      Object.assign(out, value);
      continue;
    }
    if (value !== undefined) out[field] = value;
  }
  return out;
}
