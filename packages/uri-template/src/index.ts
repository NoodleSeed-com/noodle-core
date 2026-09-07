/**
 * Minimal RFC 6570 simple-form URI-template parsing for MCP resource URIs — the one shared
 * implementation. Extracted from `packages/compiler` so `packages/protocol` and future runtime
 * consumers parse templates without depending on the compiler graph.
 */

export * from './uri-template.js';
