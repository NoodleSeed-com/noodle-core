const MAX_CONTEXT_BYTES = 16 * 1024;
const MAX_CONTEXT_DEPTH = 8;
const MAX_CONTAINER_ENTRIES = 128;
const SENSITIVE_KEY = /(?:secret|token|api[-_]?key|password|credential|authorization|cookie)/i;
const CREDENTIAL_SHAPED_TEXT =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{12,}\b|\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}\b|\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b)/i;

interface ContextBoundsIssue {
  readonly path: string;
  readonly message: string;
}

type CanonicalContextResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly issue: ContextBoundsIssue };

type CanonicalValueResult = CanonicalContextResult;

/** Canonicalize application context once before schema validation, prompting, or client exposure. */
export function canonicalizeContext(
  value: unknown,
  rootPath = 'context.ambient',
): CanonicalContextResult {
  const canonical = canonicalize(value, rootPath, 0, new Set<object>());
  if (!canonical.ok) return canonical;

  let encoded: string;
  try {
    encoded = JSON.stringify(canonical.value);
  } catch {
    return {
      ok: false,
      issue: { path: rootPath, message: 'ambient context must be JSON serializable' },
    };
  }
  if (new TextEncoder().encode(encoded).byteLength > MAX_CONTEXT_BYTES) {
    return {
      ok: false,
      issue: { path: rootPath, message: 'ambient context must not exceed 16 KiB' },
    };
  }
  return canonical;
}

function canonicalize(
  value: unknown,
  path: string,
  depth: number,
  ancestors: Set<object>,
): CanonicalValueResult {
  if (depth > MAX_CONTEXT_DEPTH) {
    return fail(path, 'ambient context exceeds the maximum nesting depth');
  }
  if (
    value === null ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return { ok: true, value };
  }
  if (typeof value === 'string') {
    return CREDENTIAL_SHAPED_TEXT.test(value)
      ? fail(path, 'ambient context contains credential-shaped text')
      : { ok: true, value };
  }
  if (typeof value !== 'object') {
    return fail(path, 'ambient context contains a non-JSON value');
  }
  if (ancestors.has(value)) return fail(path, 'ambient context contains a cycle');

  try {
    if (hasToJsonProperty(value)) {
      return fail(path, 'ambient context must not define or inherit toJSON');
    }
    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) {
        return fail(path, 'ambient context arrays must use the standard JSON prototype');
      }
      return canonicalizeArray(value, path, depth, ancestors);
    }
    if (prototype !== Object.prototype && prototype !== null) {
      return fail(path, 'ambient context objects must be plain records');
    }
    return canonicalizeRecord(value as Record<string, unknown>, path, depth, ancestors);
  } catch {
    return fail(path, 'ambient context must be safely inspectable JSON data');
  }
}

function canonicalizeArray(
  value: readonly unknown[],
  path: string,
  depth: number,
  ancestors: Set<object>,
): CanonicalValueResult {
  if (value.length > MAX_CONTAINER_ENTRIES) {
    return fail(path, 'ambient context has more than 128 entries in one container');
  }
  const result: unknown[] = [];
  ancestors.add(value);
  for (let index = 0; index < value.length; index += 1) {
    const entry = Object.hasOwn(value, index) ? value[index] : null;
    const canonical = canonicalize(entry, `${path}.${index}`, depth + 1, ancestors);
    if (!canonical.ok) {
      ancestors.delete(value);
      return canonical;
    }
    result.push(canonical.value);
  }
  ancestors.delete(value);
  return { ok: true, value: result };
}

function canonicalizeRecord(
  value: Record<string, unknown>,
  path: string,
  depth: number,
  ancestors: Set<object>,
): CanonicalValueResult {
  const entries = Object.entries(value);
  if (entries.length > MAX_CONTAINER_ENTRIES) {
    return fail(path, 'ambient context has more than 128 entries in one container');
  }
  const result: Record<string, unknown> = Object.create(null);
  ancestors.add(value);
  for (const [key, entry] of entries) {
    const entryPath = `${path}.${key}`;
    if (SENSITIVE_KEY.test(key)) {
      ancestors.delete(value);
      return fail(entryPath, 'ambient context contains a credential-shaped key');
    }
    const canonical = canonicalize(entry, entryPath, depth + 1, ancestors);
    if (!canonical.ok) {
      ancestors.delete(value);
      return canonical;
    }
    result[key] = canonical.value;
  }
  ancestors.delete(value);
  return { ok: true, value: result };
}

function hasToJsonProperty(value: object): boolean {
  let current: object | null = value;
  const visited = new Set<object>();
  while (current !== null && !visited.has(current)) {
    visited.add(current);
    if (Object.getOwnPropertyDescriptor(current, 'toJSON') !== undefined) return true;
    current = Object.getPrototypeOf(current);
  }
  return false;
}

function fail(path: string, message: string): CanonicalValueResult {
  return { ok: false, issue: { path, message } };
}
