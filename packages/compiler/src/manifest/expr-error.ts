import type { CompileError } from '../errors.js';
import { docAnchorFor } from '../suggest.js';

/** Internal expression-parse failure, converted to a {@link CompileError} at the public boundary. */
export class ExprError extends Error {
  constructor(
    readonly code: CompileError['code'],
    message: string,
    /** Generation-friendly fields surfaced on the projected {@link CompileError} (with a `docAnchor`). */
    readonly fields?: { readonly expected?: string; readonly got?: string },
  ) {
    super(message);
  }
}

/** Project an {@link ExprError} to a flat {@link CompileError}, attaching enrichment when present. */
export function exprErrorToCompileError(err: ExprError, path: string): CompileError {
  if (err.fields === undefined) return { code: err.code, path, message: err.message };
  return {
    code: err.code,
    path,
    message: err.message,
    ...(err.fields.expected !== undefined ? { expected: err.fields.expected } : {}),
    ...(err.fields.got !== undefined ? { got: err.fields.got } : {}),
    docAnchor: docAnchorFor(err.code),
  };
}
