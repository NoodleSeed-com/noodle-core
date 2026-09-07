import {
  type CatalogConnector,
  computeSignatureHash,
  type OperationSignature,
  type ResolvedOperationRef,
} from '@noodle-borg/compiler';
import {
  CodeConnector,
  type CodeOperation,
  type ComputeLimits,
  DEFAULT_LIMITS,
  QuickJsComputeEngine,
} from '@noodle-borg/compute';
import type { Connector } from '@noodle-borg/runtime';
import { parse as parseYaml } from 'yaml';
import { validateComputeCallGraph } from './call-graph.js';
import type { ConnectorCompileError } from './compile-expr.js';
import { compileHttpConnector, toSignature } from './compile-http.js';
import { compileMcpConnector } from './compile-mcp.js';
import { catalogCredentialMetadata } from './credential-profiles.js';
import { collectCatalogCustomerRouting } from './customer-routing.js';
import { connectorIdentityKey } from './identity-key.js';
import type { ComputeConnectorDef, ComputeOperationDef, ConnectorDef } from './schema.js';
import { connectorFileSchema } from './schema.js';

// Expression helpers and the compile-error type live in `compile-expr.ts`; re-export the error type so the
// package's public surface (via `index.ts`) is unchanged.
export type { ConnectorCompileError } from './compile-expr.js';

/**
 * A binding from a connector operation to the *named* secret its auth scheme needs. It carries the
 * reference only — never a value. The deploy plane joins these with out-of-band secret values to build a
 * credential broker; the runtime and the operation signature never see auth or secret refs.
 */
export interface SecretBinding {
  readonly connectorId: string;
  readonly connectorVersion: string;
  /** `undefined` => the connector-level default auth (applies to any op without its own scheme). */
  readonly operation?: string;
  /** Private deploy-plane route key for a customer-derived HTTP base URL; never a resolved URL. */
  readonly customerEndpoint?: string;
  readonly secretRef?: string;
  readonly authKind?:
    | 'static'
    | 'clientCredentials'
    | 'delegatedOAuth'
    | 'delegatedSessionCookie'
    | 'delegatedTokenExchange';
  readonly clientCredentials?: ClientCredentialsBinding;
  readonly delegated?: DelegatedOAuthBinding;
  readonly tokenExchange?: DelegatedTokenExchangeBinding;
}

/**
 * Deploy-plane metadata for a `clientCredentials` auth scheme. `profile: 'oauth2'` uses the RFC-6749
 * grant (`authMethod` applies); `profile: 'custom'` carries a {@link ClientCredentialsCustomBinding}
 * describing a non-standard token endpoint. The broker joins this with the resolved client secret.
 */
export interface ClientCredentialsBinding {
  readonly profile: 'oauth2' | 'custom';
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly scopes?: readonly string[];
  readonly audience?: string;
  readonly authMethod?: 'client_secret_basic' | 'client_secret_post';
  readonly custom?: ClientCredentialsCustomBinding;
}

export interface ClientCredentialsCustomBinding {
  readonly requestFormat: 'json' | 'form';
  readonly clientIdField: string;
  readonly clientSecretField: string;
  readonly tokenResponsePath: string;
  readonly expirySource: readonly ('jwt' | 'expiresIn' | 'expiresAt')[];
  readonly fallbackTtlSeconds: number;
}

/**
 * Deploy-plane metadata for a `delegatedTokenExchange` auth scheme (ADR 0152): the broker signs a
 * short-lived platform user assertion and performs an RFC 8693 token exchange against the customer's
 * own token endpoint. The client secret arrives via the binding's `secretRef`.
 */
export interface DelegatedTokenExchangeBinding {
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly scopes?: readonly string[];
  readonly audience?: string;
  readonly authMethod: 'client_secret_basic' | 'client_secret_post';
}

export interface DelegatedOAuthBinding {
  readonly provider: string;
  readonly tokenUrl?: string;
  readonly clientId?: string;
  readonly scopes?: readonly string[];
  readonly authMethod?: 'client_secret_basic' | 'client_secret_post';
  readonly sessionUrl?: string;
  readonly tokenField?: string;
}

export type CompileConnectorsResult =
  | {
      readonly ok: true;
      readonly catalog: CatalogConnector[];
      readonly connectors: Connector[];
      /** Secret references declared by connector auth schemes; empty when no connector declares auth. */
      readonly secretBindings: SecretBinding[];
      /** Managed variables referenced by connector transport or request mappings. */
      readonly variableBindings: readonly string[];
    }
  | { readonly ok: false; readonly errors: ConnectorCompileError[] };

export interface CompileConnectorsOptions {
  readonly mode?: 'live' | 'fake';
}

/**
 * Compile a declarative connector-catalog document (YAML or JSON) into:
 *   - `catalog`: `CatalogConnector[]` — operation signatures fed to the manifest compiler's catalog so
 *     signature-hash resolution is unchanged; and
 *   - `connectors`: `Connector[]` — the runnable connectors. An **HTTP** connector maps request/response
 *     with the declared `${...}` expressions; a **compute** connector runs sandboxed JavaScript through
 *     `@noodle-borg/compute` (ADR 0004 / ADR 0014). Both are plain `Connector`s, so the runtime resolves
 *     and invokes them identically; and
 *   - `secretBindings`: the named secret references declared by HTTP connector `auth` schemes (ADR 0015).
 *     They carry references only — never values — for the deploy plane to join with out-of-band secrets.
 *
 * A compute connector may call declared catalog operations only through the runtime-supplied host ABI
 * ([ADR 0004](../../../docs/decisions/0004-code-as-sandboxed-connector.md) `callOperation`).
 */
export function compileConnectors(
  source: string,
  options: CompileConnectorsOptions = {},
): CompileConnectorsResult {
  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (error) {
    return {
      ok: false,
      errors: [{ code: 'invalid_yaml', path: '', message: (error as Error).message }],
    };
  }

  const parsed = connectorFileSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({
        code: 'invalid_connector',
        path: issue.path.join('.'),
        message: issue.message,
      })),
    };
  }

  const errors: ConnectorCompileError[] = [];
  const catalog: CatalogConnector[] = [];
  const connectors: Connector[] = [];
  const secretBindings: SecretBinding[] = [];
  const variableBindings = new Set<string>();
  const mode = options.mode ?? 'live';
  rejectReservedKinds(parsed.data.connectors, errors);
  if (errors.length > 0) return { ok: false, errors };

  const targets = buildTargetIndex(parsed.data.connectors, errors);
  validateComputeCallGraph(parsed.data.connectors, targets, errors);
  const customerRouting = collectCatalogCustomerRouting(parsed.data.connectors, errors);
  // One shared sandbox engine per compile: every compute operation registers its source here, keyed by
  // content digest, so the CodeConnectors built below can resolve their modules at invoke time.
  const computeEngine = new QuickJsComputeEngine();

  for (const def of parsed.data.connectors) {
    if ('http' in def) {
      compileHttpConnector(
        def,
        mode,
        errors,
        catalog,
        connectors,
        secretBindings,
        variableBindings,
      );
    } else if ('mcp' in def) {
      compileMcpConnector(def, mode, errors, catalog, connectors, secretBindings, variableBindings);
    } else {
      compileComputeConnector(def, computeEngine, targets, errors, catalog, connectors);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    catalog: catalog.map((entry) => {
      const routing = customerRouting.get(connectorIdentityKey(entry.id, entry.version));
      return routing === undefined ? entry : { ...entry, customerRouting: routing };
    }),
    connectors,
    secretBindings,
    variableBindings: [...variableBindings].sort(),
  };
}

function rejectReservedKinds(defs: readonly ConnectorDef[], errors: ConnectorCompileError[]): void {
  for (const def of defs) {
    if (def.kind === 'builtin') {
      errors.push({
        code: 'reserved_connector_kind',
        path: `connectors.${def.id}.kind`,
        message: 'connector kind "builtin" is reserved for first-party service registrations',
      });
    }
  }
}

/**
 * Compile one compute connector: register each operation's code with the shared sandbox engine (producing
 * a content-addressed module) and emit a `CodeConnector`. The catalog signatures are identical to what
 * `CodeConnector.signature()` reports, so signature-hash parity (ADR 0002) holds; the module digest and
 * limits never enter the signature.
 */
function compileComputeConnector(
  def: ComputeConnectorDef,
  engine: QuickJsComputeEngine,
  targets: TargetIndex,
  errors: ConnectorCompileError[],
  catalog: CatalogConnector[],
  connectors: Connector[],
): void {
  const signatures: Record<string, OperationSignature> = {};
  const operations: Record<string, CodeOperation> = {};

  for (const [opName, op] of Object.entries(def.operations)) {
    const base = `connectors.${def.id}.operations.${opName}`;
    const signature = toSignature(op.type, op.input, op.output);
    signatures[opName] = signature;

    const limits: ComputeLimits = {
      timeoutMs: op.limits?.timeoutMs ?? DEFAULT_LIMITS.timeoutMs,
      memoryBytes: op.limits?.memoryBytes ?? DEFAULT_LIMITS.memoryBytes,
      maxOutputBytes: op.limits?.maxOutputBytes ?? DEFAULT_LIMITS.maxOutputBytes,
      maxHostCalls: op.limits?.maxHostCalls ?? DEFAULT_LIMITS.maxHostCalls,
    };
    const calls = compileCalls(op, targets, `${base}.calls`, errors);
    operations[opName] = {
      signature,
      module: engine.registerSource(op.code),
      limits,
      ...(calls ? { calls } : {}),
    };
  }

  catalog.push({
    id: def.id,
    version: def.version,
    kind: def.kind ?? 'custom',
    ...catalogCredentialMetadata(def),
    operations: signatures,
  });
  connectors.push(new CodeConnector({ id: def.id, version: def.version, engine, operations }));
}

interface TargetIndexEntry {
  readonly id: string;
  readonly version: string;
  readonly operations: Readonly<Record<string, OperationSignature>>;
  readonly directEndpoint?: string;
}

interface TargetIndex {
  readonly byId: ReadonlyMap<string, TargetIndexEntry | 'ambiguous'>;
}

function buildTargetIndex(
  defs: readonly ConnectorDef[],
  errors: ConnectorCompileError[],
): TargetIndex {
  const byId = new Map<string, TargetIndexEntry | 'ambiguous'>();
  for (const def of defs) {
    const signatures: Record<string, OperationSignature> = {};
    for (const [opName, op] of Object.entries(def.operations)) {
      signatures[opName] = toSignature(op.type, op.input, op.output);
    }
    if (byId.has(def.id)) {
      byId.set(def.id, 'ambiguous');
      errors.push({
        code: 'duplicate_connector_id',
        path: `connectors.${def.id}`,
        message: `connector id "${def.id}" appears more than once; compute call targets would be ambiguous`,
      });
    } else {
      const directEndpoint =
        'http' in def && typeof def.http.baseUrl !== 'string' ? def.http.baseUrl.name : undefined;
      byId.set(def.id, {
        id: def.id,
        version: def.version,
        operations: signatures,
        ...(directEndpoint === undefined ? {} : { directEndpoint }),
      });
    }
  }
  return { byId };
}

function compileCalls(
  op: ComputeOperationDef,
  targets: TargetIndex,
  prefix: string,
  errors: ConnectorCompileError[],
): Record<string, ResolvedOperationRef> | undefined {
  if (!op.calls) return undefined;
  const calls: Record<string, ResolvedOperationRef> = {};
  for (const [localName, target] of Object.entries(op.calls)) {
    if (!/^[a-z0-9_]+$/.test(localName)) {
      errors.push({
        code: 'invalid_call_name',
        path: `${prefix}.${localName}`,
        message: `call name "${localName}" must use lowercase letters, numbers, and underscores`,
      });
      continue;
    }

    const parsed = parseCallTarget(target);
    if (!parsed) {
      errors.push({
        code: 'invalid_call_target',
        path: `${prefix}.${localName}`,
        message: `call target "${target}" must be "<connectorId>.<operation>"`,
      });
      continue;
    }

    const entry = targets.byId.get(parsed.connectorId);
    if (!entry) {
      errors.push({
        code: 'unknown_call_connector',
        path: `${prefix}.${localName}`,
        message: `call target connector "${parsed.connectorId}" is not declared`,
      });
      continue;
    }
    if (entry === 'ambiguous') {
      errors.push({
        code: 'ambiguous_call_connector',
        path: `${prefix}.${localName}`,
        message: `call target connector "${parsed.connectorId}" is ambiguous`,
      });
      continue;
    }
    const signature = entry.operations[parsed.operation];
    if (!signature) {
      errors.push({
        code: 'unknown_call_operation',
        path: `${prefix}.${localName}`,
        message: `call target operation "${parsed.operation}" is not declared on "${parsed.connectorId}"`,
      });
      continue;
    }

    calls[localName] = {
      resolved: true,
      alias: parsed.connectorId,
      connectorId: entry.id,
      connectorVersion: entry.version,
      operation: parsed.operation,
      signatureHash: computeSignatureHash(parsed.operation, signature),
      ...(entry.directEndpoint === undefined ? {} : { customerEndpoint: entry.directEndpoint }),
    };
  }
  return Object.keys(calls).length > 0 ? calls : undefined;
}

function parseCallTarget(target: string): { connectorId: string; operation: string } | null {
  const parts = target.split('.');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') return null;
  return { connectorId: parts[0] as string, operation: parts[1] as string };
}
