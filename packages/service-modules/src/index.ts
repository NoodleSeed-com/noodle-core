/**
 * How the hosted service acquires its modules: dynamic loading of operator-configured
 * packages behind an allowlist, and the loaded-module shape the host consumes. The host
 * composition itself stays in `@noodle-borg/service` until its audit-store coupling is
 * untangled (ADR 0203 carve-out direction).
 */

export * from './loaded-module.js';
export * from './loader.js';
