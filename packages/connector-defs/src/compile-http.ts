import {
  type CatalogConnector,
  type ExprNode,
  type JsonSchema,
  normalizeOperationIoSchema,
  type OperationSignature,
} from '@noodle-borg/compiler';
import {
  HttpConnector,
  type HttpConnectorConfig,
  type HttpOperation,
  type HttpOperationFake,
  type HttpOperationPagination,
  type HttpOperationProjection,
} from '@noodle-borg/connector-http';
import { type Connector, evaluateValue } from '@noodle-borg/runtime';
import { collectVariablesFromHttpAuth } from './auth-variables.js';
import type { SecretBinding } from './compile.js';
import { addAuthBinding, toAuthScheme } from './compile-auth.js';
import {
  type ArgsRecord,
  type ConnectorCompileError,
  compileExpr,
  compileExprMap,
  evalMap,
  type OutputRecord,
} from './compile-expr.js';
import { catalogCredentialMetadata } from './credential-profiles.js';
import { toHeaderRecord, validateHeaderNames } from './http-headers.js';
import type { HttpAuthDef, HttpConnectorDef, HttpOperationDef } from './schema.js';
import {
  collectVariableExpression,
  collectVariablesFromExpr,
  collectVariablesFromExprMap,
  isVariableExpression,
} from './variables.js';

type RequestAst =
  | { readonly kind: 'value'; readonly node: ExprNode }
  | { readonly kind: 'map'; readonly map: Record<string, ExprNode> };

const REQUEST_ROOTS: ReadonlySet<string> = new Set(['args', 'env']);
const RESPONSE_ROOTS: ReadonlySet<string> = new Set(['args', 'response']);
const PROJECTION_ROOTS: ReadonlySet<string> = new Set(['args', 'response', 'output']);
const PAGINATION_ROOTS: ReadonlySet<string> = RESPONSE_ROOTS;

/** Compile one HTTP connector: signatures into the catalog, a runnable `HttpConnector` with `${...}` mapping. */
export function compileHttpConnector(
  def: HttpConnectorDef,
  mode: 'live' | 'fake',
  errors: ConnectorCompileError[],
  catalog: CatalogConnector[],
  connectors: Connector[],
  secretBindings: SecretBinding[],
  variableBindings: Set<string>,
): void {
  const operations: Record<string, HttpOperation> = {};
  const signatures: Record<string, OperationSignature> = {};
  const customerEndpoint = typeof def.http.baseUrl === 'string' ? undefined : def.http.baseUrl.name;
  const routedBase = customerEndpoint !== undefined;
  const stringBase = typeof def.http.baseUrl === 'string' ? def.http.baseUrl : undefined;
  const allowedOrigins =
    def.http.allowedOrigins ??
    (stringBase === undefined || isVariableExpression(stringBase) ? [] : [stringBase]);
  if (stringBase !== undefined) collectVariableExpression(stringBase, variableBindings);
  for (const origin of allowedOrigins) collectVariableExpression(origin, variableBindings);
  if (def.http.auth !== undefined) collectVariablesFromHttpAuth(def.http.auth, variableBindings);
  if (routedBase) {
    if (def.http.allowedOrigins !== undefined) {
      errors.push({
        code: 'customer_endpoint_allowed_origins',
        path: `connectors.${def.id}.http.allowedOrigins`,
        message: 'customer endpoint connectors derive egress authority from their endpoint policy',
      });
    }
    validateCustomerEndpointAuth(def.http.auth, `connectors.${def.id}.http.auth`, errors);
  }
  if (
    stringBase !== undefined &&
    isVariableExpression(stringBase) &&
    def.http.allowedOrigins === undefined
  ) {
    errors.push({
      code: 'variable_base_url_requires_allowed_origins',
      path: `connectors.${def.id}.http.allowedOrigins`,
      message: 'http.allowedOrigins is required when http.baseUrl is a managed variable',
    });
  }

  for (const [opName, op] of Object.entries(def.operations)) {
    const base = `connectors.${def.id}.operations.${opName}`;
    if (op.type === 'action' && op.resilience?.retry !== undefined) {
      errors.push({
        code: 'unsafe_retry_action',
        path: `${base}.resilience.retry`,
        message:
          'retry resilience is only supported for read operations until idempotency keys land',
      });
    }
    if (op.type === 'action' && op.pagination !== undefined) {
      errors.push({
        code: 'unsafe_pagination_action',
        path: `${base}.pagination`,
        message: 'pagination is only supported for read operations',
      });
    }
    if (
      op.responseType !== undefined &&
      op.responseType !== 'json' &&
      op.pagination !== undefined
    ) {
      errors.push({
        code: 'non_json_response_pagination',
        path: `${base}.pagination`,
        message:
          'non-JSON response modes are incompatible with pagination, which needs JSON item arrays',
      });
    }
    if (op.path.includes('${')) {
      // The runtime only substitutes `{name}` placeholders; a `${...}` expression would be sent as
      // URL-encoded literal text. The authoring SDK compiles `${args.name}` to `{name}` before this.
      errors.push({
        code: 'unsupported_path_expression',
        path: `${base}.path`,
        message:
          'HTTP paths take {name} placeholders (authored as ${args.name}); other ${...} expressions are not supported in a path',
      });
    }
    validateFakeShape(op, `${base}.fake`, errors);
    const signature = toSignature(op.type, op.input, op.output);
    signatures[opName] = signature;

    const requestAst = compileRequest(op.request, `${base}.request`, errors);
    if (requestAst?.kind === 'value') collectVariablesFromExpr(requestAst.node, variableBindings);
    if (requestAst?.kind === 'map') collectVariablesFromExprMap(requestAst.map, variableBindings);
    if (op.auth !== undefined) collectVariablesFromHttpAuth(op.auth, variableBindings);
    if (routedBase) validateCustomerEndpointAuth(op.auth, `${base}.auth`, errors);
    const responseAst = op.response
      ? compileExprMap(op.response, RESPONSE_ROOTS, `${base}.response`, errors)
      : undefined;
    // Headers use the same roots as the request body (args + env), so a runtime value threaded through
    // args can be attached as dynamic, non-credential request metadata.
    validateHeaderNames(op.headers, `${base}.headers`, errors);
    const headersAst = op.headers
      ? compileExprMap(op.headers, REQUEST_ROOTS, `${base}.headers`, errors)
      : undefined;
    if (headersAst !== undefined) collectVariablesFromExprMap(headersAst, variableBindings);

    const pagination = compilePagination(op, `${base}.pagination`, errors);
    const projection = compileProjection(op, `${base}.projection`, errors);
    const fake = httpFake(op.fake);

    operations[opName] = buildOperation(
      op,
      signature,
      requestAst,
      responseAst,
      headersAst,
      pagination,
      fake,
      projection,
    );
    // Per-operation auth declares its own secret reference (overrides any connector-level default).
    addAuthBinding({
      auth: op.auth,
      connectorId: def.id,
      connectorVersion: def.version,
      operation: opName,
      ...(customerEndpoint === undefined ? {} : { customerEndpoint }),
      path: `${base}.auth`,
      allowedOrigins,
      ...(routedBase ? { independentTokenOrigin: true } : {}),
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

  // Connector-level default auth binds every operation that doesn't carry its own scheme.
  addAuthBinding({
    auth: def.http.auth,
    connectorId: def.id,
    connectorVersion: def.version,
    ...(customerEndpoint === undefined ? {} : { customerEndpoint }),
    path: `connectors.${def.id}.http.auth`,
    allowedOrigins,
    ...(routedBase ? { independentTokenOrigin: true } : {}),
    secretBindings,
    errors,
  });

  const config: HttpConnectorConfig = {
    id: def.id,
    version: def.version,
    baseUrl: def.http.baseUrl,
    ...(def.http.allowedOrigins ? { allowedOrigins: def.http.allowedOrigins } : {}),
    ...(def.http.auth ? { auth: toAuthScheme(def.http.auth) } : {}),
    ...(mode === 'fake' ? { fakeMode: true } : {}),
    operations,
  };
  connectors.push(new HttpConnector(config));
}

function validateCustomerEndpointAuth(
  auth: HttpAuthDef | undefined,
  path: string,
  errors: ConnectorCompileError[],
): void {
  if (auth === undefined) return;
  if (auth.kind !== 'delegatedTokenExchange') {
    errors.push({
      code: 'customer_endpoint_unsupported_auth',
      path,
      message: `customer endpoint connectors accept only no auth or delegatedTokenExchange auth; found ${auth.kind} auth at this path, so remove it or replace it with delegatedTokenExchange`,
    });
    return;
  }
  if (!isFixedHttpsUrl(auth.tokenUrl)) {
    errors.push({
      code: 'customer_endpoint_invalid_token_url',
      path: `${path}.tokenUrl`,
      message:
        'customer endpoint delegated token exchange requires a fixed absolute HTTPS token URL',
    });
  }
}

function isFixedHttpsUrl(value: string): boolean {
  if (
    value !== value.trim() ||
    /[\p{Cc}\\]/u.test(value) ||
    value.includes('${') ||
    !/^https:\/\/[^/?#\\]+(?:[/?#]|$)/iu.test(value)
  ) {
    return false;
  }
  const authority = value.slice('https://'.length).split(/[/?#]/u, 1)[0] ?? '';
  if (authority.includes('@') || value.includes('?') || value.includes('#')) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

function validateFakeShape(
  op: HttpOperationDef,
  path: string,
  errors: ConnectorCompileError[],
): void {
  if (op.fake === undefined) return;
  if ('pages' in op.fake && op.pagination === undefined) {
    errors.push({
      code: 'fake_pages_without_pagination',
      path: `${path}.pages`,
      message: 'fake.pages is only supported on paginated operations',
    });
  }
  if ('response' in op.fake && op.pagination !== undefined) {
    errors.push({
      code: 'fake_response_for_paginated_operation',
      path: `${path}.response`,
      message: 'paginated operations must use fake.pages so continuation behavior is explicit',
    });
  }
}

/**
 * Build an `OperationSignature` from the declared type and input/output schemas. The parse boundary
 * (`ioSchema`) already normalized declared values; omitted ones normalize to the closed-empty
 * object here (ADR 0139).
 */
export function toSignature(
  type: 'read' | 'action',
  input: JsonSchema | undefined,
  output: JsonSchema | undefined,
): OperationSignature {
  return {
    type,
    input: normalizeOperationIoSchema(input),
    output: normalizeOperationIoSchema(output),
  };
}

function compileRequest(
  request: unknown,
  path: string,
  errors: ConnectorCompileError[],
): RequestAst | undefined {
  if (request === undefined) return undefined;
  return isRecord(request) && !Array.isArray(request)
    ? { kind: 'map', map: compileExprMap(request, REQUEST_ROOTS, path, errors) }
    : { kind: 'value', node: compileExpr(request, REQUEST_ROOTS, path, errors) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function buildOperation(
  op: HttpOperationDef,
  signature: OperationSignature,
  requestAst: RequestAst | undefined,
  responseAst: Record<string, ExprNode> | undefined,
  headersAst: Record<string, ExprNode> | undefined,
  pagination: HttpOperationPagination | undefined,
  fake: HttpOperationFake | undefined,
  projection: HttpOperationProjection | undefined,
): HttpOperation {
  const resilience = httpResilience(op.resilience);
  return {
    method: op.method ?? 'GET',
    path: op.path,
    ...(op.query ? { query: op.query } : {}),
    signature,
    ...(op.auth ? { auth: toAuthScheme(op.auth) } : {}),
    ...(resilience !== undefined ? { resilience } : {}),
    ...(pagination !== undefined ? { pagination } : {}),
    ...(fake !== undefined ? { fake } : {}),
    ...(projection !== undefined ? { projection } : {}),
    ...(op.limits !== undefined ? { maxResponseBytes: op.limits.maxResponseBytes } : {}),
    ...(op.responseType !== undefined ? { responseType: op.responseType } : {}),
    ...(op.requestEncoding !== undefined ? { requestEncoding: op.requestEncoding } : {}),
    ...(requestAst
      ? {
          body: (args, env) =>
            requestAst.kind === 'map'
              ? evalMap(requestAst.map, { args, env })
              : evaluateValue(requestAst.node, { args, env }, 'request'),
        }
      : {}),
    ...(responseAst
      ? { mapResponse: (json: unknown, args) => evalMap(responseAst, { args, response: json }) }
      : {}),
    ...(headersAst
      ? { headers: (args, env) => toHeaderRecord(evalMap(headersAst, { args, env })) }
      : {}),
  };
}

function compileProjection(
  op: HttpOperationDef,
  path: string,
  errors: ConnectorCompileError[],
): HttpOperationProjection | undefined {
  const projection = op.projection;
  if (projection === undefined) return undefined;
  const widgetMetaAst = projection.widgetMeta
    ? compileExprMap(projection.widgetMeta, PROJECTION_ROOTS, `${path}.widgetMeta`, errors)
    : undefined;
  const timestampAst =
    projection.freshness?.timestamp !== undefined
      ? compileExpr(
          projection.freshness.timestamp,
          PROJECTION_ROOTS,
          `${path}.freshness.timestamp`,
          errors,
        )
      : undefined;
  return {
    ...(projection.hiddenFields !== undefined ? { hiddenFields: projection.hiddenFields } : {}),
    ...(projection.sourceLabel !== undefined ? { sourceLabel: projection.sourceLabel } : {}),
    ...(widgetMetaAst
      ? {
          widgetMeta: (json: unknown, args: ArgsRecord, output: OutputRecord) =>
            evalMap(widgetMetaAst, { args, response: json, output }),
        }
      : {}),
    ...(projection.freshness !== undefined
      ? {
          freshness: {
            ttlMs: projection.freshness.ttlMs,
            ...(timestampAst !== undefined
              ? {
                  timestamp: (json: unknown, args: ArgsRecord, output: OutputRecord) =>
                    evaluateValue(
                      timestampAst,
                      { args, response: json, output },
                      `${path}.freshness.timestamp`,
                    ),
                }
              : {}),
          },
        }
      : {}),
  };
}

function httpFake(fake: HttpOperationDef['fake']): HttpOperationFake | undefined {
  if (fake === undefined) return undefined;
  if ('pages' in fake) return { pages: fake.pages };
  return { response: fake.response };
}

function compilePagination(
  op: HttpOperationDef,
  path: string,
  errors: ConnectorCompileError[],
): HttpOperationPagination | undefined {
  const pagination = op.pagination;
  if (pagination === undefined) return undefined;
  const items = compileExpr(pagination.items, PAGINATION_ROOTS, `${path}.items`, errors);
  if (pagination.kind === 'cursor') {
    const nextCursor = compileExpr(
      pagination.nextCursor,
      PAGINATION_ROOTS,
      `${path}.nextCursor`,
      errors,
    );
    return {
      kind: 'cursor',
      cursorParam: pagination.cursorParam,
      items: (json, args) => evaluateValue(items, { args, response: json }, `${path}.items`),
      nextCursor: (json, args) =>
        evaluateValue(nextCursor, { args, response: json }, `${path}.nextCursor`),
      ...(pagination.maxPages !== undefined ? { maxPages: pagination.maxPages } : {}),
      ...(pagination.maxItems !== undefined ? { maxItems: pagination.maxItems } : {}),
    };
  }
  const hasMore = compileExpr(pagination.hasMore, PAGINATION_ROOTS, `${path}.hasMore`, errors);
  return {
    kind: 'pageNumber',
    pageParam: pagination.pageParam,
    ...(pagination.startPage !== undefined ? { startPage: pagination.startPage } : {}),
    items: (json, args) => evaluateValue(items, { args, response: json }, `${path}.items`),
    hasMore: (json, args) => evaluateValue(hasMore, { args, response: json }, `${path}.hasMore`),
    ...(pagination.maxPages !== undefined ? { maxPages: pagination.maxPages } : {}),
    ...(pagination.maxItems !== undefined ? { maxItems: pagination.maxItems } : {}),
  };
}

function httpResilience(op: HttpOperationDef['resilience']): HttpOperation['resilience'] {
  if (op === undefined) return undefined;
  return {
    ...(op.timeoutMs !== undefined ? { timeoutMs: op.timeoutMs } : {}),
    ...(op.retry !== undefined
      ? {
          retry: {
            ...(op.retry.maxAttempts !== undefined ? { maxAttempts: op.retry.maxAttempts } : {}),
            ...(op.retry.baseDelayMs !== undefined ? { baseDelayMs: op.retry.baseDelayMs } : {}),
            ...(op.retry.maxDelayMs !== undefined ? { maxDelayMs: op.retry.maxDelayMs } : {}),
            ...(op.retry.backoffMultiplier !== undefined
              ? { backoffMultiplier: op.retry.backoffMultiplier }
              : {}),
            ...(op.retry.retryOn !== undefined ? { retryOn: op.retry.retryOn } : {}),
          },
        }
      : {}),
  };
}
