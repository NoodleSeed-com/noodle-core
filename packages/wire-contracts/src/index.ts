/**
 * Dependency-light request/response shapes shared across the developer toolchain and hosted service.
 * This file directly owns the Core v1 deploy lane (ADR 0150); focused modules own other wire families,
 * including billing and platform operator contracts. Golden fixtures under `contract/v1/` pin them.
 * Changing a Core v1 shape is a version event, not a local edit.
 *
 * Everything else about those routes (auth, audit, business rules) stays in the owning package;
 * this package is wire shape only and stays dependency-light (zod plus lower-level data contracts).
 */
import { z } from 'zod';
import { accessModeSchema } from './access-mode.js';
import { deploymentAuthenticationSchema, deploymentOwnerSubjectSchema } from './control-plane.js';

export * from './access-mode.js';
export * from './app-purge-reconciliation.js';
export * from './application-channels.js';
export * from './application-settings.js';
export * from './assistant.js';
export * from './billing-operations.js';
export * from './billing-org-transfer.js';
export * from './billing-read.js';
export * from './business-information.js';
export * from './business-information-query.js';
export * from './config.js';
export * from './control-plane.js';
export * from './deployment-package.js';
export * from './distribution.js';
export * from './feedback.js';
export * from './knowledge.js';
export * from './managed-assistant-sponsorship.js';
export * from './platform-account-reset.js';
export * from './platform-auth.js';
export * from './solution-onboarding.js';

// ─── Deploy ─────────────────────────────────────────────────────────────────────

/** Informational origin of a deployment; never an authorization or policy input. */
export const DEPLOYMENT_SOURCES = ['console-example', 'cli', 'github', 'api'] as const;

export const deploymentSourceSchema = z.enum(DEPLOYMENT_SOURCES);
export type DeploymentSource = z.infer<typeof deploymentSourceSchema>;

const nonNegativeInt = z.number().int().nonnegative();

/** A packaged asset already hosted in object storage, referenced by the manifest being deployed. */
export const hostedAssetSchema = z.object({
  logicalId: z.string().min(1),
  sourcePath: z.string().min(1),
  contentHash: z.string().min(1),
  mimeType: z.string().min(1),
  byteLength: nonNegativeInt,
  width: nonNegativeInt,
  height: nonNegativeInt,
  publicUrl: z.string().min(1),
  objectKey: z.string().min(1),
});
export type HostedAssetWire = z.infer<typeof hostedAssetSchema>;

/**
 * `POST /v1/orgs/{org}/apps/{app}/envs/{env}/deploy`. `manifest` (and `connectors`) are JSON
 * documents carried as strings — the manifest's own schema is the compiler's contract, not this
 * one. `accessMode` defaults server-side to `owner-only` (GitHub run deploys resolve
 * inherit → declared instead); `serverVersion` defaults to `"1"`.
 */
/**
 * Which membership sources an `org-members` deployment accepts (ADR 0183). Absent means every source;
 * an empty list is rejected here because it would deploy an endpoint nobody can call.
 */
export const ORG_MEMBERSHIP_SOURCES = ['explicit', 'domain'] as const;
export const orgMembershipSourceSchema = z.enum(ORG_MEMBERSHIP_SOURCES);
export type OrgMembershipSource = z.infer<typeof orgMembershipSourceSchema>;

export const deployRequestSchema = z
  .object({
    manifest: z.string().min(1),
    connectors: z.string().min(1).optional(),
    hostedAssets: z.array(hostedAssetSchema).optional(),
    accessMode: accessModeSchema.optional(),
    ownerSubject: deploymentOwnerSubjectSchema.optional(),
    orgMembershipSources: z.array(orgMembershipSourceSchema).min(1).optional(),
    serverVersion: z.string().min(1).optional(),
    deploymentSource: deploymentSourceSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.ownerSubject !== undefined && (value.accessMode ?? 'owner-only') !== 'owner-only') {
      context.addIssue({
        code: 'custom',
        path: ['ownerSubject'],
        message: 'ownerSubject is valid only with owner-only access',
      });
    }
  });
export type DeployRequest = z.infer<typeof deployRequestSchema>;

/** Exact bytes both sides bind when deriving a retry-safe deploy key. */
export function deployIdempotencyMaterial(
  target: { readonly org: string; readonly app: string; readonly env: string },
  requestBody: string,
): string {
  return `${target.org}\n${target.app}\n${target.env}\n${requestBody}`;
}

/** The HTTP 201 deploy response. */
export const deploySuccessResponseSchema = z.object({
  ok: z.literal(true),
  org: z.string().min(1),
  app: z.string().min(1),
  env: z.string().min(1),
  deploymentId: z.string().min(1),
  serverVersion: z.string().min(1),
  accessMode: accessModeSchema,
  /** Effective authority reported by capable services; absence means unknown on older services. */
  authentication: deploymentAuthenticationSchema.optional(),
  ownerSubject: deploymentOwnerSubjectSchema.optional(),
  url: z.string().min(1),
  defaultUrl: z.string().min(1),
  /**
   * The non-secret public embed id, present only when the deployed app declares a public or mixed
   * website surface (ADR 0201). Additive and optional: an app without one returns the shape unchanged,
   * which is why the v1 golden fixture still carries no `embedId`.
   */
  embedId: z.string().min(1).optional(),
});
export type DeploySuccessResponse = z.infer<typeof deploySuccessResponseSchema>;

/**
 * Any non-201 deploy-lane error body. Two families share it: request/policy rejections carry a
 * human-readable `error` (plus an optional machine-readable `code` — the GitHub-run lane always sets
 * one), while compile failures carry `ok: false` with structured `errors` and no `error` string.
 */
export const deployErrorResponseSchema = z.object({
  ok: z.literal(false).optional(),
  error: z.string().optional(),
  code: z.string().optional(),
  errors: z.unknown().optional(),
});
export type DeployErrorResponse = z.infer<typeof deployErrorResponseSchema>;

// ─── Deploy preflight ─────────────────────────────────────────────────────────────

/** Checking budget after upload/authorization; the client allows additional upload/response time. */
export const DEPLOY_PREFLIGHT_CHECK_TIMEOUT_MS = 60_000;
export const DEPLOY_PREFLIGHT_CLIENT_TIMEOUT_MS = 75_000;

/**
 * `POST /v1/orgs/{org}/apps/{app}/envs/{env}/deploy/preflight` accepts the same
 * declarative input as deploy, but performs no deployment or asset upload.
 */
export const deployPreflightRequestSchema = deployRequestSchema;
export type DeployPreflightRequest = z.infer<typeof deployPreflightRequestSchema>;

export const deployTargetStateSchema = z.enum(['existing', 'will-create']);
export type DeployTargetState = z.infer<typeof deployTargetStateSchema>;

const deployPreflightErrorSchema = z.object({
  code: z.string().min(1),
  path: z.string(),
  message: z.string().min(1),
});

/**
 * A complete, value-free readiness result. Missing config names are safe structural
 * metadata; secret and variable values are never accepted or returned by this route.
 */
export const deployPreflightResponseSchema = z.object({
  ok: z.literal(true),
  ready: z.boolean(),
  ownerSubject: deploymentOwnerSubjectSchema.optional(),
  target: z.object({
    org: z.string().min(1),
    app: z.string().min(1),
    env: z.string().min(1),
    appState: deployTargetStateSchema,
    environmentState: deployTargetStateSchema,
  }),
  config: z.object({
    ready: z.boolean(),
    missingSecrets: z.array(z.string().min(1)),
    missingVariables: z.array(z.string().min(1)),
  }),
  errors: z.array(deployPreflightErrorSchema),
});
export type DeployPreflightResponse = z.infer<typeof deployPreflightResponseSchema>;

// ─── Asset preflight ────────────────────────────────────────────────────────────

/** A locally prepared asset offered for hosting (the CLI strips its local `absolutePath`). */
export const preparedAssetSchema = z.object({
  logicalId: z.string().min(1),
  sourcePath: z.string().min(1),
  contentHash: z.string().min(1),
  mimeType: z.string().min(1),
  byteLength: nonNegativeInt,
  width: nonNegativeInt,
  height: nonNegativeInt,
});
export type PreparedAssetWire = z.infer<typeof preparedAssetSchema>;

/** `POST /v1/orgs/{org}/apps/{app}/envs/{env}/assets/preflight`. */
export const assetPreflightRequestSchema = z.object({
  assets: z.array(preparedAssetSchema),
});
export type AssetPreflightRequest = z.infer<typeof assetPreflightRequestSchema>;

/** One signed upload target for an asset the store does not already hold. */
export const assetUploadTargetSchema = z.object({
  logicalId: z.string().min(1),
  uploadUrl: z.string().min(1),
  method: z.literal('PUT'),
  headers: z.record(z.string(), z.string()),
  expiresAt: z.string().optional(),
});
export type AssetUploadTarget = z.infer<typeof assetUploadTargetSchema>;

/** The HTTP 200 preflight response: the full hosted plan plus targets still needing bytes. */
export const assetPreflightResponseSchema = z.object({
  ok: z.literal(true),
  assetOrigin: z.string().optional(),
  assets: z.array(hostedAssetSchema),
  uploads: z.array(assetUploadTargetSchema),
});
export type AssetPreflightResponse = z.infer<typeof assetPreflightResponseSchema>;

// ─── Managed config values (secrets/variables) ──────────────────────────────────

/** `PUT /v1/orgs/{org}[/apps/{app}[/envs/{env}]]/(secrets|variables)/{name}`. */
export const configValueSetRequestSchema = z.object({
  value: z.string(),
});
export type ConfigValueSetRequest = z.infer<typeof configValueSetRequestSchema>;

export const configScopeSchema = z.discriminatedUnion('level', [
  z.object({ level: z.literal('org'), org: z.string().min(1) }),
  z.object({ level: z.literal('app'), org: z.string().min(1), app: z.string().min(1) }),
  z.object({
    level: z.literal('env'),
    org: z.string().min(1),
    app: z.string().min(1),
    env: z.string().min(1),
  }),
]);

/** One managed config value as reported by the service (`value` present only for variables). */
export const configValueMetadataSchema = z.object({
  kind: z.enum(['secret', 'variable']),
  scope: configScopeSchema,
  name: z.string().min(1),
  updatedAt: z.string().min(1),
  updatedBySubject: z.string().optional(),
  updatedByEmail: z.string().optional(),
  value: z.string().optional(),
});
export type ConfigValueMetadataWire = z.infer<typeof configValueMetadataSchema>;

export const configValueSetResponseSchema = z.object({
  ok: z.literal(true),
  value: configValueMetadataSchema,
});

export const configValuesListResponseSchema = z.object({
  ok: z.literal(true),
  values: z.array(configValueMetadataSchema),
});

// ─── Error formatting ───────────────────────────────────────────────────────────

/** Render a wire-schema failure as one actionable line (first issue, dotted path first). */
export function formatWireError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return 'invalid request body';
  const path = issue.path.map(String).join('.');
  return path === '' ? issue.message : `"${path}": ${issue.message}`;
}

export * from './application-activity.js';
export * from './application-connections.js';
export * from './application-onboarding.js';
export * from './billing-catalog.js';
export * from './operation-coordination.js';

export {
  MIXED_CUSTOMER_AUTH_FEATURE_VERSION,
  type ServiceInfoClientResponse,
  type ServiceInfoResponse,
  serviceInfoClientResponseSchema,
  serviceInfoResponseSchema,
} from './service-info.js';
