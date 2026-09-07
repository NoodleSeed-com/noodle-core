import type { FetchLike, ToolAnnotations } from '@modelcontextprotocol/client';

export interface McpImportAuth {
  readonly kind: 'bearer' | 'apiKey';
  readonly secretRef: string;
  readonly header?: string;
}

export interface McpImportedTool {
  readonly upstreamName: string;
  readonly operationName: string;
  readonly description: string;
  readonly operationType: 'read' | 'action';
  readonly destructive: boolean;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly result: 'structured' | 'text';
}

export interface McpImportSnapshot {
  readonly formatVersion: 1;
  readonly connectorId: string;
  readonly prefix?: string;
  readonly endpoint: string;
  readonly endpointVariable: string;
  readonly originVariable: string;
  readonly auth?: McpImportAuth;
  readonly tools: readonly McpImportedTool[];
  readonly warnings: readonly string[];
}

export interface McpDiscoveredTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: unknown;
  readonly outputSchema?: unknown;
  readonly annotations?: ToolAnnotations;
}

export interface ProbeMcpOptions {
  readonly endpoint: string;
  readonly name: string;
  readonly prefix?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly auth?: McpImportAuth;
  readonly protocol?: 'auto' | 'legacy' | 'modern';
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly fetch?: FetchLike;
}

export interface SnapshotDiff {
  readonly changed: boolean;
  readonly lines: readonly string[];
}
