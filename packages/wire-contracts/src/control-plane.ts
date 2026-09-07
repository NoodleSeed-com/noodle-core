/** Strict service-output contracts for control-plane reads and mutations (ADR 0128). */
import { z } from 'zod';
import { accessModeSchema } from './access-mode.js';

function containsC0OrDel(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) return true;
  }
  return false;
}

/** Exact OAuth subject bound by an operator to an owner-only deployment. */
export const deploymentOwnerSubjectSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) => value.trim() === value && !containsC0OrDel(value),
    'owner subject must not contain outer whitespace or C0/DEL control characters',
  );

export const accessUpdateRequestSchema = z
  .object({
    accessMode: accessModeSchema,
    ownerSubject: deploymentOwnerSubjectSchema.optional(),
    serverVersion: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.ownerSubject !== undefined && value.accessMode !== 'owner-only') {
      context.addIssue({
        code: 'custom',
        path: ['ownerSubject'],
        message: 'ownerSubject is valid only with owner-only access',
      });
    }
  });

export const accessUpdateResponseSchema = z
  .object({
    ok: z.literal(true),
    target: z
      .object({
        org: z.string().min(1),
        app: z.string().min(1),
        env: z.string().min(1),
      })
      .strict(),
    deployment: z
      .object({
        deploymentId: z.string().min(1),
        serverVersion: z.string().min(1).optional(),
        accessMode: accessModeSchema,
        ownerSubject: deploymentOwnerSubjectSchema.optional(),
      })
      .strict(),
    previousAccessMode: accessModeSchema,
    previousOwnerSubject: deploymentOwnerSubjectSchema.optional(),
    accessChanged: z.boolean(),
    ownerChanged: z.boolean(),
    changed: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.deployment.accessMode === 'owner-only' &&
      value.deployment.ownerSubject === undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['deployment', 'ownerSubject'],
        message: 'owner-only access requires a current owner subject',
      });
    }
    if (value.changed !== (value.accessChanged || value.ownerChanged)) {
      context.addIssue({
        code: 'custom',
        path: ['changed'],
        message: 'changed must equal accessChanged || ownerChanged',
      });
    }
  });
export type AccessUpdateResponse = z.output<typeof accessUpdateResponseSchema>;

/**
 * Additive client reader for the access mutation response. Older services emitted only the aggregate
 * `changed` bit, so the mode component is derived from the authoritative previous/current modes while an
 * unobservable owner component remains omitted. Modern component bits retain the strict cross-field check.
 */
export const accessUpdateClientResponseSchema = z
  .object({
    ok: z.literal(true),
    target: z.object({
      org: z.string().min(1),
      app: z.string().min(1),
      env: z.string().min(1),
    }),
    deployment: z.object({
      deploymentId: z.string().min(1),
      serverVersion: z.string().min(1).optional(),
      accessMode: accessModeSchema,
      ownerSubject: deploymentOwnerSubjectSchema.optional(),
    }),
    previousAccessMode: accessModeSchema,
    previousOwnerSubject: deploymentOwnerSubjectSchema.optional(),
    accessChanged: z.boolean().optional(),
    ownerChanged: z.boolean().optional(),
    changed: z.boolean(),
  })
  .superRefine((value, context) => {
    const modernComponents = value.accessChanged !== undefined && value.ownerChanged !== undefined;
    if ((value.accessChanged === undefined) !== (value.ownerChanged === undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['accessChanged'],
        message: 'accessChanged and ownerChanged must be present together',
      });
    }
    if (
      modernComponents &&
      value.deployment.accessMode === 'owner-only' &&
      value.deployment.ownerSubject === undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['deployment', 'ownerSubject'],
        message: 'owner-only access requires a current owner subject',
      });
    }
    if (modernComponents && value.changed !== (value.accessChanged || value.ownerChanged)) {
      context.addIssue({
        code: 'custom',
        path: ['changed'],
        message: 'changed must equal accessChanged || ownerChanged',
      });
    }
  })
  .transform((value) => ({
    ...value,
    accessChanged: value.accessChanged ?? value.previousAccessMode !== value.deployment.accessMode,
  }));
export type AccessUpdateClientResponse = z.output<typeof accessUpdateClientResponseSchema>;

/** Bounded identity-only projection for `GET /v1/whoami?scope=identity`. */
const whoamiIdentityShape = {
  ok: z.literal(true),
  data: {
    identity: {
      subject: z.string().min(1),
      email: z.string().min(1),
      superAdmin: z.boolean(),
    },
  },
} as const;

export const WhoamiIdentityResponseSchema = z.strictObject({
  ok: whoamiIdentityShape.ok,
  data: z.strictObject({
    identity: z.strictObject(whoamiIdentityShape.data.identity),
  }),
});
export const WhoamiIdentityClientResponseSchema = z.object({
  ok: whoamiIdentityShape.ok,
  data: z.object({
    identity: z.object(whoamiIdentityShape.data.identity),
  }),
});
export type WhoamiIdentityResponse = z.infer<typeof WhoamiIdentityResponseSchema>;

export const deploymentLockRequestSchema = z
  .object({
    serverVersion: z.string().min(1),
    expectedDeploymentId: z.string().min(1),
    locked: z.boolean(),
  })
  .strict();

const DeploymentLockMetadataSchema = z
  .object({
    lockedAt: z.string(),
    lockedByEmail: z.string().optional(),
  })
  .strict();

/** Mirrors the service store's deployment summary. */
export const DeploymentSummarySchema = z
  .object({
    deploymentId: z.string(),
    orgSlug: z.string(),
    appSlug: z.string(),
    environment: z.string(),
    serverVersion: z.string().optional(),
    active: z.boolean(),
    serverName: z.string(),
    createdAt: z.string(),
    createdByEmail: z.string().optional(),
    ownerSubject: deploymentOwnerSubjectSchema.optional(),
    deploymentSource: z.string().optional(),
    accessMode: accessModeSchema,
    deploymentLock: DeploymentLockMetadataSchema.optional(),
    archivedAt: z.string().optional(),
    endpointUrl: z.string().optional(),
  })
  .strict();
export type DeploymentSummary = z.output<typeof DeploymentSummarySchema>;

/** Mirrors the service store's org record — the `GET /v1/orgs/{org}` response `data`. */
export const OrgSummarySchema = z
  .object({
    slug: z.string(),
    displayName: z.string().optional(),
    createdAt: z.string(),
  })
  .strict();
export type OrgSummary = z.output<typeof OrgSummarySchema>;

/** Mirrors the service store's app summary. */
export const AppSummarySchema = z
  .object({
    orgSlug: z.string(),
    appSlug: z.string(),
    environments: z.array(z.string()),
    latest: DeploymentSummarySchema.optional(),
    accessMode: z.string().optional(),
    active: z.boolean(),
    archivedAt: z.string().optional(),
    createdAt: z.string(),
    lastActivityAt: z.string().optional(),
  })
  .strict();
export type AppSummary = z.output<typeof AppSummarySchema>;

/** The full `GET /v1/orgs/{org}/apps` response body. */
export const AppsListResponseSchema = z
  .object({
    ok: z.literal(true),
    data: z
      .object({
        apps: z.array(AppSummarySchema),
        truncated: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type AppsListResponse = z.output<typeof AppsListResponseSchema>;

/** The full `GET /v1/orgs/{org}/apps/{app}` response body (app inspect). */
export const AppResponseSchema = z
  .object({
    ok: z.literal(true),
    data: AppSummarySchema,
  })
  .strict();
export type AppResponse = z.output<typeof AppResponseSchema>;

/** Mirrors the service store's environment summary. */
export const EnvSummarySchema = z
  .object({
    orgSlug: z.string(),
    appSlug: z.string(),
    envName: z.string(),
    isProduction: z.boolean(),
    latest: DeploymentSummarySchema.optional(),
    accessMode: z.string().optional(),
    active: z.boolean(),
    archivedAt: z.string().optional(),
    createdAt: z.string(),
    lastActivityAt: z.string().optional(),
    deploymentCount: z.number().int().nonnegative(),
  })
  .strict();
export type EnvSummary = z.output<typeof EnvSummarySchema>;

/** The full `GET /v1/orgs/{org}/apps/{app}/envs` response body. No pagination — env counts per app are small. */
export const EnvsListResponseSchema = z
  .object({
    ok: z.literal(true),
    data: z
      .object({
        envs: z.array(EnvSummarySchema),
      })
      .strict(),
  })
  .strict();
export type EnvsListResponse = z.output<typeof EnvsListResponseSchema>;

/** The full `GET /v1/orgs/{org}/apps/{app}/envs/{env}` response body (env inspect). */
export const EnvResponseSchema = z
  .object({
    ok: z.literal(true),
    data: EnvSummarySchema,
  })
  .strict();
export type EnvResponse = z.output<typeof EnvResponseSchema>;

export const ProductionEnvironmentRequestSchema = z.object({ environment: z.string() }).strict();

export const ProductionEnvironmentResponseSchema = z
  .object({
    ok: z.literal(true),
    data: z
      .object({
        orgSlug: z.string(),
        appSlug: z.string(),
        productionEnvironment: z.string(),
        previousProductionEnvironment: z.string().nullable(),
        changed: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type ProductionEnvironmentResponse = z.output<typeof ProductionEnvironmentResponseSchema>;

export const McpSubdomainMutationRequestSchema = z
  .object({
    mcpSubdomain: z.string(),
    acknowledgeOldUrlsStopWorking: z.literal(true),
  })
  .strict();

export const McpSubdomainSettingResponseSchema = z
  .object({
    ok: z.literal(true),
    data: z
      .object({
        orgSlug: z.string(),
        mcpSubdomain: z.string(),
        mcpServerHost: z.string().nullable(),
        changeAllowedAt: z.string().nullable(),
      })
      .strict(),
  })
  .strict();

export const McpSubdomainMutationResponseSchema = z
  .object({
    ok: z.literal(true),
    data: z
      .object({
        orgSlug: z.string(),
        previousMcpSubdomain: z.string(),
        previousMcpServerHost: z.string().nullable(),
        mcpSubdomain: z.string(),
        mcpServerHost: z.string().nullable(),
        changed: z.boolean(),
        replayed: z.boolean(),
        changedAt: z.string().nullable(),
        changeAllowedAt: z.string().nullable(),
        oldUrlsInvalidated: z.boolean(),
        reauthorizationRequired: z.boolean(),
      })
      .strict(),
  })
  .strict();

/** The full `GET /v1/orgs/{org}/deployments/{deploymentId}` response body (deployment inspect). */
export const DeploymentResponseSchema = z
  .object({
    ok: z.literal(true),
    data: DeploymentSummarySchema,
  })
  .strict();
export type DeploymentResponse = z.output<typeof DeploymentResponseSchema>;

/** Mirrors the service store's GHD-1 GitHub repository connection. */
export const RepoConnectionSchema = z
  .object({
    githubRepositoryId: z.number().int().positive(),
    installationId: z.number().int().positive(),
    ownerLogin: z.string(),
    repoName: z.string(),
    defaultBranch: z.string(),
    repoRoot: z.string().optional(),
    orgSlug: z.string(),
    appSlug: z.string(),
    enabled: z.boolean(),
    createdBySubject: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type RepoConnection = z.output<typeof RepoConnectionSchema>;

/** The full `GET`/`POST /v1/orgs/{org}/apps/{app}/github/connection` response body. */
export const GithubConnectionResponseSchema = z
  .object({
    ok: z.literal(true),
    data: RepoConnectionSchema,
  })
  .strict();
export type GithubConnectionResponse = z.output<typeof GithubConnectionResponseSchema>;

/** One webhook-accepted deploy run (GHD-2), mirroring the service store record. */
export const DeployRunSchema = z
  .object({
    runId: z.string(),
    orgSlug: z.string(),
    appSlug: z.string(),
    envName: z.string(),
    sourceEvent: z.enum(['push', 'pull_request']),
    deliveryId: z.string(),
    githubRepositoryId: z.number().int().positive(),
    commitSha: z.string(),
    ref: z.string(),
    prNumber: z.number().int().positive().optional(),
    status: z.enum([
      'queued',
      'building',
      'deploying',
      'deployed',
      'failed',
      'canceled',
      'superseded',
    ]),
    blockedReason: z.string().optional(),
    deploymentId: z.string().optional(),
    actorLogin: z.string(),
    errorSummary: z.string().optional(),
    createdAt: z.string(),
    startedAt: z.string().optional(),
    finishedAt: z.string().optional(),
  })
  .strict();
export type DeployRun = z.output<typeof DeployRunSchema>;

/** The full `GET /v1/orgs/{org}/apps/{app}/github/runs` response body. */
export const GithubRunsListResponseSchema = z
  .object({
    ok: z.literal(true),
    data: z
      .object({
        runs: z.array(DeployRunSchema),
        truncated: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type GithubRunsListResponse = z.output<typeof GithubRunsListResponseSchema>;

/** The full `GET /v1/github/install-url` response body. */
export const GithubInstallUrlResponseSchema = z
  .object({
    ok: z.literal(true),
    data: z
      .object({
        installUrl: z.string(),
        state: z.string(),
      })
      .strict(),
  })
  .strict();

/**
 * The redacted public view of an alert rule (analytics alerting E2, ADR 0130). Deliberately has
 * NO `webhookUrl` field and is `.strict()`: the sensitive URL structurally cannot pass this
 * contract, so a would-be leak fails the parse (a 500) instead of reaching the wire. `webhook`
 * carries only the redacted origin form (e.g. `https://hooks.example.com/…`).
 */
export const AlertRuleSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    metric: z.enum(['error_share', 'error_count', 'calls', 'p95_ms']),
    threshold: z.number(),
    windowMinutes: z.number(),
    comparison: z.literal('>='),
    webhook: z.string(),
    enabled: z.boolean(),
    cooldownMinutes: z.number(),
    breaching: z.boolean(),
    lastObserved: z.number().optional(),
    lastFiredAt: z.string().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

/** The full `POST /v1/orgs/{org}/apps/{app}/envs/{env}/alerts` response body. */
export const AlertRuleResponseSchema = z
  .object({
    ok: z.literal(true),
    data: AlertRuleSchema,
  })
  .strict();

/** The full `GET /v1/orgs/{org}/apps/{app}/envs/{env}/alerts` response body. */
export const AlertRulesListResponseSchema = z
  .object({
    ok: z.literal(true),
    data: z.object({ rules: z.array(AlertRuleSchema) }).strict(),
  })
  .strict();
