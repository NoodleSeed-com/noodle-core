/** Lexical SDK compatibility only. None of these bindings is installed on the customer's global. */
export const sandboxSdkPrelude = `
const console = Object.freeze({ log() {}, warn() {}, error() {} });
// TypeScript initializes file timestamps and performance counters. They have no authoring clock.
const Date = class {
  static now() { return 0; }
  constructor(value = 0) {
    if (typeof value !== 'number') throw new Error('Only explicit numeric SDK timestamps are supported');
    this.value = value;
  }
  getTime() { return this.value; }
  valueOf() { return this.value; }
};
const Buffer = Object.freeze({ byteLength(value, encoding = 'utf8') {
  if (typeof value !== 'string' || encoding !== 'utf8') throw new Error('Only UTF-8 SDK text is supported');
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const point = value.charCodeAt(i);
    if (point < 128) bytes++;
    else if (point < 2048) bytes += 2;
    else if (point >= 0xd800 && point <= 0xdbff && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
} });
const structuredClone = (value, seen = new Map()) => {
  if (value === null || ['undefined', 'string', 'number', 'boolean', 'bigint'].includes(typeof value)) return value;
  if (typeof value !== 'object') throw new Error('SDK declarations must be data');
  if (seen.has(value)) return seen.get(value);
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw new Error('SDK declarations must be plain data');
  const clone = Array.isArray(value) ? new Array(value.length) : Object.create(prototype);
  seen.set(value, clone);
  for (const key of Object.keys(value)) Object.defineProperty(clone, key, { value: structuredClone(value[key], seen), writable: true, enumerable: true, configurable: true });
  return clone;
};
const __noodleDeniedBuiltin = new Proxy({}, { get() { throw new Error('Node APIs are not available in authoring'); } });
const __noodleCrypto = { createHash(...args) { return NoodleSandboxProgram.createHash(...args); } };
`;
