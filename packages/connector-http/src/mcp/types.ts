import type { FetchLike, Tool } from '@modelcontextprotocol/client';
import type { CredentialProfile, OperationSignature } from '@noodle-borg/compiler';
import type { DnsLookup } from '../ssrf.js';

/** How a broker-minted credential is presented to an upstream MCP server. */
export type McpAuthScheme = CredentialProfile | { readonly kind: 'cookie' };

/** One curated Noodle operation mapped to one frozen upstream MCP tool. */
export interface McpOperation {
  readonly upstreamTool: string;
  readonly signature: OperationSignature;
  /** Frozen upstream output schema; omitted when the imported tool had no output schema. */
  readonly upstreamOutputSchema?: OperationSignature['output'];
  readonly auth?: McpAuthScheme;
  /** Inclusive decoded-result limit. Defaults to the connector-wide limit. */
  readonly maxResponseBytes?: number;
  readonly fake?: McpOperationFake;
}

export type McpOperationFake =
  | { readonly structuredContent: Readonly<Record<string, unknown>> }
  | { readonly text: string };

/** Runtime configuration for one remote Streamable HTTP MCP server. */
export interface McpConnectorConfig {
  readonly id: string;
  readonly version: string;
  /** Literal endpoint or one exact `${env.NAME}` managed-variable reference. */
  readonly endpoint: string;
  /** Exact egress origins. Required when `endpoint` is managed. */
  readonly allowedOrigins?: readonly string[];
  readonly operations: Readonly<Record<string, McpOperation>>;
  readonly auth?: McpAuthScheme;
  /** Total connection + call timeout. Default 10 seconds. */
  readonly timeoutMs?: number;
  /** Inclusive decoded MCP response limit. Default 1 MiB, maximum 6 MiB. */
  readonly maxResponseBytes?: number;
  /** Protocol-era policy. `auto` safely negotiates modern or legacy and is the default. */
  readonly protocol?: 'auto' | 'legacy' | 'modern';
  /** Compiler-owned deterministic mode; bypasses transport and credentials. */
  readonly fakeMode?: boolean;
}

/**
 * Hermetic-test seams. Production compilation never accepts or emits these values; outbound traffic uses
 * the guarded transport and system DNS resolver.
 */
export interface McpConnectorDependencies {
  readonly fetch?: FetchLike;
  readonly lookup?: DnsLookup;
}

export function toolDefinition(operation: McpOperation): Tool {
  return {
    name: operation.upstreamTool,
    inputSchema: operation.signature.input,
    ...(operation.upstreamOutputSchema === undefined
      ? {}
      : { outputSchema: operation.upstreamOutputSchema }),
  } as Tool;
}
