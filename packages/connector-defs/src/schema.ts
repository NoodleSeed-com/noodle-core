import {
  type CustomerEndpointPolicy,
  isLegacyFieldMap,
  normalizeCustomerEndpointPolicy,
  normalizeOperationIoSchema,
} from '@noodle-borg/compiler';
import { z } from 'zod';

/**
 * A declared operation `input`/`output`: a JSON Schema 2020-12 object schema (ADR 0139),
 * normalized to the canonical closed object schema at this parse boundary — everything downstream
 * of the schema layer sees JSON Schema only. The retired flat `{ field: { type, required? } }`
 * map is rejected with a precise error.
 */
const ioSchema = z
  .record(z.string(), z.unknown())
  .superRefine((value, ctx) => {
    if (isLegacyFieldMap(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'operation input/output uses the retired field-map form; author a JSON Schema object ' +
          '(type: object, properties: {...}, required: [...]) — or z.object(...) in the TypeScript SDK (ADR 0139)',
      });
      return;
    }
    const declaredType = value.type;
    if (
      declaredType !== undefined &&
      declaredType !== 'object' &&
      !(Array.isArray(declaredType) && declaredType.includes('object'))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['type'],
        message: 'operation input/output must be an object-typed JSON Schema',
      });
    }
    const additional = value.additionalProperties;
    if (additional !== undefined && typeof additional !== 'boolean') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['additionalProperties'],
        message: 'top-level additionalProperties must be a boolean (ADR 0139)',
      });
    }
  })
  .transform((value): Record<string, unknown> => normalizeOperationIoSchema(value));

/** A response mapping: field name -> a `${...}` expression (or a literal scalar). */
const exprMapSchema = z.record(z.string(), z.unknown());

const resilienceRetryCategorySchema = z.enum([
  'timeout',
  'network_error',
  'rate_limited',
  'upstream_5xx',
]);

const operationResilienceSchema = z
  .object({
    timeoutMs: z.number().int().positive().optional(),
    retry: z
      .object({
        maxAttempts: z.number().int().positive().optional(),
        baseDelayMs: z.number().int().nonnegative().optional(),
        maxDelayMs: z.number().int().nonnegative().optional(),
        backoffMultiplier: z.number().positive().optional(),
        retryOn: z.array(resilienceRetryCategorySchema).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const paginationLimitSchema = {
  maxPages: z.number().int().min(1).max(25).optional(),
  maxItems: z.number().int().min(1).max(1000).optional(),
};

const operationPaginationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('cursor'),
      cursorParam: z.string().min(1),
      nextCursor: z.unknown(),
      items: z.unknown(),
      ...paginationLimitSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('pageNumber'),
      pageParam: z.string().min(1),
      startPage: z.number().int().min(1).optional(),
      hasMore: z.unknown(),
      items: z.unknown(),
      ...paginationLimitSchema,
    })
    .strict(),
]);

const operationFakeSchema = z
  .union([
    z
      .object({
        response: z.unknown(),
      })
      .strict(),
    z
      .object({
        pages: z.array(z.unknown()).min(1),
      })
      .strict(),
  ])
  .optional();

const operationProjectionSchema = z
  .object({
    hiddenFields: z.array(z.string().min(1)).optional(),
    widgetMeta: exprMapSchema.optional(),
    sourceLabel: z.string().min(1).optional(),
    freshness: z
      .object({
        ttlMs: z.number().int().positive(),
        timestamp: z.unknown().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const credentialProfileSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bearer') }).strict(),
  z.object({ kind: z.literal('apiKey'), header: z.string().trim().min(1) }).strict(),
]);

const operationCredentialsSchema = z
  .object({
    profiles: z.array(z.string().regex(/^[a-z0-9_]+$/)).min(1),
    scopes: z.array(z.string().trim().min(1)).min(1).optional(),
    audience: z.string().trim().min(1).optional(),
  })
  .strict();

/**
 * A named reference to a secret — never the secret value itself. The value is managed out-of-band and
 * resolved by the credential broker; it must never appear in the catalog/manifest.
 */
const secretRefSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_]+$/, 'secret reference must match [A-Za-z0-9_]+');

const variableExprSchema = z
  .string()
  .regex(/^\$\{env\.[A-Za-z0-9_]+\}$/, 'variable expression must be ${env.NAME}');
const customerEndpointPolicySchema = z.unknown().transform((value, ctx): CustomerEndpointPolicy => {
  try {
    return normalizeCustomerEndpointPolicy(value);
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'invalid customer endpoint policy',
    });
    return z.NEVER;
  }
});
const customerEndpointRefSchema = z
  .object({
    kind: z.literal('customerEndpoint'),
    name: z.string().regex(/^[a-z0-9_]+$/),
    policy: customerEndpointPolicySchema,
  })
  .strict();
const baseUrlSchema = z.union([z.string().url(), variableExprSchema, customerEndpointRefSchema]);
const urlTemplateSchema = z.string().refine((value) => {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}, 'must be a URL');

/**
 * Wire descriptor for a non-standard (non-RFC-6749) client-credentials token endpoint, used by
 * `clientCredentials` with `profile: 'custom'`. It describes how the broker must POST the token
 * request and where to read the token + its expiry — so a partner endpoint that does not speak the
 * OAuth2 grant can still be authored declaratively instead of hand-rolling an HTTP client.
 */
const clientCredentialsCustomSchema = z
  .object({
    /** How the token-endpoint request body is encoded. */
    requestFormat: z.enum(['json', 'form']).default('json'),
    /** Body field that carries the client id. */
    clientIdField: z.string().min(1).default('clientId'),
    /** Body field that carries the broker-resolved client secret. */
    clientSecretField: z.string().min(1).default('clientSecret'),
    /** Dotted path to the access token in the JSON response (e.g. `accessToken`, `data.token`). */
    tokenResponsePath: z.string().min(1).default('access_token'),
    /** Ordered strategies the broker tries, in order, to derive the token's expiry. */
    expirySource: z
      .array(z.enum(['jwt', 'expiresIn', 'expiresAt']))
      .nonempty()
      .default(['expiresIn']),
    /** Fallback token lifetime (seconds) when no expiry can be derived. */
    fallbackTtlSeconds: z.number().int().positive().default(300),
  })
  .strict();

/**
 * A declarative downstream auth scheme: the scheme plus the *name* of the secret the broker should mint.
 * Branches are `.strict()`, so an inline `value`/`token` key fails to parse — secrets can only be
 * referenced, never embedded. `clientCredentials` exchanges a client id + secret for an access token
 * the broker injects as a bearer header; `profile: 'oauth2'` (default) is the RFC-6749 grant, while
 * `profile: 'custom'` describes a non-standard partner token endpoint via {@link clientCredentialsCustomSchema}.
 */
const httpAuthSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('bearer'), secret: secretRefSchema }).strict(),
    z
      .object({ kind: z.literal('apiKey'), header: z.string().min(1), secret: secretRefSchema })
      .strict(),
    z
      .object({
        kind: z.literal('clientCredentials'),
        /** `oauth2` (default) = RFC-6749 client-credentials grant; `custom` = non-standard endpoint. */
        profile: z.enum(['oauth2', 'custom']).default('oauth2'),
        tokenUrl: urlTemplateSchema,
        clientId: z.string().min(1),
        clientSecret: secretRefSchema,
        scopes: z.array(z.string().min(1)).optional(),
        audience: z.string().min(1).optional(),
        authMethod: z.enum(['client_secret_basic', 'client_secret_post']).optional(),
        custom: clientCredentialsCustomSchema.optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('delegatedOAuth'),
        provider: z.string().min(1),
        tokenUrl: urlTemplateSchema.optional(),
        clientId: z.string().min(1).optional(),
        clientSecret: secretRefSchema.optional(),
        scopes: z.array(z.string().min(1)).optional(),
        authMethod: z.enum(['client_secret_basic', 'client_secret_post']).optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('delegatedSessionCookie'),
        provider: z.string().min(1),
        sessionUrl: z.string().url(),
        tokenField: z.string().min(1).optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('delegatedTokenExchange'),
        tokenUrl: urlTemplateSchema,
        clientId: z.string().min(1),
        clientSecret: secretRefSchema,
        scopes: z.array(z.string().min(1)).optional(),
        audience: z.string().min(1).optional(),
        authMethod: z.enum(['client_secret_basic', 'client_secret_post']).optional(),
      })
      .strict(),
  ])
  .superRefine((auth, ctx) => {
    if (auth.kind !== 'clientCredentials') return;
    if (auth.profile === 'custom') {
      if (auth.custom === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['custom'],
          message: 'the custom profile requires a `custom` token-endpoint descriptor',
        });
      }
      for (const field of ['scopes', 'audience', 'authMethod'] as const) {
        if (auth[field] !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `\`${field}\` is only valid for the oauth2 profile`,
          });
        }
      }
    } else if (auth.custom !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['custom'],
        message: '`custom` is only valid for the custom profile',
      });
    }
  });

/** Phase-1 upstream MCP auth: broker-owned service credentials only (ADR 0189 Decision 7). */
const mcpAuthSchema = httpAuthSchema.superRefine((auth, ctx) => {
  if (auth.kind === 'bearer' || auth.kind === 'apiKey' || auth.kind === 'clientCredentials') {
    return;
  }
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message:
      'MCP connectors currently accept only bearer, apiKey, or clientCredentials auth; delegated upstream OAuth requires the consent-broker slice',
  });
});

/** Public HTTP response allowance: explicit per operation, bounded to cap concurrent memory cost. */
const httpOperationLimitsSchema = z
  .object({
    maxResponseBytes: z
      .number()
      .int()
      .positive()
      .max(6 * 1024 * 1024),
  })
  .strict();

const httpOperationSchema = z
  .object({
    type: z.enum(['read', 'action']),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
    path: z.string().min(1),
    query: z.array(z.string()).optional(),
    input: ioSchema.optional(),
    output: ioSchema.optional(),
    request: z.unknown().optional(),
    /** How to encode a non-GET request mapping. JSON remains the default. */
    requestEncoding: z.enum(['json', 'form-urlencoded']).optional(),
    response: exprMapSchema.optional(),
    /** Explicit expected rejection outcomes. Authentication, redirects, rate limits and 5xx fail closed. */
    responses: z
      .record(
        z
          .string()
          .regex(/^4\d\d$/u)
          .refine((status) => !['401', '403', '429'].includes(status)),
        z
          .object({
            response: exprMapSchema,
            responseType: z.enum(['json', 'text', 'empty']).optional(),
            evidence: z
              .object({
                outcome: z.enum(['rejected', 'unknown']),
                reference: z.string().min(1).optional(),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .optional(),
    /** Explicit provider evidence mapping; never infer completion from an HTTP status or tool name. */
    evidence: z
      .object({ outcome: z.string().min(1), reference: z.string().min(1).optional() })
      .strict()
      .optional(),
    /**
     * Per-operation request headers: header name -> a `${...}` expression (over `args`/`env`) or a
     * literal string. Merged over the connector defaults but *below* the `auth` scheme, so a declared
     * `auth` block always wins. Lets an operation attach a runtime value — e.g. a token fetched by a
     * prior operation — as `Authorization: Bearer ${args.token}`.
     */
    headers: exprMapSchema.optional(),
    /**
     * How to decode the response body. `'json'` (default) parses JSON; `'text'` reads the raw body and
     * binds the decoded string to `${response}`; `'empty'` enforces status and binds `{}` for no-content
     * endpoints. Incompatible with `pagination`.
     */
    responseType: z.enum(['json', 'text', 'empty']).optional(),
    /** Per-operation transport bounds. Omitted operations retain the 1 MiB response default. */
    limits: httpOperationLimitsSchema.optional(),
    /** Per-operation auth scheme; overrides the connector-level `http.auth`. */
    auth: httpAuthSchema.optional(),
    resilience: operationResilienceSchema.optional(),
    pagination: operationPaginationSchema.optional(),
    fake: operationFakeSchema,
    projection: operationProjectionSchema.optional(),
    /** Credential acquisition requirements, deliberately excluded from the operation signature. */
    credentials: operationCredentialsSchema.optional(),
  })
  .strict()
  .superRefine((operation, ctx) => {
    if (operation.responses !== undefined && operation.pagination !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['responses'],
        message: 'HTTP response status mappings cannot be combined with pagination',
      });
    }
    if (operation.requestEncoding !== 'form-urlencoded') return;
    if (operation.method === undefined || operation.method === 'GET') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requestEncoding'],
        message: 'form-urlencoded request encoding requires a non-GET method',
      });
    }
    if (operation.request === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['request'],
        message: 'form-urlencoded request encoding requires a request mapping',
      });
    }
  });

const mcpOperationFakeSchema = z.union([
  z.object({ structuredContent: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ text: z.string() }).strict(),
]);

const mcpToolNameSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/\p{Cc}/u.test(value), 'upstream MCP tool name contains a control character');

/** One frozen upstream MCP tool projected as one ordinary connector operation. */
const mcpOperationSchema = z
  .object({
    type: z.enum(['read', 'action']),
    tool: mcpToolNameSchema,
    input: ioSchema.optional(),
    output: ioSchema.optional(),
    /** `text` means the imported upstream tool had no outputSchema. */
    result: z.enum(['structured', 'text']).default('structured'),
    auth: mcpAuthSchema.optional(),
    limits: httpOperationLimitsSchema.optional(),
    fake: mcpOperationFakeSchema.optional(),
    credentials: operationCredentialsSchema.optional(),
  })
  .strict()
  .superRefine((operation, ctx) => {
    for (const [field, schema] of [
      ['input', operation.input],
      ['output', operation.output],
    ] as const) {
      if (schema !== undefined && hasExternalSchemaRef(schema)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: 'external JSON Schema references are not allowed for MCP operations',
        });
      }
    }
  });

function hasExternalSchemaRef(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasExternalSchemaRef);
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.$ref === 'string' && !record.$ref.startsWith('#')) return true;
  return Object.values(record).some(hasExternalSchemaRef);
}

/** Per-operation resource bounds for a compute operation; omitted fields fall back to `DEFAULT_LIMITS`. */
const computeLimitsSchema = z
  .object({
    timeoutMs: z.number().int().positive().optional(),
    memoryBytes: z.number().int().positive().optional(),
    maxOutputBytes: z.number().int().positive().optional(),
    maxHostCalls: z.number().int().nonnegative().optional(),
  })
  .strict();

/**
 * A sandboxed-code operation: a JavaScript expression that evaluates to a handler `fn(input) -> output`,
 * run with no ambient authority. No `path`/`method`/`request`/`response` — those are HTTP transport
 * concerns; a compute operation only declares its signature, its `code`, and optional resource limits.
 */
const computeOperationSchema = z
  .object({
    type: z.enum(['read', 'action']),
    input: ioSchema.optional(),
    output: ioSchema.optional(),
    code: z.string().min(1),
    limits: computeLimitsSchema.optional(),
    calls: z.record(z.string(), z.string().min(1)).optional(),
    coordination: z
      .object({
        connectionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
        namespace: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
        key: z.string().min(1).max(4096),
        reference: z.string().min(1).max(4096),
      })
      .strict()
      .optional(),
    credentials: operationCredentialsSchema.optional(),
  })
  .strict()
  .superRefine((operation, ctx) => {
    if (operation.coordination && operation.type !== 'action')
      ctx.addIssue({
        code: 'custom',
        path: ['coordination'],
        message: 'Coordination requires an action operation',
      });
  });

const managedVariableExpressionSchema = z
  .string()
  .regex(/^\$\{env\.[A-Za-z0-9_]+\}$/, 'must be an exact managed variable expression');

const mcpEndpointSchema = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    if (managedVariableExpressionSchema.safeParse(value).success) return;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'MCP endpoint must be an absolute URL',
      });
      return;
    }
    const loopback =
      url.protocol === 'http:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
    if (url.protocol !== 'https:' && !loopback) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'MCP endpoint must use HTTPS' });
    }
    if (url.username !== '' || url.password !== '' || url.hash !== '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'MCP endpoint cannot contain userinfo or a fragment',
      });
    }
  });

const mcpOriginSchema = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    if (managedVariableExpressionSchema.safeParse(value).success) return;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'MCP origin must be an absolute URL' });
      return;
    }
    const loopback =
      url.protocol === 'http:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
    if (url.protocol !== 'https:' && !loopback) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'MCP origin must use HTTPS' });
    }
    if (value !== url.origin) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'MCP origin must be a canonical bare origin',
      });
    }
  });

const connectorIdentity = {
  id: z.string().min(1),
  version: z.string().min(1),
  kind: z.enum(['builtin', 'catalog', 'custom']).optional(),
  credentialProfiles: z
    .record(z.string().regex(/^[a-z0-9_]+$/), credentialProfileSchema)
    .optional(),
};

/** An outbound HTTP connector: a declared `http` origin + HTTP operations with `${...}` mapping. */
const transportAuthSchema = z
  .object({
    kind: z.literal('apiKey'),
    header: z
      .string()
      .regex(/^x-[a-z0-9]+(?:-[a-z0-9]+)*$/iu)
      .refine(
        (header) =>
          !/^x-(?:forwarded(?:-|$)|real-ip$|http-method-override$|original-url$|rewrite-url$)/iu.test(
            header,
          ),
        'transport authentication cannot use routing headers',
      ),
    secret: secretRefSchema,
  })
  .strict();

const httpConnectorDefSchema = z
  .object({
    ...connectorIdentity,
    http: z
      .object({
        baseUrl: baseUrlSchema,
        allowedOrigins: z
          .array(z.union([z.string().url(), managedVariableExpressionSchema]))
          .optional(),
        /** Connector-default auth scheme; an operation's own `auth` overrides it. */
        auth: httpAuthSchema.optional(),
        transportAuth: transportAuthSchema.optional(),
      })
      .strict(),
    operations: z.record(z.string(), httpOperationSchema),
  })
  .strict();

/** A governed remote MCP connector with a compile-time-frozen tool snapshot. */
const mcpConnectorDefSchema = z
  .object({
    ...connectorIdentity,
    mcp: z
      .object({
        endpoint: mcpEndpointSchema,
        allowedOrigins: z.array(mcpOriginSchema).min(1).max(32).optional(),
        auth: mcpAuthSchema.optional(),
        timeoutMs: z.number().int().positive().max(300_000).optional(),
        maxResponseBytes: z
          .number()
          .int()
          .positive()
          .max(6 * 1024 * 1024)
          .optional(),
        protocol: z.enum(['auto', 'legacy', 'modern']).optional(),
      })
      .strict(),
    operations: z
      .record(z.string(), mcpOperationSchema)
      .refine(
        (operations) => Object.keys(operations).length > 0,
        'MCP connector needs an operation',
      )
      .refine(
        (operations) => Object.keys(operations).length <= 256,
        'MCP connector supports at most 256 curated operations',
      ),
  })
  .strict();

/** A compute connector: sandboxed-code operations, no `http` block. */
const computeConnectorDefSchema = z
  .object({
    ...connectorIdentity,
    operations: z.record(z.string(), computeOperationSchema),
  })
  .strict();

/**
 * A connector is **either** an HTTP connector (has an `http` block) **or** a compute connector (no `http`;
 * operations carry `code`). Both shapes are `.strict()`, so a given entry matches exactly one branch.
 */
const connectorDefSchema = z.union([
  httpConnectorDefSchema,
  mcpConnectorDefSchema,
  computeConnectorDefSchema,
]);

export const connectorFileSchema = z
  .object({
    connectors: z.array(connectorDefSchema).min(1),
  })
  .strict()
  .superRefine((file, ctx) => {
    file.connectors.forEach((connector, connectorIndex) => {
      const profiles = connector.credentialProfiles ?? {};
      for (const [operationName, operation] of Object.entries(connector.operations)) {
        operation.credentials?.profiles.forEach((profile: string, profileIndex: number) => {
          if (profiles[profile] !== undefined) return;
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [
              'connectors',
              connectorIndex,
              'operations',
              operationName,
              'credentials',
              'profiles',
              profileIndex,
            ],
            message: `operation names undeclared credential profile "${profile}"`,
          });
        });
      }
    });
  });

export type ConnectorFile = z.infer<typeof connectorFileSchema>;
export type ConnectorDef = z.infer<typeof connectorDefSchema>;
export type HttpConnectorDef = z.infer<typeof httpConnectorDefSchema>;
export type ComputeConnectorDef = z.infer<typeof computeConnectorDefSchema>;
export type McpConnectorDef = z.infer<typeof mcpConnectorDefSchema>;
export type HttpOperationDef = z.infer<typeof httpOperationSchema>;
export type ComputeOperationDef = z.infer<typeof computeOperationSchema>;
export type McpOperationDef = z.infer<typeof mcpOperationSchema>;
export type HttpAuthDef = z.infer<typeof httpAuthSchema>;
export type CredentialProfileDef = z.infer<typeof credentialProfileSchema>;
