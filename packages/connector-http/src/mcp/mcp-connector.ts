import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Connector, ConnectorCall } from '@noodle-borg/runtime';
import { ConnectorInvocationError } from '@noodle-borg/runtime';
import {
  configuredOrigins,
  isVariable,
  parsedEndpoint,
  resolveManagedString,
  responseLimit,
} from './config.js';
import { invocationFetch } from './egress.js';
import { normalizeMcpFailure } from './failure.js';
import { normalizeToolResult } from './result.js';
import { type McpConnectorConfig, type McpConnectorDependencies, toolDefinition } from './types.js';

const DEFAULT_TIMEOUT_MS = 10_000;

/** Governed, invocation-scoped client for one imported remote Streamable HTTP MCP server. */
export class McpConnector implements Connector {
  readonly id: string;
  readonly version: string;
  readonly #config: McpConnectorConfig;
  readonly #dependencies: McpConnectorDependencies;

  constructor(config: McpConnectorConfig, dependencies: McpConnectorDependencies = {}) {
    this.id = config.id;
    this.version = config.version;
    this.#config = config;
    this.#dependencies = dependencies;
    if (Object.keys(config.operations).length === 0) {
      throw new Error('an MCP connector must declare at least one curated operation');
    }
    if (isVariable(config.endpoint) && config.allowedOrigins === undefined) {
      throw new Error('mcp.allowedOrigins is required when endpoint is a managed variable');
    }
    if (!isVariable(config.endpoint)) parsedEndpoint(config.endpoint);
    responseLimit(config.maxResponseBytes);
  }

  signature(operation: string) {
    return this.#config.operations[operation]?.signature;
  }

  async invoke(call: ConnectorCall): Promise<unknown> {
    const operation = this.#config.operations[call.operation];
    if (operation === undefined) {
      throw new Error(`connector "${this.id}" has no operation "${call.operation}"`);
    }
    const maxBytes = responseLimit(operation.maxResponseBytes ?? this.#config.maxResponseBytes);
    if (this.#config.fakeMode === true) {
      if (operation.fake === undefined) {
        throw new ConnectorInvocationError(
          `fake MCP response missing for operation "${call.operation}"`,
          { category: 'invalid_response', retryable: false },
        );
      }
      return normalizeToolResult(
        'structuredContent' in operation.fake
          ? { structuredContent: operation.fake.structuredContent, content: [] }
          : { content: [{ type: 'text', text: operation.fake.text }] },
        maxBytes,
      );
    }
    const env = call.env ?? {};
    const endpoint = parsedEndpoint(resolveManagedString(this.#config.endpoint, env));
    const allowed = configuredOrigins(this.#config.allowedOrigins ?? [this.#config.endpoint], env);
    if (!allowed.has(endpoint.origin)) {
      throw new ConnectorInvocationError(
        `upstream MCP endpoint resolved to a disallowed origin "${endpoint.origin}"`,
        { category: 'invalid_response', retryable: false },
      );
    }

    const timeoutMs = this.#config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal =
      call.signal === undefined ? timeoutSignal : AbortSignal.any([timeoutSignal, call.signal]);
    const client = new Client(
      { name: 'noodle-mcp-connector', version: '1.0.0' },
      {
        capabilities: {},
        versionNegotiation: { mode: protocolMode(this.#config.protocol) },
        inputRequired: { autoFulfill: false },
      },
    );
    let responseLimitExceeded = false;
    let networkFailure = false;
    let retryAfterMs: number | undefined;
    const transport = new StreamableHTTPClientTransport(endpoint, {
      fetch: invocationFetch({
        allowedOrigins: allowed,
        ...((operation.auth ?? this.#config.auth) === undefined
          ? {}
          : { auth: operation.auth ?? this.#config.auth }),
        call,
        maxResponseBytes: maxBytes,
        dependencies: this.#dependencies,
        onResponseLimitExceeded: () => {
          responseLimitExceeded = true;
        },
        onNetworkFailure: () => {
          networkFailure = true;
        },
        onRetryAfter: (value) => {
          retryAfterMs = value;
        },
      }),
      onInsufficientScope: 'throw',
    });
    const closeTransportOnAbort = (): void => {
      void transport.close().catch(() => undefined);
    };
    signal.addEventListener('abort', closeTransportOnAbort, { once: true });
    if (signal.aborted) closeTransportOnAbort();

    try {
      await client.connect(transport, { signal, timeout: timeoutMs });
      const result = await client.callTool(
        { name: operation.upstreamTool, arguments: { ...call.args } },
        { signal, timeout: timeoutMs, toolDefinition: toolDefinition(operation) },
      );
      return normalizeToolResult(result, maxBytes);
    } catch (error) {
      if (responseLimitExceeded) {
        throw new ConnectorInvocationError('upstream MCP response exceeds the size limit', {
          category: 'response_too_large',
          retryable: false,
        });
      }
      if (networkFailure && !signal.aborted) {
        throw new ConnectorInvocationError('upstream MCP network request failed', {
          category: 'network_error',
          retryable: false,
        });
      }
      throw normalizeMcpFailure(error, {
        timedOut: signal.aborted,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      });
    } finally {
      signal.removeEventListener('abort', closeTransportOnAbort);
      await client.close().catch(() => undefined);
    }
  }
}

function protocolMode(
  protocol: McpConnectorConfig['protocol'],
): 'auto' | 'legacy' | { readonly pin: '2026-07-28' } {
  if (protocol === 'modern') return { pin: '2026-07-28' };
  return protocol ?? 'auto';
}
