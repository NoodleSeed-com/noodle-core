/** Every MCP revision served by one Noodle HTTP origin, newest first. */
export const SERVED_MCP_PROTOCOL_VERSIONS = [
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
  '2024-10-07',
] as const;

export type ServedMcpProtocolVersion = (typeof SERVED_MCP_PROTOCOL_VERSIONS)[number];
export type McpProtocolEra = 'legacy' | 'modern';

export const MODERN_MCP_PROTOCOL_VERSION = SERVED_MCP_PROTOCOL_VERSIONS[0];
/** The newest revision served through the legacy (v1 SDK) path. */
export const LEGACY_MCP_PROTOCOL_VERSION = SERVED_MCP_PROTOCOL_VERSIONS[1];

/** Origin-wide rollout gate: serve both eras, or answer modern requests with method-not-found. */
export type McpProtocolMode = 'dual' | 'legacy-only';
