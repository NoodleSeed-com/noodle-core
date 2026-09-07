import { expect } from 'vitest';
import type { JsonEnvelope } from '../../src/commands/output.js';

/**
 * Assert an object is a well-formed uniform `--json` envelope (S3-A): `ok` is a boolean, and on failure
 * `error.code` and `error.message` are strings. Returns the value narrowed to `JsonEnvelope<T>` so a shape
 * test can then read `data`/`error` without re-narrowing.
 */
export function assertJsonEnvelope<T = unknown>(value: unknown): JsonEnvelope<T> {
  expect(value === null || typeof value !== 'object', 'envelope must be a non-null object').toBe(
    false,
  );
  const envelope = value as { ok?: unknown; error?: unknown };
  expect(typeof envelope.ok, 'envelope.ok must be a boolean').toBe('boolean');
  if (envelope.ok === false) {
    const error = envelope.error as { code?: unknown; message?: unknown } | undefined;
    expect(
      error === null || typeof error !== 'object',
      'failure envelope must carry an error object',
    ).toBe(false);
    expect(typeof error?.code, 'error.code must be a string').toBe('string');
    expect(typeof error?.message, 'error.message must be a string').toBe('string');
  }
  return value as JsonEnvelope<T>;
}
