import { createHash } from 'node:crypto';
import type {
  ArtifactConnectionSource,
  ArtifactFulfilment,
  ArtifactStep,
  ExprMap,
  JsonSchema,
  OperationRef,
} from './artifact/types.js';
import { computeSignatureHash } from './catalog/signature.js';
import type {
  CatalogConnector,
  ConnectorCatalog,
  OperationCredentialRequirement,
  OperationSignature,
} from './catalog/types.js';
import type { CustomerRoutingCollector, CustomerRoutingSurface } from './customer-routing.js';
import type { CompileError } from './errors.js';
import type { StructFulfilment, StructOp } from './fulfilment-structural.js';
import type { ExprNode } from './manifest/expression.js';
import { docAnchorFor, suggestionFields } from './suggest.js';

const JSON_SCHEMA_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

export interface DeclaredConnectorRef {
  readonly id: string;
  readonly version: string;
  readonly binding?: {
    readonly profile: string;
    readonly connection: { readonly id: string; readonly source: ArtifactConnectionSource };
  };
}

// ─── Connector resolution + emit ───────────────────────────────────────────────

export interface EmitFulfilmentOptions {
  readonly readOnly?: boolean;
  readonly confirmationRequired?: boolean;
  readonly customerRouting?: CustomerRoutingCollector;
  readonly surface?: CustomerRoutingSurface;
}

/** Build the artifact fulfilment, resolving each operation occurrence against the catalog (if any). */
export function emitFulfilment(
  struct: StructFulfilment,
  catalog: ConnectorCatalog | undefined,
  declared: Record<string, DeclaredConnectorRef>,
  usedAliases: Set<string>,
  errors: CompileError[],
  options: EmitFulfilmentOptions = {},
): ArtifactFulfilment {
  if (struct.kind === 'operation') {
    const operationRef = resolveOp(struct.op, catalog, declared, usedAliases, errors, options);
    return { kind: 'operation', operationRef, args: struct.op.args };
  }
  const steps: ArtifactStep[] = struct.steps.map((s) => {
    const cond = s.cond ? { if: s.cond } : {};
    if (s.kind === 'operation') {
      const operationRef = resolveOp(s.op, catalog, declared, usedAliases, errors, options);
      return { id: s.id, kind: 'operation', ...cond, operationRef, args: s.op.args };
    }
    if (s.kind === 'elicit') {
      return {
        id: s.id,
        kind: 'elicit',
        ...cond,
        message: s.message,
        requestedSchema: s.requestedSchema,
      };
    }
    return { id: s.id, kind: 'map', ...cond, value: s.value };
  });
  return { kind: 'flow', steps, output: struct.output };
}

/**
 * Resolve one operation occurrence against the catalog (docs/SPEC.md "Runtime Invariants"). Without a
 * catalog, returns an unresolved reference (shape-only). Pushes a CompileError per failure.
 */
function resolveOp(
  op: StructOp,
  catalog: ConnectorCatalog | undefined,
  declared: Record<string, DeclaredConnectorRef>,
  usedAliases: Set<string>,
  errors: CompileError[],
  options: EmitFulfilmentOptions,
): OperationRef {
  const unresolved: OperationRef = {
    connector: op.connectorAlias,
    operation: op.operation,
    resolved: false,
  };
  if (!catalog) return unresolved;
  usedAliases.add(op.connectorAlias);

  const connectorRef = declared[op.connectorAlias];
  if (!connectorRef) {
    errors.push({
      code: 'unknown_connector_alias',
      path: `${op.path}.use`,
      message: `connector alias "${op.connectorAlias}" is not declared in the "connectors" block`,
      got: op.connectorAlias,
      ...suggestionFields('unknown_connector_alias', op.connectorAlias, Object.keys(declared)),
    });
    return unresolved;
  }

  const connector = catalog.get(connectorRef.id, connectorRef.version);
  if (!connector) {
    errors.push({
      code: 'connector_not_in_catalog',
      path: `connectors.${op.connectorAlias}`,
      message: `connector "${connectorRef.id}" version "${connectorRef.version}" is not in the catalog`,
      expected: `a catalog entry for connector "${connectorRef.id}" version "${connectorRef.version}"`,
      got: `${connectorRef.id}@${connectorRef.version}`,
      docAnchor: docAnchorFor('connector_not_in_catalog'),
    });
    return unresolved;
  }

  const operation = connector.operations[op.operation];
  if (!operation) {
    errors.push({
      code: 'unknown_operation',
      path: `${op.path}.use`,
      message: `operation "${op.operation}" does not exist on connector "${connector.id}" version "${connector.version}"`,
      got: op.operation,
      ...suggestionFields('unknown_operation', op.operation, Object.keys(connector.operations)),
    });
    return unresolved;
  }

  const customerOperationRouting = options.customerRouting?.recordOperation(
    op.connectorAlias,
    connectorRef,
    connector,
    op.operation,
    `${op.path}.use`,
    options.surface ?? 'tool',
    options.confirmationRequired === true,
  );

  validateCredentialRequirement(op, connectorRef, connector, errors);

  if (options.readOnly === true && operation.type !== 'read') {
    errors.push({
      code: 'ambient_context_action',
      path: `${op.path}.use`,
      message: `ambient context providers may call read-only operations only; "${op.connectorAlias}.${op.operation}" is an action`,
      expected: 'read',
      got: operation.type,
    });
  }

  checkArgs(op.args, connector, op.operation, operation, `${op.path}.args`, errors);
  const credentialRequirement = connector.operationCredentials?.[op.operation];
  const credentialPresentation =
    connectorRef.binding === undefined
      ? undefined
      : connector.credentialProfiles?.[connectorRef.binding.profile];

  return {
    alias: op.connectorAlias,
    connectorId: connector.id,
    connectorVersion: connector.version,
    operation: op.operation,
    signatureHash: computeSignatureHash(op.operation, operation),
    ...(customerOperationRouting?.directEndpoint === undefined
      ? {}
      : { customerEndpoint: customerOperationRouting.directEndpoint }),
    ...(customerOperationRouting === undefined
      ? {}
      : { customerEndpointDependencies: customerOperationRouting.dependencies }),
    ...(customerOperationRouting === undefined ||
    customerOperationRouting.actionDependencies.length === 0
      ? {}
      : {
          customerActionEndpointDependencies: customerOperationRouting.actionDependencies,
        }),
    ...(connectorRef.binding === undefined || credentialPresentation === undefined
      ? {}
      : {
          credentialBinding: {
            bindingId: op.connectorAlias,
            connectionId: connectorRef.binding.connection.id,
            connectionConfigRevision: computeConnectionConfigRevision(
              connectorRef.binding.connection,
            ),
            profile: connectorRef.binding.profile,
            presentation: credentialPresentation,
            requiredScopes: [...(credentialRequirement?.scopes ?? [])],
            ...(credentialRequirement?.audience === undefined
              ? {}
              : { requiredAudience: credentialRequirement.audience }),
          },
        }),
    resolved: true,
  };
}

export function computeConnectionConfigRevision(connection: {
  readonly id: string;
  readonly source: ArtifactConnectionSource;
}): string {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.keys(value as Record<string, unknown>)
          .sort()
          .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]),
      );
    }
    return value;
  };
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(canonicalize(connection)))
    .digest('hex')}`;
}

function validateCredentialRequirement(
  op: StructOp,
  connectorRef: DeclaredConnectorRef,
  connector: CatalogConnector,
  errors: CompileError[],
): void {
  const requirement = connector.operationCredentials?.[op.operation];
  const binding = connectorRef.binding;
  if (requirement !== undefined && binding === undefined) {
    errors.push({
      code: 'connector_binding_required',
      path: `connectors.${op.connectorAlias}`,
      message: `operation "${connector.id}.${op.operation}" requires a credential binding`,
      expected: requirement.profiles.join(', '),
    });
    return;
  }
  if (binding === undefined) return;

  const declaredProfile = connector.credentialProfiles?.[binding.profile];
  const accepted = requirement?.profiles ?? Object.keys(connector.credentialProfiles ?? {});
  if (declaredProfile === undefined || !accepted.includes(binding.profile)) {
    errors.push({
      code: 'unsupported_credential_profile',
      path: `connectors.${op.connectorAlias}.binding.profile`,
      message: `credential profile "${binding.profile}" is not supported by operation "${connector.id}.${op.operation}"`,
      expected: accepted.join(', '),
      got: binding.profile,
    });
    return;
  }

  if (
    binding.connection.source.kind === 'googleWorkloadIdentity' &&
    declaredProfile.kind !== 'bearer'
  ) {
    errors.push({
      code: 'unsupported_credential_profile',
      path: `connectors.${op.connectorAlias}.binding.profile`,
      message: `Google workload identity requires a bearer credential profile for operation "${connector.id}.${op.operation}"`,
      expected: 'bearer',
      got: declaredProfile.kind,
    });
    return;
  }

  validateConnectionCapabilities(op, binding.connection.source, requirement, errors);
}

function validateConnectionCapabilities(
  op: StructOp,
  source: ArtifactConnectionSource,
  requirement: OperationCredentialRequirement | undefined,
  errors: CompileError[],
): void {
  if (source.kind === 'googleWorkloadIdentity') {
    const requiredScopes = requirement?.scopes ?? [];
    const googleScopes = requiredScopes.filter((scope) =>
      scope.startsWith('https://www.googleapis.com/auth/'),
    );
    if (requiredScopes.length === 0 || googleScopes.length !== requiredScopes.length) {
      errors.push({
        code: 'credential_scope_mismatch',
        path: `connectors.${op.connectorAlias}.binding.connection.source.scopes`,
        message: `Google workload identity requires operation "${op.operation}" to declare Google OAuth scopes`,
        expected: 'one or more https://www.googleapis.com/auth/... scopes',
        ...(requiredScopes.length > 0 ? { got: requiredScopes.join(', ') } : {}),
      });
    }

    if (requirement?.audience !== undefined && !isGoogleApiOrigin(requirement.audience)) {
      errors.push({
        code: 'credential_audience_mismatch',
        path: `connectors.${op.connectorAlias}.binding.connection.source.audience`,
        message: `Google workload identity requires operation "${op.operation}" to declare a Google API HTTPS origin`,
        expected: 'an https://*.googleapis.com origin',
        got: requirement.audience,
      });
    }
    return;
  }

  if (requirement === undefined || source.kind === 'externalExchange') return;

  const requiredScopes = requirement.scopes ?? [];
  const declaredScopes = source.scopes ?? [];
  const missingScopes = requiredScopes.filter((scope) => !declaredScopes.includes(scope));
  if (missingScopes.length > 0) {
    errors.push({
      code: 'credential_scope_mismatch',
      path: `connectors.${op.connectorAlias}.binding.connection.source.scopes`,
      message: `connection source does not declare every scope required by operation "${op.operation}"`,
      expected: requiredScopes.join(', '),
      ...(declaredScopes.length > 0 ? { got: declaredScopes.join(', ') } : {}),
    });
  }

  if (requirement.audience !== undefined && source.audience !== requirement.audience) {
    errors.push({
      code: 'credential_audience_mismatch',
      path: `connectors.${op.connectorAlias}.binding.connection.source.audience`,
      message: `connection source audience does not match the audience required by operation "${op.operation}"`,
      expected: requirement.audience,
      ...(source.audience !== undefined ? { got: source.audience } : {}),
    });
  }
}

function isGoogleApiOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === '' &&
      (url.hostname === 'googleapis.com' || url.hostname.endsWith('.googleapis.com'))
    );
  } catch {
    return false;
  }
}

/**
 * Check parsed `args` against an operation's input schema (docs/SPEC.md line 165, ADR 0139):
 * reject argument keys the schema's closed object does not declare, require every `required`
 * property, and — where statically possible — reject a literal/template value whose primitive type
 * (or shallow `const`/`enum` membership) does not match the property schema. Validation is
 * top-level only; richer keywords are carried for compatibility hashing and host-facing schemas
 * but not enforced here. Argument *path* expressions are not type-inferred (deferred).
 */
function checkArgs(
  args: ExprMap,
  connector: CatalogConnector,
  opName: string,
  operation: OperationSignature,
  argsPathPrefix: string,
  errors: CompileError[],
): void {
  const properties = schemaProperties(operation.input);
  const declared = Object.keys(properties);
  const open =
    operation.input.additionalProperties === true ||
    (typeof operation.input.additionalProperties === 'object' &&
      operation.input.additionalProperties !== null);

  for (const [key, node] of Object.entries(args)) {
    const property = properties[key];
    if (property === undefined || property === false) {
      if (open && property === undefined) continue;
      errors.push({
        code: 'arg_mismatch',
        path: `${argsPathPrefix}.${key}`,
        message: `operation "${connector.id}.${opName}" does not accept argument "${key}"`,
        got: key,
        expected: declared.join(', '),
        ...suggestionFields('arg_mismatch', key, declared),
      });
      continue;
    }
    if (property === true || typeof property !== 'object') continue;
    const propertySchema = property as JsonSchema;
    const got = primitiveType(node);
    if (!got) continue;
    const constMismatch = literalConstMismatch(node, propertySchema);
    if (constMismatch) {
      errors.push({
        code: 'arg_type_mismatch',
        path: `${argsPathPrefix}.${key}`,
        message: `argument "${key}" expects ${constMismatch} but got ${formatLiteral(node)}`,
        expected: constMismatch,
        got: formatLiteral(node),
        docAnchor: docAnchorFor('arg_type_mismatch'),
      });
      continue;
    }
    const expected = propertySchema.type;
    if (
      (typeof expected === 'string' || isStringArray(expected)) &&
      !typeMatches(node, got, expected)
    ) {
      const expectedLabel = Array.isArray(expected) ? expected.join(' | ') : expected;
      errors.push({
        code: 'arg_type_mismatch',
        path: `${argsPathPrefix}.${key}`,
        message: `argument "${key}" expects ${expectedLabel} but got ${got}`,
        expected: expectedLabel,
        got,
        docAnchor: docAnchorFor('arg_type_mismatch'),
      });
    }
  }

  const required = isStringArray(operation.input.required) ? operation.input.required : [];
  for (const field of required) {
    if (!(field in args)) {
      errors.push({
        code: 'arg_mismatch',
        path: `${argsPathPrefix}.${field}`,
        message: `operation "${connector.id}.${opName}" requires argument "${field}"`,
        expected: field,
        docAnchor: docAnchorFor('arg_mismatch'),
      });
    }
  }
}

/** The `properties` map of an object schema (empty when absent or malformed). */
function schemaProperties(schema: JsonSchema): Record<string, unknown> {
  const properties = schema.properties;
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) return {};
  return properties as Record<string, unknown>;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/**
 * When a literal argument violates a shallow `const`/`enum` on its property schema, return the
 * expected-value label; otherwise `null`. Only scalar literals are checkable statically.
 */
function literalConstMismatch(node: ExprNode, property: JsonSchema): string | null {
  if (node.kind !== 'literal') return null;
  const value = node.value;
  if (property.const !== undefined) {
    return Object.is(property.const, value) ? null : JSON.stringify(property.const);
  }
  if (Array.isArray(property.enum)) {
    return property.enum.some((entry) => Object.is(entry, value))
      ? null
      : `one of ${JSON.stringify(property.enum)}`;
  }
  return null;
}

/** Render a literal node for an error message. */
function formatLiteral(node: ExprNode): string {
  return node.kind === 'literal' ? JSON.stringify(node.value) : 'template string';
}

/** The statically-known primitive type of a value node, or `null` when it cannot be determined. */
function primitiveType(node: ExprNode): 'string' | 'number' | 'boolean' | null {
  if (node.kind === 'template') return 'string';
  if (node.kind === 'literal') {
    if (typeof node.value === 'string') return 'string';
    if (typeof node.value === 'number') return 'number';
    if (typeof node.value === 'boolean') return 'boolean';
  }
  return null; // path (deferred inference) or literal null (nullable)
}

/** Whether a known primitive type satisfies a JSON Schema `type` (a scalar or a union array). */
function typeMatches(
  node: ExprNode,
  got: 'string' | 'number' | 'boolean',
  fieldType: string | readonly string[],
): boolean {
  if (Array.isArray(fieldType)) {
    return fieldType.some((entry) => typeMatches(node, got, entry));
  }
  if (got === 'number') {
    if (fieldType === 'integer') {
      return (
        node.kind === 'literal' && typeof node.value === 'number' && Number.isInteger(node.value)
      );
    }
    return fieldType === 'number';
  }
  return got === fieldType;
}

/** Ensure an emitted tool schema advertises the JSON Schema 2020-12 dialect. */
export function withDialect(schema: JsonSchema): JsonSchema {
  if (typeof schema.$schema === 'string') return schema;
  return { $schema: JSON_SCHEMA_2020_12, ...schema };
}
