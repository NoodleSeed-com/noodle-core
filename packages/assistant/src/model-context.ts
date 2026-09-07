export type AssistantJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly AssistantJsonValue[]
  | { readonly [key: string]: AssistantJsonValue };

export type AssistantPageContext = Readonly<Record<string, AssistantJsonValue>>;

/** MCP-Apps-shaped summary deliberately selected by the renderer for the next assistant turn. */
export interface AssistantModelContextUpdate {
  readonly content?: readonly { readonly type: 'text'; readonly text: string }[];
  readonly structuredContent?: Readonly<Record<string, AssistantJsonValue>>;
}

const MAX_BYTES = 16 * 1024;
const MAX_DEPTH = 8;
const MAX_ENTRIES = 128;
const SENSITIVE_KEY = /(?:secret|token|api[-_]?key|password|credential|authorization|cookie)/i;
const CREDENTIAL_SHAPED_TEXT =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{20,}\b|\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{20,}\b|\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b)/i;

/** Validate and detach renderer-owned mutable data before retaining it in the client. */
export function copyAssistantModelContext(
  update: AssistantModelContextUpdate,
): AssistantModelContextUpdate {
  const copied = copyJsonValue(update, '$', 0, new Set<object>());
  assertModelContextShape(copied);
  const encoded = JSON.stringify(copied);
  if (new TextEncoder().encode(encoded).byteLength > MAX_BYTES) {
    throw new Error('Model context must not exceed 16 KiB');
  }
  return copied;
}

/** Validate and detach application-owned page data before attaching it to a turn. */
export function copyAssistantPageContext(context: AssistantPageContext): AssistantPageContext {
  const copied = copyJsonValue(context, '$', 0, new Set<object>());
  if (typeof copied !== 'object' || copied === null || Array.isArray(copied)) {
    throw new Error('Page context must be a JSON object');
  }
  const encoded = JSON.stringify(copied);
  if (new TextEncoder().encode(encoded).byteLength > MAX_BYTES) {
    throw new Error('Page context must not exceed 16 KiB');
  }
  return copied as AssistantPageContext;
}

function assertModelContextShape(value: unknown): asserts value is AssistantModelContextUpdate {
  if (!isPlainRecord(value)) throw new Error('Model context must be a JSON object');
  for (const key of Object.keys(value)) {
    if (key !== 'content' && key !== 'structuredContent') {
      throw new Error(`Model context contains unknown field ${key}`);
    }
  }
  if (value.content !== undefined) {
    if (!Array.isArray(value.content)) throw new Error('Model context content must be an array');
    for (const part of value.content) {
      if (
        !isPlainRecord(part) ||
        Object.keys(part).some((key) => key !== 'type' && key !== 'text') ||
        part.type !== 'text' ||
        typeof part.text !== 'string'
      ) {
        throw new Error('Model context content supports text parts only');
      }
    }
  }
  if (value.structuredContent !== undefined && !isPlainRecord(value.structuredContent)) {
    throw new Error('Model context structuredContent must be an object');
  }
}

function copyJsonValue(
  value: unknown,
  path: string,
  depth: number,
  ancestors: Set<object>,
): AssistantJsonValue {
  if (depth > MAX_DEPTH) throw new Error(`Model context exceeds maximum depth at ${path}`);
  if (typeof value === 'string') {
    if (CREDENTIAL_SHAPED_TEXT.test(value)) {
      throw new Error(`Model context contains credential-shaped text at ${path}`);
    }
    return value;
  }
  if (
    value === null ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  if (typeof value !== 'object') throw new Error(`Model context contains non-JSON data at ${path}`);
  if (hasToJsonProperty(value)) {
    throw new Error(`Model context must not define or inherit toJSON at ${path}`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) {
      throw new Error(`Model context contains a non-JSON object at ${path}`);
    }
  } else if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`Model context contains a non-JSON object at ${path}`);
  }
  if (ancestors.has(value)) throw new Error(`Model context contains a cycle at ${path}`);

  if (Array.isArray(value)) {
    if (value.length > MAX_ENTRIES) {
      throw new Error(`Model context has more than 128 entries at ${path}`);
    }
    const copy: AssistantJsonValue[] = [];
    ancestors.add(value);
    for (let index = 0; index < value.length; index += 1) {
      const entry = Object.hasOwn(value, index) ? value[index] : null;
      copy.push(copyJsonValue(entry, `${path}.${index}`, depth + 1, ancestors));
    }
    ancestors.delete(value);
    return copy;
  }

  const entries = Object.entries(value);
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`Model context has more than 128 entries at ${path}`);
  }
  const copy: Record<string, AssistantJsonValue> = Object.create(null);
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
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
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
