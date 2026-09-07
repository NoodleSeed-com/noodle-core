import type { CallToolResult } from '@modelcontextprotocol/server';
import { SERVER_VERSION_PATTERN } from '@noodle-borg/module';
import { CONFIG_NAME_PATTERN, SLUG_PATTERN } from '@noodle-borg/service/local';
import { deployPreflightResponseSchema } from '@noodle-borg/wire-contracts';
import { z } from 'zod';
import { type BootstrapStatus, bootstrapStatusSchema } from '../project-bootstrap-report.js';

const handleSchema = z.string().regex(/^[A-Za-z0-9_-]{22,128}$/);
const slugSchema = z.string().regex(SLUG_PATTERN);
const configNameSchema = z.string().regex(CONFIG_NAME_PATTERN).max(128);
const environmentNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);
const targetFields = {
  workspaceHandle: handleSchema,
  org: slugSchema,
  app: slugSchema,
  environment: slugSchema,
} as const;

export const cloudTargetInputSchema = z.strictObject(targetFields);
export type CloudTargetInput = z.infer<typeof cloudTargetInputSchema>;

export const preflightInputSchema = cloudTargetInputSchema.extend({
  version: z.string().regex(SERVER_VERSION_PATTERN).max(64).optional(),
});
export const preflightReportSchema = deployPreflightResponseSchema
  .extend({
    published: z.literal(false),
    serverVersion: z.string(),
  })
  .refine(
    (value) =>
      value.ready &&
      value.config.ready &&
      value.errors.length === 0 &&
      value.config.missingSecrets.length === 0 &&
      value.config.missingVariables.length === 0,
    'preflight success requires consistent readiness',
  );
export const preflightDiagnosticsSchema = z.object({
  missingSecrets: z.array(configNameSchema).max(256),
  missingVariables: z.array(configNameSchema).max(256),
  actions: z.array(z.string().startsWith('noodle ').max(2048)).max(512),
  errors: z
    .array(
      z.object({
        code: z.string().max(128),
        path: z.string().max(1024),
        message: z.string().max(2048),
      }),
    )
    .max(256),
});

export const setupInputSchema = z.strictObject({
  workspaceHandle: handleSchema,
  mode: z.enum(['initialize', 'reconcile']),
  template: z.enum(['hello', 'saas', 'http-api', 'widget']).optional(),
  packageManager: z.enum(['npm', 'pnpm', 'yarn']).optional(),
  install: z.boolean().optional(),
});
export const linkInputSchema = z.strictObject({
  ...targetFields,
  access: z
    .enum(['owner-only', 'org-members', 'authenticated', 'public', 'mixed', 'customers'])
    .optional(),
});
export const variableInputSchema = z.strictObject({
  ...targetFields,
  name: configNameSchema,
  value: z.string().max(64 * 1024),
});
export const secretInputSchema = z.strictObject({
  ...targetFields,
  name: configNameSchema,
  sourceEnvironmentVariable: environmentNameSchema,
});
const feedbackFields = {
  workspaceHandle: handleSchema,
  message: z.string().min(1).max(4_000),
  title: z.string().min(1).max(120).optional(),
  type: z.enum(['fix', 'feat', 'docs', 'chore']),
  severity: z.enum(['P0', 'P1', 'P2', 'P3']),
  area: z.enum([
    'docs',
    'analytics',
    'connectors',
    'self-service',
    'conformance',
    'ci',
    'deploys',
    'distribution',
    'console',
    'dx',
    'plugins',
    'cli',
    'compiler',
    'multi-surface',
    'enterprise',
    'policy',
  ]),
} as const;
export const feedbackPreviewInputSchema = z.strictObject(feedbackFields);
export const feedbackSubmitInputSchema = z.strictObject({
  ...feedbackFields,
  approved: z.literal(true),
});

const targetDataSchema = z.strictObject({
  runtime: z.literal('cloud'),
  org: slugSchema,
  app: slugSchema,
  environment: slugSchema,
});
const operationDataSchema = z.strictObject({
  operation: z.enum([
    'preflight',
    'initialize',
    'reconcile',
    'link',
    'set-variable',
    'set-secret',
    'preview-feedback',
    'submit-feedback',
  ]),
  command: z.string(),
  target: targetDataSchema.optional(),
  name: configNameSchema.optional(),
  reference: z.string().max(200).optional(),
  setup: bootstrapStatusSchema.optional(),
  preflight: preflightReportSchema.optional(),
});
export const operationResultSchema = z
  .strictObject({
    ok: z.boolean(),
    data: operationDataSchema.optional(),
    error: z
      .strictObject({
        code: z.string(),
        message: z.string(),
        command: z.string().optional(),
        next: z.string().optional(),
        setup: bootstrapStatusSchema.optional(),
        preflight: preflightDiagnosticsSchema.optional(),
      })
      .optional(),
  })
  .superRefine((value, context) => {
    if (value.ok && value.data === undefined)
      context.addIssue({ code: 'custom', path: ['data'], message: 'success requires data' });
    if (!value.ok && value.error === undefined)
      context.addIssue({ code: 'custom', path: ['error'], message: 'failure requires error' });
  });

export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
export const LOCAL_MUTATION = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;
export const CLOUD_MUTATION = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

export function targetFlags(target: CloudTargetInput): readonly string[] {
  return [
    '--runtime',
    'cloud',
    '--scope',
    'env',
    '--org',
    target.org,
    '--app',
    target.app,
    '--env',
    target.environment,
  ];
}

export function publicTargetFlags(target: CloudTargetInput): string {
  return targetFlags(target).join(' ');
}

export function targetData(target: CloudTargetInput) {
  return {
    runtime: 'cloud' as const,
    org: target.org,
    app: target.app,
    environment: target.environment,
  };
}

export function operationSuccess(
  message: string,
  data: z.infer<typeof operationDataSchema>,
): CallToolResult {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { ok: true, data },
  };
}

export function operationFailure(
  code: string,
  message: string,
  command: string,
  next?: string,
  setup?: BootstrapStatus,
  preflight?: z.infer<typeof preflightDiagnosticsSchema>,
): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
    structuredContent: {
      ok: false,
      error: {
        code,
        message,
        command,
        ...(next === undefined ? {} : { next }),
        ...(setup === undefined ? {} : { setup }),
        ...(preflight === undefined ? {} : { preflight }),
      },
    },
  };
}
