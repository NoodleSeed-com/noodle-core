import type { ModelContextUpdate } from './bridge.js';

const MAX_MODEL_CONTEXT_BYTES = 16 * 1024;
const MAX_MODEL_CONTEXT_DEPTH = 8;
const MAX_CONTAINER_ENTRIES = 128;
const SENSITIVE_KEY = /(?:secret|token|api[-_]?key|password|credential|authorization|cookie)/i;
const CREDENTIAL_SHAPED_TEXT =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{20,}\b|\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{20,}\b|\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b)/i;

/** Validate and detach the compact widget summary before it crosses the host bridge. */
export function copyBoundedModelContext(update: ModelContextUpdate): ModelContextUpdate {
  const copy = copyJsonValue(update, '$', 0, new Set<object>());
  if (!isPlainRecord(copy)) throw new Error('Model context must be a JSON object');
  const encoded = JSON.stringify(copy);
  if (new TextEncoder().encode(encoded).byteLength > MAX_MODEL_CONTEXT_BYTES) {
    throw new Error('Model context must not exceed 16 KiB');
  }
  return copy as ModelContextUpdate;
}

function copyJsonValue(
  value: unknown,
  path: string,
  depth: number,
  ancestors: Set<object>,
): unknown {
  if (depth > MAX_MODEL_CONTEXT_DEPTH) {
    throw new Error(`Model context exceeds the maximum nesting depth at ${path}`);
  }
  if (
    value === null ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  if (typeof value === 'string') {
    if (CREDENTIAL_SHAPED_TEXT.test(value)) {
      throw new Error(`Model context contains credential-shaped text at ${path}`);
    }
    return value;
  }
  if (typeof value !== 'object') {
    throw new Error(`Model context contains a non-JSON value at ${path}`);
  }
  if (hasToJsonProperty(value)) {
    throw new Error(`Model context must not define or inherit toJSON at ${path}`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) {
      throw new Error(`Model context arrays must use the standard JSON prototype at ${path}`);
    }
  } else if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`Model context objects must be plain records at ${path}`);
  }
  if (ancestors.has(value)) throw new Error(`Model context contains a cycle at ${path}`);

  if (Array.isArray(value)) {
    if (value.length > MAX_CONTAINER_ENTRIES) {
      throw new Error(`Model context has more than 128 entries at ${path}`);
    }
    const copy: unknown[] = [];
    ancestors.add(value);
    for (let index = 0; index < value.length; index += 1) {
      const entry = Object.hasOwn(value, index) ? value[index] : null;
      copy.push(copyJsonValue(entry, `${path}.${index}`, depth + 1, ancestors));
    }
    ancestors.delete(value);
    return copy;
  }

  const entries = Object.entries(value);
  if (entries.length > MAX_CONTAINER_ENTRIES) {
    throw new Error(`Model context has more than 128 entries at ${path}`);
  }
  const copy: Record<string, unknown> = Object.create(null);
  ancestors.add(value);
  for (const [key, entry] of entries) {
    if (SENSITIVE_KEY.test(key)) {
      throw new Error(`Model context contains sensitive key ${path}.${key}`);
    }
    copy[key] = copyJsonValue(entry, `${path}.${key}`, depth + 1, ancestors);
  }
  ancestors.delete(value);
  return copy;
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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
