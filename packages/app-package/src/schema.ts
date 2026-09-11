import { z } from 'zod';
import { canonicalJson } from './canonical.js';
import {
  APP_PACKAGE_V1_MAX_AUTHORIZATION_VALUES,
  APP_PACKAGE_V1_MAX_BOUNDARIES,
  APP_PACKAGE_V1_MAX_CANONICAL_BYTES,
  APP_PACKAGE_V1_MAX_EXAMPLES,
  APP_PACKAGE_V1_MAX_IDENTIFIER_CHARS,
  APP_PACKAGE_V1_MAX_PROMPT_ARGUMENTS,
  APP_PACKAGE_V1_MAX_PROSE_CHARS,
  APP_PACKAGE_V1_MAX_SCHEMA_FIELDS,
  APP_PACKAGE_V1_MAX_SURFACE_ITEMS,
  APP_PACKAGE_V1_MAX_USE_WHEN,
  APP_PACKAGE_V1_MAX_WORKFLOW_STEPS,
  APP_PACKAGE_V1_MAX_WORKFLOWS,
} from './limits.js';
import type { AppPackageArtifactV1 } from './types.js';

const name = z
  .string()
  .max(APP_PACKAGE_V1_MAX_IDENTIFIER_CHARS)
  .regex(/^[a-z0-9_]+$/);
const coreName = z.string().regex(/^[a-z0-9_]+$/);
const boundedName = z
  .string()
  .min(1)
  .max(APP_PACKAGE_V1_MAX_IDENTIFIER_CHARS)
  .refine((value) => value.trim().length > 0, 'must contain non-whitespace text');
const prose = z
  .string()
  .min(1)
  .max(APP_PACKAGE_V1_MAX_PROSE_CHARS)
  .refine((value) => value.trim().length > 0, 'must contain non-whitespace text');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const capability = z.object({ kind: z.enum(['tool', 'resource', 'prompt']), name }).strict();
const behavior = z
  .object({
    readOnly: z.boolean(),
    destructive: z.boolean(),
    idempotent: z.boolean(),
    openWorld: z.boolean(),
    confirmationRequired: z.boolean(),
  })
  .strict();
const schemaField = z
  .object({ name: boundedName, type: prose, required: z.boolean(), description: prose.optional() })
  .strict();
const schemaSummary = z
  .object({
    type: prose,
    fields: z.array(schemaField).max(APP_PACKAGE_V1_MAX_SCHEMA_FIELDS).optional(),
  })
  .strict();
const asset = z
  .object({ logicalId: boundedName, alt: prose, darkLogicalId: boundedName.optional() })
  .strict();
const branding = z
  .object({
    name: prose.optional(),
    accent: prose.optional(),
    surface: prose.optional(),
    surfaceDark: prose.optional(),
    logo: asset.optional(),
    mark: asset.optional(),
    avatar: asset.optional(),
    radius: z.enum(['none', 'sm', 'md', 'lg']).optional(),
    density: z.enum(['compact', 'comfortable']).optional(),
    typography: z.enum(['system', 'serif', 'mono']).optional(),
    colorScheme: z.enum(['auto', 'light', 'dark']).optional(),
  })
  .strict();
const authorization = z
  .object({
    discovery: z.literal('public').optional(),
    requiredScopes: z
      .array(
        z
          .string()
          .min(1)
          .max(512)
          .refine((value) => value.trim().length > 0, 'must contain non-whitespace text'),
      )
      .min(1)
      .max(APP_PACKAGE_V1_MAX_AUTHORIZATION_VALUES)
      .optional(),
    allowedRoles: z
      .array(
        z
          .string()
          .min(1)
          .max(APP_PACKAGE_V1_MAX_IDENTIFIER_CHARS)
          .refine((value) => value.trim().length > 0, 'must contain non-whitespace text'),
      )
      .min(1)
      .max(APP_PACKAGE_V1_MAX_AUTHORIZATION_VALUES)
      .optional(),
  })
  .strict()
  .refine((value) => value.requiredScopes !== undefined || value.allowedRoles !== undefined);
const visibility = z.union([
  z.tuple([z.literal('model')]),
  z.tuple([z.literal('app')]),
  z.tuple([z.literal('model'), z.literal('app')]),
]);
const tool = z
  .object({
    kind: z.literal('tool'),
    name,
    title: prose.optional(),
    description: prose,
    input: schemaSummary,
    output: schemaSummary.optional(),
    behavior,
    visibility,
    authorization: authorization.optional(),
    widget: name.optional(),
  })
  .strict();
const resource = z
  .object({
    kind: z.literal('resource'),
    name,
    uri: prose,
    title: prose.optional(),
    description: prose.optional(),
    mimeType: prose.optional(),
  })
  .strict();
const prompt = z
  .object({
    kind: z.literal('prompt'),
    name,
    title: prose.optional(),
    description: prose.optional(),
    arguments: z
      .array(
        z
          .object({ name: boundedName, description: prose.optional(), required: z.boolean() })
          .strict(),
      )
      .max(APP_PACKAGE_V1_MAX_PROMPT_ARGUMENTS),
  })
  .strict();
const widget = z
  .object({
    kind: z.literal('widget'),
    name,
    title: prose.optional(),
    description: prose.optional(),
    tool: name,
  })
  .strict();
const skill = z
  .object({
    description: prose,
    useWhen: z.array(prose).min(1).max(APP_PACKAGE_V1_MAX_USE_WHEN),
    workflows: z
      .array(
        z
          .object({
            id: name,
            title: prose,
            intent: prose.optional(),
            steps: z
              .array(
                z
                  .object({ capability, guidance: prose.optional(), behavior: behavior.optional() })
                  .strict(),
              )
              .min(1)
              .max(APP_PACKAGE_V1_MAX_WORKFLOW_STEPS),
          })
          .strict(),
      )
      .min(1)
      .max(APP_PACKAGE_V1_MAX_WORKFLOWS),
    boundaries: z.array(prose).max(APP_PACKAGE_V1_MAX_BOUNDARIES),
    examples: z
      .array(z.object({ prompt: prose, workflow: name }).strict())
      .max(APP_PACKAGE_V1_MAX_EXAMPLES),
  })
  .strict();

/** Serializable, strict, safe App Package V1 projection. */
export const appPackageArtifactV1Schema: z.ZodType<AppPackageArtifactV1> = z
  .object({
    schemaVersion: z.literal('1'),
    app: z
      .object({ name: coreName, title: prose, version: prose, branding: branding.optional() })
      .strict(),
    skill,
    surface: z
      .object({
        auth: z
          .object({ required: z.boolean(), kind: z.enum(['oidc', 'federatedOidc']).optional() })
          .strict(),
        tools: z.array(tool).max(APP_PACKAGE_V1_MAX_SURFACE_ITEMS),
        resources: z.array(resource).max(APP_PACKAGE_V1_MAX_SURFACE_ITEMS),
        prompts: z.array(prompt).max(APP_PACKAGE_V1_MAX_SURFACE_ITEMS),
        widgets: z.array(widget).max(APP_PACKAGE_V1_MAX_SURFACE_ITEMS),
      })
      .strict(),
    provenance: z
      .object({
        sourceManifestSha256: digest,
        mcpSurfaceSha256: digest,
        compilerVersion: z.literal('1'),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Buffer.byteLength(canonicalJson(value), 'utf8') > APP_PACKAGE_V1_MAX_CANONICAL_BYTES) {
      ctx.addIssue({ code: 'custom', message: 'App Package artifact exceeds 256 KiB' });
    }
  });
