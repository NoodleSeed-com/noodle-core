/** Shared runtime guard for every widget-to-host model-context path, including raw HTML actions. */
export const WIDGET_MODEL_CONTEXT_SOURCE = `
  const MAX_MODEL_CONTEXT_BYTES = 16 * 1024;
  const MAX_MODEL_CONTEXT_DEPTH = 8;
  const MAX_MODEL_CONTEXT_ENTRIES = 128;
  const MODEL_CONTEXT_SENSITIVE_KEY = /(?:secret|token|api[-_]?key|password|credential|authorization|cookie)/i;
  const MODEL_CONTEXT_CREDENTIAL_TEXT = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\\bsk-[A-Za-z0-9_-]{20,}\\b|\\b(?:bearer|basic)\\s+[A-Za-z0-9._~+/=-]{20,}\\b|\\b[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}\\b)/i;
  function hasModelContextToJSON(value) {
    let current = value;
    const visited = new Set();
    while (current !== null && !visited.has(current)) {
      visited.add(current);
      if (Object.getOwnPropertyDescriptor(current, 'toJSON') !== undefined) return true;
      current = Object.getPrototypeOf(current);
    }
    return false;
  }
  function copyModelContextValue(value, path, depth, ancestors) {
    if (depth > MAX_MODEL_CONTEXT_DEPTH) throw new Error('Model context exceeds the maximum nesting depth at ' + path);
    if (typeof value === 'string') {
      if (MODEL_CONTEXT_CREDENTIAL_TEXT.test(value)) throw new Error('Model context contains credential-shaped text at ' + path);
      return value;
    }
    if (value === null || typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value))) return value;
    if (!value || typeof value !== 'object') throw new Error('Model context contains a non-JSON value at ' + path);
    if (hasModelContextToJSON(value)) throw new Error('Model context must not define or inherit toJSON at ' + path);
    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) throw new Error('Model context arrays must use the standard JSON prototype at ' + path);
    } else if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('Model context objects must be plain records at ' + path);
    }
    if (ancestors.has(value)) throw new Error('Model context contains a cycle at ' + path);

    if (Array.isArray(value)) {
      if (value.length > MAX_MODEL_CONTEXT_ENTRIES) throw new Error('Model context has more than 128 entries at ' + path);
      const copy = [];
      ancestors.add(value);
      for (let index = 0; index < value.length; index += 1) {
        const entry = Object.prototype.hasOwnProperty.call(value, index) ? value[index] : null;
        copy.push(copyModelContextValue(entry, path + '.' + index, depth + 1, ancestors));
      }
      ancestors.delete(value);
      return copy;
    }

    const entries = Object.entries(value);
    if (entries.length > MAX_MODEL_CONTEXT_ENTRIES) throw new Error('Model context has more than 128 entries at ' + path);
    const copy = Object.create(null);
    ancestors.add(value);
    for (const [key, entry] of entries) {
      if (MODEL_CONTEXT_SENSITIVE_KEY.test(key)) {
        throw new Error('Model context contains sensitive key ' + path + '.' + key);
      }
      copy[key] = copyModelContextValue(entry, path + '.' + key, depth + 1, ancestors);
    }
    ancestors.delete(value);
    return copy;
  }
  function copyModelContextUpdate(update) {
    const copy = copyModelContextValue(update, '$', 0, new Set());
    if (!copy || typeof copy !== 'object' || Array.isArray(copy)) {
      throw new Error('Model context must be a JSON object');
    }
    const encoded = JSON.stringify(copy);
    if (new TextEncoder().encode(encoded).byteLength > MAX_MODEL_CONTEXT_BYTES) {
      throw new Error('Model context must not exceed 16 KiB');
    }
    return copy;
  }
  function guardModelContextUpdates(target) {
    if (!target || typeof target.updateModelContext !== 'function') return;
    const publish = target.updateModelContext.bind(target);
    target.updateModelContext = (update) => {
      return publish(copyModelContextUpdate(update));
    };
  }
`;
