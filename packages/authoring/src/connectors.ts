import {
  type CustomerEndpointRef,
  isLegacyFieldMap,
  type JsonSchema,
  normalizeOperationIoSchema,
  type OperationSignature,
} from '@noodle-borg/compiler';
import {
  type ConnectorFile,
  type CredentialProfileDef,
  connectorFileSchema,
  type HttpConnectorDef,
  type McpConnectorDef,
} from '@noodle-borg/connector-defs';
import { z } from 'zod';
import { type ConfigRef, isConfigRef, serializeSecretRef, serializeVariableRef } from './config.js';
import type { ConnectionBinding } from './connection-types.js';
import { toJsonSchema } from './json-schema.js';

/** What a builder accepts for an operation's input/output: Zod (canonical) or a raw JSON Schema object. */
type OperationIoOptions = z.ZodType | JsonSchema;

/**
 * Convert a declared operation I/O option to its canonical closed JSON Schema (ADR 0139): Zod
 * converts through the shared `toJsonSchema` seam with the given `io` projection; raw JSON Schema
 * normalizes exactly as at the catalog parse boundary. Fails at author time — naming the
 * connector/operation — when the value uses the retired field-map form or is not an object schema.
 */
function toOperationIoSchema(
  value: OperationIoOptions | undefined,
  io: 'input' | 'output',
  pointer: string,
): JsonSchema {
  if (isLegacyFieldMap(value)) {
    throw new Error(
      `invalid connector operation ${io} at ${pointer}: the retired field-map form is no longer accepted — author z.object(...) (or a JSON Schema object) instead (ADR 0139)`,
    );
  }
  const schema = normalizeOperationIoSchema(
    value instanceof z.ZodType ? toJsonSchema(value, io) : value,
  );
  // Operation I/O schemas are embedded fragments, not standalone documents — drop the dialect
  // marker `z.toJSONSchema` stamps at the top level (the signature hash ignores it either way).
  delete schema.$schema;
  const declaredType = schema.type;
  if (
    declaredType !== 'object' &&
    !(Array.isArray(declaredType) && declaredType.includes('object'))
  ) {
    throw new Error(
      `invalid connector operation ${io} at ${pointer}: operation ${io} must be an object schema (z.object(...) or a JSON Schema with type "object")`,
    );
  }
  return schema;
}

/**
 * Options for `ConnectorBuilder.http(...)` — an HTTP connector's transport, auth, and operations. `id`
 * and `version` come from `connector(id).version(v)`; `kind` defaults to `custom`. The shape is derived
 * from the canonical `HttpConnectorDef`, so it stays in lockstep with `@noodle-borg/connector-defs`.
 */
type HttpAuthOptions =
  | { readonly kind: 'bearer'; readonly secret: string | ConfigRef }
  | { readonly kind: 'apiKey'; readonly header: string; readonly secret: string | ConfigRef }
  | {
      readonly kind: 'clientCredentials';
      /** RFC-6749 client-credentials grant (default). */
      readonly profile?: 'oauth2';
      readonly tokenUrl: string;
      readonly clientId: string | ConfigRef;
      readonly clientSecret: string | ConfigRef;
      readonly scopes?: readonly string[];
      readonly audience?: string;
      readonly authMethod?: 'client_secret_basic' | 'client_secret_post';
    }
  | {
      readonly kind: 'clientCredentials';
      /** Non-standard partner token endpoint described by `custom`. */
      readonly profile: 'custom';
      readonly tokenUrl: string;
      readonly clientId: string | ConfigRef;
      readonly clientSecret: string | ConfigRef;
      readonly custom: {
        readonly requestFormat?: 'json' | 'form';
        readonly clientIdField?: string;
        readonly clientSecretField?: string;
        readonly tokenResponsePath?: string;
        readonly expirySource?: readonly ('jwt' | 'expiresIn' | 'expiresAt')[];
        readonly fallbackTtlSeconds?: number;
      };
    }
  | {
      readonly kind: 'delegatedOAuth';
      readonly provider: string;
      readonly tokenUrl?: string;
      readonly clientId?: string | ConfigRef;
      readonly clientSecret?: string | ConfigRef;
      readonly scopes?: readonly string[];
      readonly authMethod?: 'client_secret_basic' | 'client_secret_post';
    }
  | {
      readonly kind: 'delegatedSessionCookie';
      readonly provider: string;
      readonly sessionUrl: string;
      readonly tokenField?: string;
    }
  | {
      /**
       * Per-user downstream auth against a customer-owned RFC 8693 token endpoint (ADR 0152): the
       * platform signs a short-lived assertion of the verified caller and exchanges it for a
       * user-scoped downstream bearer token.
       */
      readonly kind: 'delegatedTokenExchange';
      readonly tokenUrl: string;
      readonly clientId: string | ConfigRef;
      readonly clientSecret: string | ConfigRef;
      readonly scopes?: readonly string[];
      /** Assertion + exchange audience; defaults to `tokenUrl`. */
      readonly audience?: string;
      /** Client authentication at `tokenUrl`; defaults to `client_secret_basic`. */
      readonly authMethod?: 'client_secret_basic' | 'client_secret_post';
    };

type HttpOperationOptionsWithRefs = Omit<
  HttpConnectorDef['operations'][string],
  'auth' | 'input' | 'output'
> & {
  readonly auth?: HttpAuthOptions;
  /** Zod object schema (canonical) or a raw JSON Schema 2020-12 object. */
  readonly input?: OperationIoOptions;
  readonly output?: OperationIoOptions;
};

export type HttpConnectorOptions = Omit<
  HttpConnectorDef['http'],
  'baseUrl' | 'allowedOrigins' | 'auth' | 'transportAuth'
> & {
  readonly transportAuth?: {
    readonly kind: 'apiKey';
    readonly header: string;
    readonly secret: string | ConfigRef;
  };
  readonly baseUrl: string | ConfigRef | CustomerEndpointRef;
  /** Exact literal or operator-managed origins that may receive connector requests. */
  readonly allowedOrigins?: readonly (string | ConfigRef)[];
  readonly auth?: HttpAuthOptions;
} & {
  readonly credentialProfiles?: HttpConnectorDef['credentialProfiles'];
  readonly operations: Readonly<Record<string, HttpOperationOptionsWithRefs>>;
};

export type McpAuthOptions = Extract<
  HttpAuthOptions,
  { readonly kind: 'bearer' | 'apiKey' | 'clientCredentials' }
>;

type McpOperationOptionsWithRefs = Omit<
  McpConnectorDef['operations'][string],
  'auth' | 'input' | 'output'
> & {
  readonly auth?: McpAuthOptions;
  readonly input?: OperationIoOptions;
  readonly output?: OperationIoOptions;
};

export type McpConnectorOptions = Omit<
  McpConnectorDef['mcp'],
  'endpoint' | 'allowedOrigins' | 'auth'
> & {
  readonly endpoint: string | ConfigRef;
  readonly allowedOrigins?: readonly (string | ConfigRef)[];
  readonly auth?: McpAuthOptions;
  readonly credentialProfiles?: McpConnectorDef['credentialProfiles'];
  readonly operations: Readonly<Record<string, McpOperationOptionsWithRefs>>;
};

type DeclaredCredentialProfileKeys<Options extends { readonly credentialProfiles?: unknown }> =
  Options extends {
    readonly credentialProfiles: infer Profiles;
  }
    ? Extract<keyof Profiles, string>
    : never;

export interface ConnectorOperationOptions {
  readonly type: OperationSignature['type'];
  /** Zod object schema (canonical) or a raw JSON Schema 2020-12 object. */
  readonly input?: OperationIoOptions;
  readonly output?: OperationIoOptions;
}

/** Optional resource bounds for a sandboxed compute operation. */
export interface ComputeLimits {
  readonly timeoutMs?: number;
  readonly memoryBytes?: number;
  readonly maxOutputBytes?: number;
  readonly maxHostCalls?: number;
}

export interface ComputeHost {
  /** Trusted external-operation identity; unavailable outside governed action execution. */
  readonly execution?: { readonly id: string };
  readonly coordination?: {
    readonly acquired: boolean;
    readonly previous?: { readonly reference: string; readonly operationDigest: string };
  };
  reportOutcome(evidence: {
    readonly outcome: 'completed' | 'rejected' | 'unknown';
    readonly reference?: string;
  }): unknown;
  resolveCoordination(): unknown;
  /** Pure helpers over explicit instants, with no access to the current clock. */
  readonly time: {
    parse(instant: string): number;
    format(epochMilliseconds: number): string;
    parts(
      epochMilliseconds: number,
      timeZone: string,
    ): {
      readonly date: string;
      readonly weekday: number;
      readonly hour: number;
      readonly minute: number;
    };
  };
  /** Bounded SHA-256 over explicit input; no keys, secrets or randomness. */
  digest(value: string, encoding?: 'hex' | 'base32hex'): string;
  callOperation(name: string, args: Readonly<Record<string, unknown>>): unknown;
}

/**
 * A sandboxed-compute operation authored in TypeScript. `run` is your actual function — it is serialized
 * to source (via `Function.prototype.toString`) and shipped as the connector's `code`, then executed in a
 * WASM/QuickJS sandbox with no ambient authority. It must be **self-contained** (no references to
 * surrounding scope, imports, `fetch`, `process`, etc.). When it needs backing systems, declare `calls`
 * and use the sandbox `callOperation` capability rather than ambient network access.
 */
export interface ComputeOperationOptions {
  readonly type?: OperationSignature['type'];
  /** Zod object schema (canonical) or a raw JSON Schema 2020-12 object. */
  readonly input?: OperationIoOptions;
  readonly output?: OperationIoOptions;
  // biome-ignore lint/suspicious/noExplicitAny: the handler input is tenant-shaped; `any` gives natural authoring ergonomics.
  readonly run: (input: any, host: ComputeHost) => unknown;
  readonly limits?: ComputeLimits;
  readonly calls?: Readonly<Record<string, string>>;
  /** Serialize one externally coordinated resource; host owns durable custody and exact release. */
  readonly coordination?: {
    readonly connectionId: string;
    readonly namespace: string;
    readonly key: string;
    readonly reference: string;
  };
}

/** A connector operation's fulfilment, carried by the builder so it can be emitted to a catalog. */
export interface ConnectorOpDefinition {
  readonly kind: 'compute';
  readonly type: OperationSignature['type'];
  readonly input: JsonSchema;
  readonly output: JsonSchema;
  readonly code: string;
  readonly limits?: ComputeLimits;
  readonly calls?: Readonly<Record<string, string>>;
  readonly coordination?: ComputeOperationOptions['coordination'];
}

export interface ConnectorRef<CredentialProfileKey extends string = string> {
  readonly id: string;
  readonly version: string;
  readonly operations: Readonly<Record<string, OperationSignature>>;
  readonly binding?: ConnectionBinding<CredentialProfileKey>;
  /** Credential profiles retained for type-safe binding; omitted for connectors without profiles. */
  readonly credentialProfiles?: Readonly<Record<CredentialProfileKey, CredentialProfileDef>>;
  /** Per-operation fulfilment (present for operations declared with `.compute()`), used to emit a catalog. */
  readonly definitions?: Readonly<Record<string, ConnectorOpDefinition>>;
  /** HTTP fulfilment (present for connectors declared with `.http()`), emitted to the catalog verbatim. */
  readonly httpDef?: HttpConnectorDef;
  /** MCP fulfilment (present for connectors declared with `.mcp()`), emitted to the catalog verbatim. */
  readonly mcpDef?: McpConnectorDef;
}

/**
 * The connector-catalog document the SDK emits for the compiler. It is the canonical `ConnectorFile` from
 * `@noodle-borg/connector-defs`, so emitted catalog data is validated against the same internal schema the
 * service uses.
 */
export type ConnectorCatalogDoc = ConnectorFile;

export function connector(id: string): {
  version(version: string): ConnectorBuilder;
} {
  return {
    version(version: string) {
      return new ConnectorBuilder(id, version);
    },
  };
}

/** Validate a catalog document against the canonical schema, throwing a precise author-time error. */
export function validateCatalog(file: unknown): ConnectorFile {
  const parsed = connectorFileSchema.safeParse(file);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`invalid connector catalog: ${detail}`);
  }
  return parsed.data;
}

export class ConnectorBuilder<CredentialProfileKey extends string = never>
  implements ConnectorRef<CredentialProfileKey>
{
  readonly operations: Readonly<Record<string, OperationSignature>>;
  readonly definitions: Readonly<Record<string, ConnectorOpDefinition>>;
  readonly httpDef?: HttpConnectorDef;
  readonly mcpDef?: McpConnectorDef;
  readonly credentialProfiles?: Readonly<Record<CredentialProfileKey, CredentialProfileDef>>;

  constructor(
    readonly id: string,
    readonly version: string,
    operations: Readonly<Record<string, OperationSignature>> = {},
    definitions: Readonly<Record<string, ConnectorOpDefinition>> = {},
    httpDef?: HttpConnectorDef,
    credentialProfiles?: Readonly<Record<CredentialProfileKey, CredentialProfileDef>>,
    mcpDef?: McpConnectorDef,
  ) {
    this.operations = operations;
    this.definitions = definitions;
    // Assign conditionally (not `= undefined`) to satisfy exactOptionalPropertyTypes.
    if (httpDef !== undefined) this.httpDef = httpDef;
    if (mcpDef !== undefined) this.mcpDef = mcpDef;
    const declaredProfiles =
      credentialProfiles ?? httpDef?.credentialProfiles ?? mcpDef?.credentialProfiles;
    if (declaredProfiles !== undefined) {
      this.credentialProfiles = declaredProfiles as Readonly<
        Record<CredentialProfileKey, CredentialProfileDef>
      >;
    }
  }

  /** Declare the credential profiles supported by a curated signature ref or compute connector. */
  credentials<const Profiles extends Readonly<Record<string, CredentialProfileDef>>>(
    profiles: Profiles,
  ): ConnectorBuilder<Extract<keyof Profiles, string>> {
    if (this.httpDef !== undefined || this.mcpDef !== undefined) {
      throw new Error(
        `connector "${this.id}" owns its transport — declare credentialProfiles inside the transport options`,
      );
    }
    if (this.credentialProfiles !== undefined) {
      throw new Error(`connector "${this.id}" already declares credential profiles`);
    }
    return new ConnectorBuilder<Extract<keyof Profiles, string>>(
      this.id,
      this.version,
      this.operations,
      this.definitions,
      undefined,
      { ...profiles },
      undefined,
    );
  }

  /** Declare an operation by signature only (fulfilment supplied elsewhere, e.g. a catalog by `id@version`). */
  operation(
    name: string,
    options: ConnectorOperationOptions,
  ): ConnectorBuilder<CredentialProfileKey> {
    return new ConnectorBuilder<CredentialProfileKey>(
      this.id,
      this.version,
      {
        ...this.operations,
        [name]: {
          type: options.type,
          input: toOperationIoSchema(options.input, 'input', `${this.id}.${name}`),
          output: toOperationIoSchema(options.output, 'output', `${this.id}.${name}`),
        },
      },
      this.definitions,
      this.httpDef,
      this.credentialProfiles,
      this.mcpDef,
    );
  }

  /**
   * Declare this as an **HTTP connector**: transport (`baseUrl`/`allowedOrigins`), `bearer`/`apiKey` auth
   * naming a secret reference, and `${...}`-mapped operations. The connector carries its own fulfilment
   * (mirroring how `.compute()` carries its `code`) and is emitted to the catalog when `.use()`/
   * `.provides()`-d. The typed options are validated against the canonical schema at author time.
   */
  http<const Options extends HttpConnectorOptions>(
    options: Options,
  ): ConnectorBuilder<DeclaredCredentialProfileKeys<Options>> {
    if (this.credentialProfiles !== undefined) {
      throw new Error(
        `connector "${this.id}" already uses .credentials(...) — HTTP connectors declare credentialProfiles inside .http(...)`,
      );
    }
    if (this.mcpDef !== undefined) {
      throw new Error(
        `connector "${this.id}" is already an .mcp() connector — a connector has one engine`,
      );
    }
    if (Object.keys(this.definitions).length > 0) {
      throw new Error(
        `connector "${this.id}" already has .compute() operations — a connector is HTTP or compute, not both`,
      );
    }
    rejectUnsafeActionRetry(this.id, options);
    const { operations, ...http } = normalizeHttpOptions(this.id, options);
    const def: HttpConnectorDef = {
      id: this.id,
      version: this.version,
      kind: 'custom',
      ...(options.credentialProfiles !== undefined
        ? { credentialProfiles: options.credentialProfiles }
        : {}),
      http,
      operations,
    };
    // Validate eagerly so a malformed HTTP def fails at author time, naming the connector/op.
    validateCatalog({ connectors: [def] });
    const signatures: Record<string, OperationSignature> = {};
    for (const [name, op] of Object.entries(operations)) {
      signatures[name] = {
        type: op.type,
        input: normalizeOperationIoSchema(op.input),
        output: normalizeOperationIoSchema(op.output),
      };
    }
    return new ConnectorBuilder<DeclaredCredentialProfileKeys<Options>>(
      this.id,
      this.version,
      signatures,
      this.definitions,
      def,
    );
  }

  /** Declare a governed remote MCP connector from an imported, frozen upstream tool snapshot. */
  mcp<const Options extends McpConnectorOptions>(
    options: Options,
  ): ConnectorBuilder<DeclaredCredentialProfileKeys<Options>> {
    if (this.credentialProfiles !== undefined) {
      throw new Error(
        `connector "${this.id}" already uses .credentials(...) — MCP connectors declare credentialProfiles inside .mcp(...)`,
      );
    }
    if (this.httpDef !== undefined) {
      throw new Error(
        `connector "${this.id}" is already an .http() connector — a connector has one engine`,
      );
    }
    if (Object.keys(this.definitions).length > 0) {
      throw new Error(
        `connector "${this.id}" already has .compute() operations — a connector is MCP or compute, not both`,
      );
    }

    const operations: Record<string, McpConnectorDef['operations'][string]> = {};
    for (const [name, operation] of Object.entries(options.operations)) {
      const output =
        operation.result === 'text' && operation.output === undefined
          ? {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
              additionalProperties: false,
            }
          : toOperationIoSchema(operation.output, 'output', `${this.id}.${name}`);
      operations[name] = {
        ...operation,
        result: operation.result ?? 'structured',
        input: toOperationIoSchema(operation.input, 'input', `${this.id}.${name}`),
        output,
        ...(operation.auth === undefined
          ? {}
          : {
              auth: normalizeAuth(
                operation.auth,
                `connectors.${this.id}.operations.${name}.auth`,
              ) as McpConnectorDef['operations'][string]['auth'],
            }),
      } as McpConnectorDef['operations'][string];
    }
    const { credentialProfiles, operations: _operations, ...mcpOptions } = options;
    const def: McpConnectorDef = {
      id: this.id,
      version: this.version,
      kind: 'custom',
      ...(credentialProfiles === undefined ? {} : { credentialProfiles }),
      mcp: {
        ...mcpOptions,
        endpoint: normalizeVariableOrString(options.endpoint, `connectors.${this.id}.mcp.endpoint`),
        ...(options.allowedOrigins === undefined
          ? {}
          : {
              allowedOrigins: options.allowedOrigins.map((origin, index) =>
                normalizeVariableOrString(
                  origin,
                  `connectors.${this.id}.mcp.allowedOrigins.${index}`,
                ),
              ),
            }),
        ...(options.auth === undefined
          ? {}
          : {
              auth: normalizeAuth(
                options.auth,
                `connectors.${this.id}.mcp.auth`,
              ) as McpConnectorDef['mcp']['auth'],
            }),
      },
      operations,
    };
    validateCatalog({ connectors: [def] });
    const signatures: Record<string, OperationSignature> = {};
    for (const [name, operation] of Object.entries(operations)) {
      signatures[name] = {
        type: operation.type,
        input: normalizeOperationIoSchema(operation.input),
        output: normalizeOperationIoSchema(operation.output),
      };
    }
    return new ConnectorBuilder<DeclaredCredentialProfileKeys<Options>>(
      this.id,
      this.version,
      signatures,
      this.definitions,
      undefined,
      undefined,
      def,
    );
  }

  /** Declare a sandboxed-compute operation: `run` is your function, shipped as the connector's `code`. */
  compute(name: string, options: ComputeOperationOptions): ConnectorBuilder<CredentialProfileKey> {
    if (this.httpDef) {
      throw new Error(
        `connector "${this.id}" is already an .http() connector — a connector is HTTP or compute, not both`,
      );
    }
    if (this.mcpDef) {
      throw new Error(
        `connector "${this.id}" is already an .mcp() connector — a connector is MCP or compute, not both`,
      );
    }
    const type = options.type ?? 'read';
    const input = toOperationIoSchema(options.input, 'input', `${this.id}.${name}`);
    const output = toOperationIoSchema(options.output, 'output', `${this.id}.${name}`);
    return new ConnectorBuilder<CredentialProfileKey>(
      this.id,
      this.version,
      { ...this.operations, [name]: { type, input, output } },
      {
        ...this.definitions,
        [name]: {
          kind: 'compute',
          type,
          input,
          output,
          code: serializeRun(options.run),
          ...(options.limits ? { limits: options.limits } : {}),
          ...(options.calls ? { calls: options.calls } : {}),
          ...(options.coordination ? { coordination: options.coordination } : {}),
        },
      },
      undefined,
      this.credentialProfiles,
      undefined,
    );
  }
}

function rejectUnsafeActionRetry(id: string, options: HttpConnectorOptions): void {
  for (const [name, operation] of Object.entries(options.operations)) {
    if (operation.type === 'action' && operation.resilience?.retry !== undefined) {
      throw new Error(
        `invalid connector catalog: unsafe_retry_action at connectors.${id}.operations.${name}.resilience.retry`,
      );
    }
  }
}

function normalizeHttpOptions(
  id: string,
  options: HttpConnectorOptions,
): {
  readonly operations: HttpConnectorDef['operations'];
} & HttpConnectorDef['http'] {
  const operations: Record<string, HttpConnectorDef['operations'][string]> = {};
  for (const [name, operation] of Object.entries(options.operations)) {
    operations[name] = normalizeOperation(id, name, operation);
  }
  const { credentialProfiles: _credentialProfiles, ...httpOptions } = options;
  const normalized = {
    ...httpOptions,
    baseUrl: normalizeBaseUrl(options.baseUrl, `connectors.${id}.http.baseUrl`),
    ...(options.allowedOrigins !== undefined
      ? {
          allowedOrigins: options.allowedOrigins.map((origin, index) =>
            normalizeVariableOrString(origin, `connectors.${id}.http.allowedOrigins.${index}`),
          ),
        }
      : {}),
    ...(options.auth !== undefined
      ? { auth: normalizeAuth(options.auth, `connectors.${id}.http.auth`) }
      : {}),
    ...(options.transportAuth === undefined
      ? {}
      : {
          transportAuth: normalizeAuth(
            options.transportAuth,
            `connectors.${id}.http.transportAuth`,
          ),
        }),
    operations,
  };
  return normalized as {
    readonly operations: HttpConnectorDef['operations'];
  } & HttpConnectorDef['http'];
}

function normalizeOperation(
  id: string,
  name: string,
  operation: HttpOperationOptionsWithRefs,
): HttpConnectorDef['operations'][string] {
  const path = `connectors.${id}.operations.${name}`;
  return {
    ...operation,
    input: toOperationIoSchema(operation.input, 'input', `${id}.${name}`),
    output: toOperationIoSchema(operation.output, 'output', `${id}.${name}`),
    path: normalizeOperationPath(operation.path, `${path}.path`),
    ...(operation.request !== undefined
      ? { request: normalizeConfigRefs(operation.request, `${path}.request`) }
      : {}),
    ...(operation.response !== undefined
      ? { response: normalizeConfigRefs(operation.response, `${path}.response`) }
      : {}),
    ...(operation.responses !== undefined
      ? { responses: normalizeConfigRefs(operation.responses, `${path}.responses`) }
      : {}),
    ...(operation.headers !== undefined
      ? { headers: normalizeConfigRefs(operation.headers, `${path}.headers`) }
      : {}),
    ...(operation.auth !== undefined
      ? { auth: normalizeAuth(operation.auth, `${path}.auth`) }
      : {}),
  } as HttpConnectorDef['operations'][string];
}

/**
 * HTTP paths are runtime `{name}` templates (each placeholder filled with
 * `encodeURIComponent(args.name)`), while authors write the SDK-wide `${args.name}` idiom used by
 * request/query mappings. Compile `${args.name}` to `{name}` here; anything else left in `${...}`
 * form would reach the runtime as literal text and be URL-encoded into the request, so reject it.
 */
function normalizeOperationPath(template: string, pointer: string): string {
  const compiled = template.replace(/\$\{args\.(\w+)\}/g, '{$1}');
  if (compiled.includes('${')) {
    throw new Error(
      `invalid connector catalog: unsupported_path_expression at ${pointer}: only \${args.<name>} placeholders are supported in an HTTP path; move other expressions into request or query mappings`,
    );
  }
  return compiled;
}

function normalizeAuth(auth: HttpAuthOptions, path: string): HttpConnectorDef['http']['auth'] {
  if (auth.kind === 'bearer') {
    return {
      ...auth,
      kind: 'bearer',
      secret: normalizeSecretOrString(auth.secret, `${path}.secret`),
    } as HttpConnectorDef['http']['auth'];
  }
  if (auth.kind === 'apiKey') {
    return {
      ...auth,
      kind: 'apiKey',
      header: auth.header,
      secret: normalizeSecretOrString(auth.secret, `${path}.secret`),
    } as HttpConnectorDef['http']['auth'];
  }
  if (auth.kind === 'clientCredentials') {
    const base = {
      kind: 'clientCredentials' as const,
      tokenUrl: auth.tokenUrl,
      clientId: normalizeVariableOrString(auth.clientId, `${path}.clientId`),
      clientSecret: normalizeSecretOrString(auth.clientSecret, `${path}.clientSecret`),
    };
    if (auth.profile === 'custom') {
      return {
        ...base,
        profile: 'custom',
        custom: auth.custom,
      } as HttpConnectorDef['http']['auth'];
    }
    return {
      ...base,
      ...(auth.profile !== undefined ? { profile: auth.profile } : {}),
      ...(auth.scopes !== undefined ? { scopes: [...auth.scopes] } : {}),
      ...(auth.audience !== undefined ? { audience: auth.audience } : {}),
      ...(auth.authMethod !== undefined ? { authMethod: auth.authMethod } : {}),
    } as HttpConnectorDef['http']['auth'];
  }
  if (auth.kind === 'delegatedOAuth') {
    return {
      kind: 'delegatedOAuth',
      provider: auth.provider,
      ...(auth.tokenUrl !== undefined ? { tokenUrl: auth.tokenUrl } : {}),
      ...(auth.clientId !== undefined
        ? { clientId: normalizeVariableOrString(auth.clientId, `${path}.clientId`) }
        : {}),
      ...(auth.clientSecret !== undefined
        ? { clientSecret: normalizeSecretOrString(auth.clientSecret, `${path}.clientSecret`) }
        : {}),
      ...(auth.scopes !== undefined ? { scopes: [...auth.scopes] } : {}),
      ...(auth.authMethod !== undefined ? { authMethod: auth.authMethod } : {}),
    } as HttpConnectorDef['http']['auth'];
  }
  if (auth.kind === 'delegatedTokenExchange') {
    return {
      kind: 'delegatedTokenExchange',
      tokenUrl: auth.tokenUrl,
      clientId: normalizeVariableOrString(auth.clientId, `${path}.clientId`),
      clientSecret: normalizeSecretOrString(auth.clientSecret, `${path}.clientSecret`),
      ...(auth.scopes !== undefined ? { scopes: [...auth.scopes] } : {}),
      ...(auth.audience !== undefined ? { audience: auth.audience } : {}),
      ...(auth.authMethod !== undefined ? { authMethod: auth.authMethod } : {}),
    } as HttpConnectorDef['http']['auth'];
  }
  return { ...auth };
}

function normalizeVariableOrString(value: string | ConfigRef, path: string): string {
  return isConfigRef(value) ? serializeVariableRef(value, path) : value;
}

function normalizeBaseUrl(
  value: string | ConfigRef | CustomerEndpointRef,
  path: string,
): string | CustomerEndpointRef {
  return isConfigRef(value) ? serializeVariableRef(value, path) : value;
}

function normalizeSecretOrString(value: string | ConfigRef, path: string): string {
  return isConfigRef(value) ? serializeSecretRef(value, path) : value;
}

function normalizeConfigRefs(value: unknown, path: string): unknown {
  if (isConfigRef(value)) return serializeVariableRef(value, path);
  if (Array.isArray(value)) {
    return value.map((item, index) => normalizeConfigRefs(item, `${path}.${index}`));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        normalizeConfigRefs(item, `${path}.${key}`),
      ]),
    );
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

/**
 * Serialize an authored handler to a JavaScript **expression** that evaluates to a function, which the
 * compute sandbox wraps and calls. Arrow functions and function expressions are already expressions;
 * an object-method shorthand (`run(input) { ... }`) is promoted to a function expression.
 */
function serializeRun(fn: (input: never, host: ComputeHost) => unknown): string {
  const src = fn.toString().trim();
  if (src.startsWith('function') || src.includes('=>')) return src;
  // Method shorthand like `name(args) { ... }` -> `function name(args) { ... }`.
  return `function ${src}`;
}
