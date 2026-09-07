import { createHash } from 'node:crypto';

/** Locale-independent UTF-16 code-unit ordering used by every App Package canonical collection. */
export function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function canonicalValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON rejects non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const values: string[] = [];
    for (let index = 0; index < value.length; index++) values.push(canonicalValue(value[index]));
    return `[${values.join(',')}]`;
  }
  if (value === null || typeof value !== 'object')
    throw new TypeError('canonical JSON accepts only plain objects, arrays, and JSON primitives');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError('canonical JSON accepts only plain objects, arrays, and JSON primitives');
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort(compareCodeUnits)
    .map((key) => `${JSON.stringify(key)}:${canonicalValue(record[key])}`)
    .join(',')}}`;
}

export function canonicalJson(value: unknown): string {
  return canonicalValue(value);
}
export function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
