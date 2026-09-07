import { z } from 'zod';

import { DEVELOPER_CAPABILITIES } from './capabilities.js';

export const DEVELOPER_MCP_CAPABILITY_VERSION = '2' as const;

export const DEVELOPER_ERROR_CODES = [
  'authentication_required',
  'grant_revoked',
  'forbidden_scope',
  'capability_missing',
  'client_incompatible',
  'validation_failed',
  'not_found',
  'dependency_unavailable',
  'rate_limited',
  'internal_error',
] as const;

export const developerErrorCodeSchema = z.enum(DEVELOPER_ERROR_CODES);
export type DeveloperErrorCode = z.infer<typeof developerErrorCodeSchema>;

export const isoTimestampSchema = z.iso.datetime({ offset: true });
export const tenantSlugSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
export const appSlugSchema = tenantSlugSchema;
export const environmentNameSchema = tenantSlugSchema;
export const boundedIdSchema = z.string().min(1).max(200);
const ownerSubjectSchema = z.string().min(1).max(512);

export const developerMcpContextSchema = z.strictObject({
  subject: z.string().min(1).max(255),
  clientId: z.string().min(1).max(255),
  grantId: z.string().min(1).max(255),
  resource: z.url(),
  capabilities: z.array(z.enum(DEVELOPER_CAPABILITIES)).min(1).max(DEVELOPER_CAPABILITIES.length),
});
export type DeveloperMcpContext = z.infer<typeof developerMcpContextSchema>;

const timeRangeShape = {
  since: isoTimestampSchema.optional(),
  until: isoTimestampSchema.optional(),
};

function hasOrderedRange(value: {
  readonly since?: string | undefined;
  readonly until?: string | undefined;
}): boolean {
  return (
    value.since === undefined ||
    value.until === undefined ||
    Date.parse(value.since) <= Date.parse(value.until)
  );
}

export const getContextInputSchema = z.strictObject({});
export type GetContextInput = z.infer<typeof getContextInputSchema>;

export const listAppsInputSchema = z.strictObject({
  org: tenantSlugSchema,
  limit: z.number().int().min(1).max(100).default(50),
});
export type ListAppsInput = z.infer<typeof listAppsInputSchema>;

export const inspectAppInputSchema = z.strictObject({
  org: tenantSlugSchema,
  app: appSlugSchema,
  env: environmentNameSchema.optional(),
});
export type InspectAppInput = z.infer<typeof inspectAppInputSchema>;

export const inspectDeploymentInputSchema = z.strictObject({
  org: tenantSlugSchema,
  deploymentId: boundedIdSchema,
});
export type InspectDeploymentInput = z.infer<typeof inspectDeploymentInputSchema>;

export const getLogsInputSchema = z
  .strictObject({
    org: tenantSlugSchema,
    app: appSlugSchema,
    env: environmentNameSchema,
    limit: z.number().int().min(1).max(200).default(100),
    level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
    search: z.string().max(200).optional(),
    ...timeRangeShape,
  })
  .refine(hasOrderedRange, { message: 'since must not be after until' });
export type GetLogsInput = z.infer<typeof getLogsInputSchema>;

export const getMetricsInputSchema = z
  .strictObject({
    org: tenantSlugSchema,
    app: appSlugSchema,
    env: environmentNameSchema,
    window: z.enum(['24h', '7d', '30d']).default('7d'),
    ...timeRangeShape,
  })
  .refine(hasOrderedRange, { message: 'since must not be after until' });
export type GetMetricsInput = z.infer<typeof getMetricsInputSchema>;

export const listEventsInputSchema = z
  .strictObject({
    org: tenantSlugSchema,
    app: appSlugSchema,
    env: environmentNameSchema,
    limit: z.number().int().min(1).max(500).default(100),
    outcome: z.enum(['ok', 'tool_error', 'mcp_error']).optional(),
    tool: z.string().min(1).max(128).optional(),
    client: z.string().min(1).max(128).optional(),
    ...timeRangeShape,
  })
  .refine(hasOrderedRange, { message: 'since must not be after until' });
export type ListEventsInput = z.infer<typeof listEventsInputSchema>;

export const getSessionInputSchema = z.strictObject({
  org: tenantSlugSchema,
  app: appSlugSchema,
  env: environmentNameSchema,
  sessionId: boundedIdSchema,
});
export type GetSessionInput = z.infer<typeof getSessionInputSchema>;

export const diagnoseAppInputSchema = z.strictObject({
  org: tenantSlugSchema,
  app: appSlugSchema,
  env: environmentNameSchema,
});
export type DiagnoseAppInput = z.infer<typeof diagnoseAppInputSchema>;

export const rollbackDeploymentInputSchema = z.strictObject({
  org: tenantSlugSchema,
  app: appSlugSchema,
  env: environmentNameSchema,
  deploymentId: boundedIdSchema,
  reason: z.string().trim().min(1).max(500).optional(),
});
export type RollbackDeploymentInput = z.infer<typeof rollbackDeploymentInputSchema>;

export const developerContextViewSchema = z.strictObject({
  accessModel: z.literal('live_user'),
  capabilities: z.array(z.enum(DEVELOPER_CAPABILITIES)).min(1).max(DEVELOPER_CAPABILITIES.length),
  organizations: z
    .array(
      z.strictObject({
        org: tenantSlugSchema,
        displayName: z.string().min(1).max(200).optional(),
        role: z.enum(['owner', 'developer']),
        capabilities: z.array(z.enum(DEVELOPER_CAPABILITIES)).max(DEVELOPER_CAPABILITIES.length),
      }),
    )
    .max(100),
});
export type DeveloperContextView = z.infer<typeof developerContextViewSchema>;

export const deploymentSummarySchema = z.strictObject({
  deploymentId: boundedIdSchema,
  environment: environmentNameSchema,
  active: z.boolean(),
  serverName: z.string().min(1).max(200),
  createdAt: isoTimestampSchema,
  accessMode: z.string().min(1).max(64).optional(),
  ownerSubject: ownerSubjectSchema.optional(),
  endpointUrl: z.url().optional(),
});
export type DeveloperDeploymentSummary = z.infer<typeof deploymentSummarySchema>;

export const appSummaryViewSchema = z.strictObject({
  app: appSlugSchema,
  environments: z.array(environmentNameSchema).min(1).max(100),
  active: z.boolean(),
  createdAt: isoTimestampSchema,
  lastActivityAt: isoTimestampSchema.optional(),
  latest: deploymentSummarySchema.optional(),
});
export type DeveloperAppSummary = z.infer<typeof appSummaryViewSchema>;

export const listAppsViewSchema = z.strictObject({
  apps: z.array(appSummaryViewSchema).max(100),
});
export type ListAppsView = z.infer<typeof listAppsViewSchema>;

export const appInspectionViewSchema = z.strictObject({
  app: appSlugSchema,
  environments: z.array(environmentNameSchema).min(1).max(100),
  active: z.boolean(),
  createdAt: isoTimestampSchema,
  lastActivityAt: isoTimestampSchema.optional(),
  latest: deploymentSummarySchema.optional(),
  selectedEnvironment: environmentNameSchema.optional(),
});
export type AppInspectionView = z.infer<typeof appInspectionViewSchema>;

const namedSurfaceItemSchema = z.strictObject({
  name: z.string().min(1).max(200),
  description: z.string().max(2_000).optional(),
});

const resourceSurfaceItemSchema = z.strictObject({
  uri: z.string().min(1).max(2_048),
  name: z.string().min(1).max(200),
  mimeType: z.string().max(200).optional(),
});

export const deploymentInspectionViewSchema = z.strictObject({
  target: z.strictObject({ app: appSlugSchema, env: environmentNameSchema }),
  deployment: z.strictObject({
    deploymentId: boundedIdSchema,
    endpointUrl: z.url(),
    active: z.boolean(),
    serverName: z.string().min(1).max(200),
    createdAt: isoTimestampSchema,
    createdByEmail: z.email().optional(),
    accessMode: z.string().min(1).max(64),
    ownerSubject: ownerSubjectSchema.optional(),
  }),
  health: z.strictObject({
    state: z.string().min(1).max(100),
    missingSecrets: z.array(z.string().min(1).max(200)).max(100),
  }),
  surface: z.strictObject({
    tools: z.array(namedSurfaceItemSchema).max(1_000),
    resources: z.array(resourceSurfaceItemSchema).max(1_000),
    prompts: z.array(namedSurfaceItemSchema).max(1_000),
    widgets: z.array(resourceSurfaceItemSchema).max(1_000),
    compatibility: z.strictObject({
      mcpApps: z.enum(['pass', 'warn', 'unverified']),
      chatgpt: z.enum(['pass', 'warn', 'unverified']),
      claude: z.enum(['pass', 'warn', 'unverified']),
    }),
  }),
  findings: z
    .array(
      z.strictObject({
        level: z.enum(['warn', 'fail']),
        code: z.string().min(1).max(100),
        message: z.string().min(1).max(2_000),
      }),
    )
    .max(100),
  rollbackCandidate: z
    .strictObject({
      deploymentId: boundedIdSchema,
      serverName: z.string().min(1).max(200),
      createdAt: isoTimestampSchema,
    })
    .optional(),
});
export type DeploymentInspectionView = z.infer<typeof deploymentInspectionViewSchema>;

export const rollbackViewSchema = z.strictObject({
  target: z.strictObject({ app: appSlugSchema, env: environmentNameSchema }),
  rollback: z.strictObject({
    deploymentId: boundedIdSchema,
    serverVersion: z.string().min(1).max(32).optional(),
    previousDeploymentId: boundedIdSchema.optional(),
    alreadyActive: z.boolean(),
    endpointUrl: z.url(),
    accessMode: z.string().min(1).max(64),
    ownerSubject: ownerSubjectSchema.optional(),
    previousAccessMode: z.string().min(1).max(64).optional(),
    serverName: z.string().min(1).max(200),
    createdAt: isoTimestampSchema,
  }),
});
export type RollbackView = z.infer<typeof rollbackViewSchema>;

const safeScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const safeDetailsSchema = z.record(z.string().max(100), safeScalarSchema).optional();

export const logEventSchema = z.strictObject({
  id: boundedIdSchema,
  createdAt: isoTimestampSchema,
  level: z.enum(['debug', 'info', 'warn', 'error']),
  message: z.string().max(4_096),
  deploymentId: boundedIdSchema.optional(),
  toolName: z.string().max(128).optional(),
  executionId: boundedIdSchema.optional(),
  toolCallId: boundedIdSchema.optional(),
  traceId: boundedIdSchema.optional(),
  requestId: boundedIdSchema.optional(),
  details: safeDetailsSchema,
  truncated: z.boolean().optional(),
});
export type DeveloperLogEvent = z.infer<typeof logEventSchema>;

export const logsViewSchema = z.strictObject({
  events: z.array(logEventSchema).max(200),
});
export type LogsView = z.infer<typeof logsViewSchema>;

const countSchema = z.number().int().nonnegative();
const metricNumberSchema = z.number().nonnegative();
export const requestMetricsSchema = z.strictObject({
  totals: z.strictObject({
    requests: countSchema,
    sessions: countSchema,
    legacyInitializations: countSchema,
    toolCalls: countSchema,
    discovery: countSchema,
  }),
  errors: z.strictObject({
    ok: countSchema,
    toolErrors: countSchema,
    mcpErrors: countSchema,
    toolErrorRate: metricNumberSchema,
    mcpErrorRate: metricNumberSchema,
    errorRate: metricNumberSchema,
  }),
  latency: z.strictObject({
    avgMs: metricNumberSchema,
    p50Ms: metricNumberSchema,
    p95Ms: metricNumberSchema,
    p99Ms: metricNumberSchema,
  }),
  tokens: z.strictObject({ total: countSchema, avgPerCall: metricNumberSchema }),
  byTool: z.array(
    z.strictObject({
      tool: z.string().min(1).max(128),
      calls: countSchema,
      errors: countSchema,
      share: metricNumberSchema,
      p95Ms: metricNumberSchema,
    }),
  ),
  byClient: z.array(
    z.strictObject({
      client: z.string().min(1).max(128),
      sessions: countSchema,
      share: metricNumberSchema,
    }),
  ),
  byClientFamily: z.array(
    z.strictObject({
      family: z.string().min(1).max(32),
      requests: countSchema,
      errors: countSchema,
      share: metricNumberSchema,
      lastSuccessfulAt: isoTimestampSchema.optional(),
      protocolEras: z.strictObject({
        legacy: countSchema,
        modern: countSchema,
        unknown: countSchema,
      }),
    }),
  ),
  clientActivity: z.strictObject({
    callers: z.array(
      z.strictObject({
        family: z.string().min(1).max(32),
        attribution: z.enum(['known_client', 'self_reported', 'transport_only', 'unattributed']),
        reportedName: z.string().min(1).max(128).optional(),
        requests: countSchema,
        errors: countSchema,
        share: metricNumberSchema,
        lastSuccessfulAt: isoTimestampSchema.optional(),
        protocolEras: z.strictObject({
          legacy: countSchema,
          modern: countSchema,
          unknown: countSchema,
        }),
      }),
    ),
    legacyHandshakes: z.strictObject({
      total: countSchema,
      byReportedClient: z.array(
        z.strictObject({
          reportedName: z.string().min(1).max(128).optional(),
          initializations: countSchema,
          share: metricNumberSchema,
          lastInitializedAt: isoTimestampSchema,
        }),
      ),
    }),
  }),
  byMethod: z.array(
    z.strictObject({
      method: z.string().min(1).max(128),
      requests: countSchema,
      share: metricNumberSchema,
    }),
  ),
  series: z.array(
    z.strictObject({
      bucketStart: isoTimestampSchema,
      requests: countSchema,
      toolErrors: countSchema,
      mcpErrors: countSchema,
    }),
  ),
});
export type DeveloperRequestMetrics = z.infer<typeof requestMetricsSchema>;

export const metricsViewSchema = z.strictObject({
  window: z.strictObject({ since: isoTimestampSchema, until: isoTimestampSchema.optional() }),
  truncated: z.boolean(),
  metrics: requestMetricsSchema,
});
export type MetricsView = z.infer<typeof metricsViewSchema>;

export const requestEventSchema = z.strictObject({
  id: boundedIdSchema,
  seq: countSchema.optional(),
  schemaVersion: countSchema.optional(),
  createdAt: isoTimestampSchema,
  deploymentId: boundedIdSchema.optional(),
  serverVersion: z.string().max(32).optional(),
  sdkProtocolVersion: z.string().max(32).optional(),
  requestId: boundedIdSchema,
  sessionId: boundedIdSchema.optional(),
  sessionSource: z.enum(['mcp', 'synthetic', 'none']),
  clientName: z.string().max(128).optional(),
  clientVersion: z.string().max(64).optional(),
  accessMode: z.string().max(64).optional(),
  subjectKind: z.enum(['anonymous', 'authenticated']),
  method: z.string().min(1).max(128),
  kind: z.enum(['usage', 'discovery']),
  toolName: z.string().max(128).optional(),
  resourceName: z.string().max(500).optional(),
  promptName: z.string().max(128).optional(),
  outcome: z.enum(['ok', 'tool_error', 'mcp_error']),
  errorKind: z.string().max(128).optional(),
  durationMs: metricNumberSchema,
  outputTokensEst: countSchema.optional(),
  country: z.string().max(8).optional(),
  details: safeDetailsSchema,
});
export type DeveloperRequestEvent = z.infer<typeof requestEventSchema>;

export const eventsViewSchema = z.strictObject({
  events: z.array(requestEventSchema).max(500),
});
export type EventsView = z.infer<typeof eventsViewSchema>;

export const sessionViewSchema = z.strictObject({
  sessionId: boundedIdSchema,
  events: z.array(requestEventSchema).max(1_000),
});
export type SessionView = z.infer<typeof sessionViewSchema>;

export const developerNextActionSchema = z.strictObject({
  kind: z.enum(['call_tool', 'run_cli', 'read_resource', 'inspect_code']),
  label: z.string().min(1).max(200),
  tool: z.string().min(1).max(100).optional(),
  command: z.string().min(1).max(500).optional(),
  resource: z.string().min(1).max(2_048).optional(),
});
export type DeveloperNextAction = z.infer<typeof developerNextActionSchema>;

export const developerResultMetaSchema = z.strictObject({
  capabilityVersion: z.literal(DEVELOPER_MCP_CAPABILITY_VERSION),
  org: tenantSlugSchema.optional(),
  env: environmentNameSchema.optional(),
  observedAt: isoTimestampSchema,
  nextActions: z.array(developerNextActionSchema).max(20),
});
export type DeveloperResultMeta = z.infer<typeof developerResultMetaSchema>;

const developerFailureSchema = z.strictObject({
  ok: z.literal(false),
  error: z.strictObject({
    code: developerErrorCodeSchema,
    message: z.string().min(1).max(2_000),
    retryable: z.boolean(),
  }),
  meta: developerResultMetaSchema,
});

export function developerResultSchema<T extends z.ZodType>(data: T) {
  return z
    .strictObject({
      ok: z.boolean(),
      data: data.optional(),
      error: developerFailureSchema.shape.error.optional(),
      meta: developerResultMetaSchema,
    })
    .superRefine((value, issue) => {
      if (value.ok && value.data === undefined) {
        issue.addIssue({
          code: 'custom',
          message: 'successful results require data',
          path: ['data'],
        });
      }
      if (!value.ok && value.error === undefined) {
        issue.addIssue({
          code: 'custom',
          message: 'failed results require error',
          path: ['error'],
        });
      }
      if (value.ok && value.error !== undefined) {
        issue.addIssue({
          code: 'custom',
          message: 'successful results cannot include error',
          path: ['error'],
        });
      }
      if (!value.ok && value.data !== undefined) {
        issue.addIssue({
          code: 'custom',
          message: 'failed results cannot include data',
          path: ['data'],
        });
      }
    });
}

export interface DeveloperSuccess<T> {
  readonly ok: true;
  readonly data: T;
  readonly meta: DeveloperResultMeta;
}

export interface DeveloperFailure {
  readonly ok: false;
  readonly error: {
    readonly code: DeveloperErrorCode;
    readonly message: string;
    readonly retryable: boolean;
  };
  readonly meta: DeveloperResultMeta;
}

export type DeveloperResult<T> = DeveloperSuccess<T> | DeveloperFailure;
