/**
 * Standard JSON-RPC 2.0 error codes. The official `@modelcontextprotocol/sdk` owns the wire envelope;
 * these constants remain for the two SDK-agnostic users: the artifact→wire {@link mapping} (which picks
 * the channel for an execution error) and the HTTP front-door (which emits transport-level errors
 * before a request ever reaches the SDK).
 */
export const JSON_RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export interface JsonRpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export {
  LEGACY_MCP_ERROR,
  RESOURCE_NOT_FOUND,
} from './error-codes.js';
