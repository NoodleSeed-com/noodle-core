import YAML from 'yaml';
import { importRequestBody } from './request-body.js';
import { identifier, importOperationParameters } from './request-input.js';
import {
  type ImportResponseSchemaContext,
  importResponseSchema,
  toOutputJsonSchema,
} from './response-schema.js';
import type {
  MergeOpenApiIntoDraftInput,
  MergeOpenApiIntoDraftResult,
  OpenApiImportAuth,
  OpenApiImportIr,
  OpenApiImportOperation,
  OpenApiImportParameterSchema,
  OpenApiMethod,
  ParseOpenApiOptions,
} from './types.js';

export * from './mcp/index.js';
export type { OpenApiImportRequestBody } from './request-body.js';
export { identifier } from './request-input.js';
export {
  type ImportResponseSchemaContext,
  importResponseSchema,
  MAX_RESPONSE_SCHEMA_DEPTH,
  MAX_RESPONSE_SCHEMA_NODES,
  type OpenApiImportProperty,
  type OpenApiImportSchema,
  toOutputJsonSchema,
} from './response-schema.js';
export type * from './types.js';

const METHODS: ReadonlySet<string> = new Set(['get', 'post', 'put', 'patch', 'delete']);
export const MAX_OPENAPI_SOURCE_BYTES = 6 * 1024 * 1024;

export function parseOpenApiToIr(source: string, options: ParseOpenApiOptions): OpenApiImportIr {
  if (Buffer.byteLength(source, 'utf8') > MAX_OPENAPI_SOURCE_BYTES) {
    throw new Error(
      'import openapi: document exceeds the 6 MiB size limit; import a scoped API document',
    );
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(source, { maxAliasCount: 100 });
  } catch {
    throw new Error('import openapi: invalid JSON/YAML document; repair its syntax and retry');
  }
  if (!isRecord(parsed)) throw new Error('import openapi: document must be an object');
  const doc = parsed as {
    openapi?: string;
    servers?: Array<{ url?: string }>;
    security?: unknown;
    components?: { securitySchemes?: unknown; schemas?: unknown };
    paths?: Record<string, Record<string, unknown>>;
  };
  if (typeof doc.openapi !== 'string' || !/^3\.[01]\./.test(doc.openapi)) {
    throw new Error('import openapi: only OpenAPI 3.0 and 3.1 documents are supported');
  }
  const baseUrl =
    options.baseUrl ??
    (Array.isArray(doc.servers)
      ? doc.servers.find((server) => isRecord(server) && typeof server.url === 'string')?.url
      : undefined);
  if (baseUrl === undefined) throw new Error('import openapi: missing base URL; pass --base-url');
  try {
    const base = new URL(baseUrl);
    if (
      !['https:', 'http:'].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    )
      throw new Error();
  } catch {
    throw new Error(
      'import openapi: use an HTTP(S) base URL without credentials, query or fragment',
    );
  }

  const operations: OpenApiImportOperation[] = [];
  const warnings: string[] = [];
  const referencedSchemes: string[] = [];
  collectSecurityRefs(doc.security, referencedSchemes);
  if (!isRecord(doc.paths)) throw new Error('import openapi: paths must be an object');
  for (const [path, item] of Object.entries(doc.paths)) {
    if (
      !isRecord(item) ||
      !path.startsWith('/') ||
      path.startsWith('//') ||
      /[?#\p{Cc}]/u.test(path)
    ) {
      throw new Error(
        'import openapi: use path-item objects with relative paths and declared query parameters',
      );
    }
    for (const [method, rawOperation] of Object.entries(item)) {
      if (!METHODS.has(method)) continue;
      if (!isRecord(rawOperation))
        throw new Error('import openapi: each supported operation must be an object');
      const operation = rawOperation as {
        operationId?: unknown;
        parameters?: Array<{ name?: unknown; in?: unknown; required?: unknown; schema?: unknown }>;
        requestBody?: unknown;
        security?: unknown;
        responses?: unknown;
      };
      collectSecurityRefs(operation.security, referencedSchemes);
      const name = identifier(
        typeof operation.operationId === 'string' ? operation.operationId : `${method}_${path}`,
      );
      const { parameters, connectorPath } = importOperationParameters(
        path,
        item.parameters,
        operation.parameters,
      );
      const safeName = uniqueName(
        manifestIdentifier(name),
        new Set(operations.map((op) => op.safeName)),
      );
      const responseCtx: ImportResponseSchemaContext = {
        operationName: name,
        componentSchemas: isRecord(doc.components?.schemas) ? doc.components.schemas : {},
        warnings,
      };
      const output = importResponseSchema(operation.responses, responseCtx);
      const requestBody = importRequestBody(operation.requestBody, responseCtx);
      if (requestBody !== undefined && method === 'get') {
        throw new Error(
          'import openapi: GET request bodies require an explicitly authored mapping',
        );
      }
      if (requestBody !== undefined && parameters.some((param) => param.name === 'body')) {
        throw new Error(
          'import openapi: request body and parameter input-name collision; map the inputs explicitly',
        );
      }
      operations.push({
        name,
        safeName,
        method: method as OpenApiMethod,
        operationType: method === 'get' ? 'read' : 'action',
        path,
        // OpenAPI's `{name}` path params are already the connector runtime's template form; rewriting
        // them to `${args.name}` made catalog compilation reject the path (unsupported_path_expression).
        connectorPath,
        description: `Call ${method.toUpperCase()} ${path}.`,
        parameters,
        ...(requestBody === undefined ? {} : { requestBody }),
        query: parameters.filter((param) => param.in === 'query').map((param) => param.name),
        ...(output !== undefined ? { output } : {}),
      });
    }
  }
  if (operations.length === 0) throw new Error('import openapi: no supported operations found');
  const auth = resolveSecurityAuth(referencedSchemes, doc.components?.securitySchemes, warnings);
  return {
    connectorId: identifier(options.name),
    serverTitle: title(options.name),
    baseUrl,
    operations,
    ...(auth !== undefined ? { auth } : {}),
    secretRefs: auth !== undefined ? [auth.secret] : [],
    warnings,
  };
}

function collectSecurityRefs(security: unknown, referenced: string[]): void {
  if (!Array.isArray(security)) return;
  for (const requirement of security) {
    if (!isRecord(requirement)) continue;
    for (const name of Object.keys(requirement)) {
      if (!referenced.includes(name)) referenced.push(name);
    }
  }
}

function resolveSecurityAuth(
  referenced: readonly string[],
  securitySchemes: unknown,
  warnings: string[],
): OpenApiImportAuth | undefined {
  const schemes = isRecord(securitySchemes) ? securitySchemes : {};
  let auth: OpenApiImportAuth | undefined;
  for (const name of referenced) {
    const mapped = mapSecurityScheme(name, schemes[name]);
    if (mapped === undefined) {
      warnings.push(
        `security scheme "${name}" is not auto-mappable; configure the connector auth block manually if needed`,
      );
    } else if (auth === undefined) {
      auth = mapped;
      warnings.push(
        `security scheme "${name}" imported as connector auth with secret reference "${mapped.secret}"; set the value with configure_secret`,
      );
    } else {
      warnings.push(`security scheme "${name}" ignored; connector auth already mapped`);
    }
  }
  return auth;
}

function mapSecurityScheme(name: string, scheme: unknown): OpenApiImportAuth | undefined {
  if (!isRecord(scheme)) return undefined;
  const secret = manifestIdentifier(name).toUpperCase();
  if (scheme.type === 'apiKey' && scheme.in === 'header' && typeof scheme.name === 'string') {
    return { kind: 'apiKey', header: scheme.name, secret };
  }
  if (
    scheme.type === 'http' &&
    typeof scheme.scheme === 'string' &&
    scheme.scheme.toLowerCase() === 'bearer'
  ) {
    return { kind: 'bearer', secret };
  }
  return undefined;
}

export function renderOpenApiConnectorsYaml(ir: OpenApiImportIr): string {
  return `${YAML.stringify({
    connectors: [
      {
        id: ir.connectorId,
        version: '1.0.0',
        kind: 'custom',
        http: {
          baseUrl: ir.baseUrl,
          allowedOrigins: [new URL(ir.baseUrl).origin],
          ...(ir.auth !== undefined ? { auth: ir.auth } : {}),
        },
        operations: Object.fromEntries(
          ir.operations.map((operation) => [operation.safeName, connectorOperation(operation)]),
        ),
      },
    ],
  })}`;
}

export function renderOpenApiManifestYaml(ir: OpenApiImportIr): string {
  return `${YAML.stringify({
    manifestVersion: '1',
    server: {
      name: ir.connectorId,
      version: '1.0.0',
      title: ir.serverTitle,
    },
    connectors: {
      api: {
        id: ir.connectorId,
        version: '1.0.0',
      },
    },
    tools: ir.operations.map((operation) => ({
      name: operation.safeName,
      description: operation.description,
      inputSchema: inputSchema(operation),
      ...outputSchemaEntry(operation),
      fulfilment: {
        use: `api.${operation.safeName}`,
        args: inputArguments(operation),
      },
    })),
  })}`;
}

export function mergeOpenApiIntoDraft(
  input: MergeOpenApiIntoDraftInput,
): MergeOpenApiIntoDraftResult {
  const manifest = parseYamlObject(input.manifest, 'manifest');
  const connectorsDoc = parseYamlObject(input.connectors ?? 'connectors: []', 'connectors');
  const warnings = [...input.ir.warnings];

  if (manifest.connectors !== undefined && !isRecord(manifest.connectors)) {
    throw new Error('import openapi: manifest connectors must be a mapping');
  }
  const manifestConnectors = (manifest.connectors ?? {}) as Record<string, unknown>;
  manifest.connectors = manifestConnectors;
  const connectorAlias = uniqueName('api', new Set(Object.keys(manifestConnectors)));
  if (connectorAlias !== 'api') {
    warnings.push(`connector alias "api" already exists; imported as "${connectorAlias}"`);
  }

  const existingToolNames = new Set(
    Array.isArray(manifest.tools)
      ? manifest.tools
          .map((tool) => (isRecord(tool) && typeof tool.name === 'string' ? tool.name : undefined))
          .filter((name): name is string => name !== undefined)
      : [],
  );
  const tools = Array.isArray(manifest.tools) ? [...manifest.tools] : [];
  manifest.tools = tools;

  const connectors = normalizeConnectorList(connectorsDoc);
  const connectorIds = new Set(
    connectors
      .map((connector) => (typeof connector.id === 'string' ? connector.id : undefined))
      .filter((id): id is string => id !== undefined),
  );
  const connectorId = uniqueName(input.ir.connectorId, connectorIds);
  if (connectorId !== input.ir.connectorId) {
    warnings.push(
      `connector id "${input.ir.connectorId}" already exists; imported as "${connectorId}"`,
    );
  }

  const imported = parseYamlObject(renderOpenApiConnectorsYaml(input.ir), 'generated connectors');
  const importedConnector =
    Array.isArray(imported.connectors) && isRecord(imported.connectors[0])
      ? { ...imported.connectors[0] }
      : undefined;
  if (importedConnector === undefined) {
    throw new Error('import openapi: generated connector was empty');
  }
  importedConnector.id = connectorId;

  const operations = isRecord(importedConnector.operations)
    ? { ...importedConnector.operations }
    : {};
  importedConnector.operations = {};

  const addedTools: string[] = [];
  const addedOperations: string[] = [];
  for (const operation of input.ir.operations) {
    const operationName = uniqueName(operation.safeName, new Set(addedOperations));
    const toolName = uniqueName(operationName, existingToolNames);
    if (operationName !== operation.safeName) {
      warnings.push(`operation "${operation.safeName}" imported as "${operationName}"`);
    }
    if (toolName !== operationName) {
      warnings.push(`tool "${operationName}" already exists; imported as "${toolName}"`);
    }
    const operationDefinition = operations[operation.safeName];
    if (operationDefinition === undefined) continue;
    (importedConnector.operations as Record<string, unknown>)[operationName] = operationDefinition;
    tools.push({
      name: toolName,
      description: operation.description,
      inputSchema: inputSchema(operation),
      ...outputSchemaEntry(operation),
      fulfilment: {
        use: `${connectorAlias}.${operationName}`,
        args: inputArguments(operation),
      },
    });
    existingToolNames.add(toolName);
    addedTools.push(toolName);
    addedOperations.push(operationName);
  }

  connectors.push(importedConnector);
  manifestConnectors[connectorAlias] = { id: connectorId, version: '1.0.0' };

  return {
    manifest: YAML.stringify(manifest),
    connectors: YAML.stringify(connectorsDoc),
    addedTools,
    addedOperations,
    secretRefs: input.ir.secretRefs,
    warnings,
  };
}

export function title(value: string): string {
  return value.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function manifestIdentifier(value: string): string {
  const snake = value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  return /^[a-z0-9_]+$/.test(snake) && snake.length > 0 ? snake : 'operation';
}

function connectorOperation(operation: OpenApiImportOperation): Record<string, unknown> {
  return {
    type: operation.operationType,
    method: operation.method.toUpperCase(),
    path: operation.connectorPath,
    input: inputSchema(operation),
    ...(operation.requestBody === undefined ? {} : { request: '${args.body}' }),
    ...(operation.query.length > 0 ? { query: [...operation.query] } : {}),
    // The same lossless `{ value: <tree> }` object the tool outputSchema advertises; an untyped
    // operation keeps an open ({}) value subtree. Response mapping wraps the JSON body as `value`.
    output: {
      type: 'object',
      properties: {
        value: operation.output !== undefined ? toOutputJsonSchema(operation.output) : {},
      },
      required: ['value'],
      additionalProperties: false,
    },
    response: { value: '${response}' },
  };
}

function outputSchemaEntry(operation: OpenApiImportOperation): Record<string, unknown> {
  if (operation.output === undefined) return {};
  return {
    outputSchema: {
      type: 'object',
      properties: { value: toOutputJsonSchema(operation.output) },
      required: ['value'],
    },
  };
}

function inputSchema(operation: OpenApiImportOperation): Record<string, unknown> {
  const required = operation.parameters
    .filter((param) => param.required)
    .map((param) => param.name);
  if (operation.requestBody?.required) required.push('body');
  return {
    type: 'object',
    properties: {
      ...Object.fromEntries(
        operation.parameters.map((param) => [param.name, parameterSchemaJson(param.schema)]),
      ),
      ...(operation.requestBody === undefined
        ? {}
        : { body: toOutputJsonSchema(operation.requestBody.schema) }),
    },
    required,
    additionalProperties: false,
  };
}

function inputArguments(operation: OpenApiImportOperation): Record<string, string> {
  return Object.fromEntries([
    ...operation.parameters.map((param) => [param.name, `\${input.${param.name}}`]),
    ...(operation.requestBody === undefined ? [] : [['body', '${input.body}']]),
  ]);
}

/** A fresh plain-JSON copy of a parameter schema, safe to embed in YAML documents. */
function parameterSchemaJson(schema: OpenApiImportParameterSchema): Record<string, unknown> {
  return {
    type: typeof schema.type === 'string' ? schema.type : [...schema.type],
    ...(schema.enum !== undefined ? { enum: [...schema.enum] } : {}),
    ...(schema.format !== undefined ? { format: schema.format } : {}),
  };
}

function parseYamlObject(source: string, label: string): Record<string, unknown> {
  const parsed = YAML.parse(source);
  if (!isRecord(parsed)) throw new Error(`import openapi: ${label} YAML must be a mapping`);
  return parsed;
}

function normalizeConnectorList(doc: Record<string, unknown>): Record<string, unknown>[] {
  if (doc.connectors === undefined) {
    doc.connectors = [];
  }
  if (!Array.isArray(doc.connectors)) {
    throw new Error('import openapi: connectors YAML must contain a connectors array');
  }
  return doc.connectors as Record<string, unknown>[];
}

function uniqueName(base: string, existing: ReadonlySet<string>): string {
  if (!existing.has(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base}_${i}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error(`import openapi: could not find an available name for "${base}"`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
