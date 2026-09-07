import { domainToUnicode } from 'node:url';

const MAX_ROUTED_OUTPUT_CLONE_DEPTH = 32;
const MAX_ROUTED_OUTPUT_CLONE_NODES = 10_000;
const MAX_PERCENT_DECODE_INPUT_LENGTH = 16_384;
const MAX_PERCENT_DECODE_ROUNDS = 2;
const CLONE_REJECTED = Symbol('routed output clone rejected');

export type RoutedOutputCloneResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false };

/**
 * Build the only routed connector value that may cross into policy or public runtime surfaces.
 *
 * The clone accepts strict JSON data, rejects observable/non-data object behavior, scans strings and
 * keys for the private route authority, and freezes the detached result. Nothing downstream receives
 * the connector-owned source object.
 */
export function cloneRoutedOutput(value: unknown, baseUrl: string): RoutedOutputCloneResult {
  try {
    const hostnameNeedles = routeHostnameNeedles(baseUrl);
    const active = new WeakSet<object>();
    const state = { nodes: 0 };
    return {
      ok: true,
      value: cloneJsonData(value, 0, hostnameNeedles, active, state),
    };
  } catch {
    return { ok: false };
  }
}

function cloneJsonData(
  value: unknown,
  depth: number,
  hostnameNeedles: readonly string[],
  active: WeakSet<object>,
  state: { nodes: number },
): unknown {
  state.nodes += 1;
  if (state.nodes > MAX_ROUTED_OUTPUT_CLONE_NODES || depth > MAX_ROUTED_OUTPUT_CLONE_DEPTH) {
    return rejectClone();
  }
  if (value === null) return null;
  if (typeof value === 'string') {
    if (containsHostname(value, hostnameNeedles)) return rejectClone();
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return rejectClone();
    return value;
  }
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'object') return rejectClone();
  if (active.has(value)) return rejectClone();

  active.add(value);
  try {
    return Array.isArray(value)
      ? cloneArray(value, depth, hostnameNeedles, active, state)
      : cloneRecord(value, depth, hostnameNeedles, active, state);
  } finally {
    active.delete(value);
  }
}

function cloneArray(
  value: unknown[],
  depth: number,
  hostnameNeedles: readonly string[],
  active: WeakSet<object>,
  state: { nodes: number },
): readonly unknown[] {
  if (Reflect.getPrototypeOf(value) !== Array.prototype) return rejectClone();
  const keys = Reflect.ownKeys(value);
  const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, 'length');
  const length =
    lengthDescriptor !== undefined && Object.hasOwn(lengthDescriptor, 'value')
      ? lengthDescriptor.value
      : undefined;
  if (
    lengthDescriptor === undefined ||
    lengthDescriptor.enumerable ||
    typeof length !== 'number' ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > MAX_ROUTED_OUTPUT_CLONE_NODES
  ) {
    return rejectClone();
  }
  if (keys.length !== length + 1) return rejectClone();

  const cloned = new Array<unknown>(length);
  let sawLength = false;
  for (const key of keys) {
    if (typeof key !== 'string') return rejectClone();
    if (key === 'length') {
      if (sawLength) return rejectClone();
      sawLength = true;
      continue;
    }
    const index = canonicalArrayIndex(key, length);
    if (index === null || containsHostname(key, hostnameNeedles)) return rejectClone();
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      return rejectClone();
    }
    cloned[index] = cloneJsonData(descriptor.value, depth + 1, hostnameNeedles, active, state);
  }
  if (!sawLength) return rejectClone();
  return Object.freeze(cloned);
}

function cloneRecord(
  value: object,
  depth: number,
  hostnameNeedles: readonly string[],
  active: WeakSet<object>,
  state: { nodes: number },
): Readonly<Record<string, unknown>> {
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return rejectClone();

  const cloned = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || key === 'toJSON' || containsHostname(key, hostnameNeedles)) {
      return rejectClone();
    }
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      return rejectClone();
    }
    Object.defineProperty(cloned, key, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: cloneJsonData(descriptor.value, depth + 1, hostnameNeedles, active, state),
    });
  }
  return Object.freeze(cloned);
}

function canonicalArrayIndex(key: string, length: number): number | null {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(key)) return null;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length ? index : null;
}

function routeHostnameNeedles(baseUrl: string): readonly string[] {
  const hostname = new URL(baseUrl).hostname.toLowerCase();
  if (hostname.length === 0) return rejectClone();
  const unicodeHostname = domainToUnicode(hostname).toLowerCase();
  return Object.freeze(
    unicodeHostname.length > 0 && unicodeHostname !== hostname
      ? [hostname, unicodeHostname]
      : [hostname],
  );
}

function containsHostname(value: string, hostnameNeedles: readonly string[]): boolean {
  let candidate = value;
  for (let round = 0; round <= MAX_PERCENT_DECODE_ROUNDS; round += 1) {
    const folded = candidate.toLowerCase();
    if (hostnameNeedles.some((hostname) => folded.includes(hostname))) return true;
    if (!candidate.includes('%')) return false;
    if (candidate.length > MAX_PERCENT_DECODE_INPUT_LENGTH || round === MAX_PERCENT_DECODE_ROUNDS) {
      return true;
    }
    try {
      candidate = decodeURIComponent(candidate);
    } catch {
      return true;
    }
  }
  return true;
}

function rejectClone(): never {
  throw CLONE_REJECTED;
}
