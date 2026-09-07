import type { CatalogConnector, OperationSignature } from '@noodle-borg/compiler';
import {
  McpConnector,
  type McpConnectorConfig,
  type McpOperation,
} from '@noodle-borg/connector-http';
import type { Connector } from '@noodle-borg/runtime';
import { collectVariablesFromHttpAuth } from './auth-variables.js';
import type { SecretBinding } from './compile.js';
import { addAuthBinding, toAuthScheme } from './compile-auth.js';
import type { ConnectorCompileError } from './compile-expr.js';
import { toSignature } from './compile-http.js';
import { catalogCredentialMetadata } from './credential-profiles.js';
import type { HttpAuthDef, McpConnectorDef } from './schema.js';
import { collectVariableExpression, isVariableExpression } from './variables.js';

/** Compile one frozen upstream MCP tool snapshot into the ordinary Connector runtime port. */
export function compileMcpConnector(
  def: McpConnectorDef,
  mode: 'live' | 'fake',
  errors: ConnectorCompileError[],
  catalog: CatalogConnector[],
  connectors: Connector[],
  secretBindings: SecretBinding[],
  variableBindings: Set<string>,
): void {
  const endpoint = def.mcp.endpoint;
  const allowedOrigins =
    def.mcp.allowedOrigins ?? (isVariableExpression(endpoint) ? [] : [endpoint]);
  collectVariableExpression(endpoint, variableBindings);
  for (const origin of allowedOrigins) collectVariableExpression(origin, variableBindings);
  if (def.mcp.auth !== undefined) collectVariablesFromHttpAuth(def.mcp.auth, variableBindings);

  if (isVariableExpression(endpoint) && def.mcp.allowedOrigins === undefined) {
    errors.push({
      code: 'variable_mcp_endpoint_requires_allowed_origins',
      path: `connectors.${def.id}.mcp.allowedOrigins`,
      message: 'mcp.allowedOrigins is required when mcp.endpoint is a managed variable',
    });
    return;
  }

  const signatures: Record<string, OperationSignature> = {};
  const operations: Record<string, McpOperation> = {};
  for (const [operationName, operation] of Object.entries(def.operations)) {
    const base = `connectors.${def.id}.operations.${operationName}`;
    const signature = toSignature(operation.type, operation.input, operation.output);
    signatures[operationName] = signature;
    if (operation.auth !== undefined)
      collectVariablesFromHttpAuth(operation.auth, variableBindings);
    operations[operationName] = {
      upstreamTool: operation.tool,
      signature,
      ...(operation.result === 'structured' ? { upstreamOutputSchema: signature.output } : {}),
      ...(operation.auth === undefined ? {} : { auth: mcpAuthScheme(operation.auth) }),
      ...(operation.limits?.maxResponseBytes === undefined
        ? {}
        : { maxResponseBytes: operation.limits.maxResponseBytes }),
      ...(operation.fake === undefined ? {} : { fake: operation.fake }),
    };
    addAuthBinding({
      auth: operation.auth,
      connectorId: def.id,
      connectorVersion: def.version,
      operation: operationName,
      path: `${base}.auth`,
      allowedOrigins: literalOrigins(allowedOrigins),
      secretBindings,
      errors,
    });
  }

  catalog.push({
    id: def.id,
    version: def.version,
    kind: def.kind ?? 'custom',
    ...catalogCredentialMetadata(def),
    operations: signatures,
  });
  addAuthBinding({
    auth: def.mcp.auth,
    connectorId: def.id,
    connectorVersion: def.version,
    path: `connectors.${def.id}.mcp.auth`,
    allowedOrigins: literalOrigins(allowedOrigins),
    secretBindings,
    errors,
  });

  const config: McpConnectorConfig = {
    id: def.id,
    version: def.version,
    endpoint,
    ...(def.mcp.allowedOrigins === undefined ? {} : { allowedOrigins: def.mcp.allowedOrigins }),
    ...(def.mcp.auth === undefined ? {} : { auth: mcpAuthScheme(def.mcp.auth) }),
    ...(def.mcp.timeoutMs === undefined ? {} : { timeoutMs: def.mcp.timeoutMs }),
    ...(def.mcp.maxResponseBytes === undefined
      ? {}
      : { maxResponseBytes: def.mcp.maxResponseBytes }),
    ...(def.mcp.protocol === undefined ? {} : { protocol: def.mcp.protocol }),
    ...(mode === 'fake' ? { fakeMode: true } : {}),
    operations,
  };
  connectors.push(new McpConnector(config));
}

function mcpAuthScheme(auth: HttpAuthDef) {
  const scheme = toAuthScheme(auth);
  if (scheme.kind === 'cookie') {
    throw new Error('delegated session cookie auth is not valid for an MCP connector');
  }
  return scheme;
}

function literalOrigins(origins: readonly string[]): string[] {
  return origins.filter((origin) => !isVariableExpression(origin));
}
