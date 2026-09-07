import { z } from 'zod';
import type { PackagedAssetReference } from '../assets.js';

/**
 * Shared manifest primitives: colors, https URLs, managed variable expressions, assistant origins,
 * packaged asset references, and the server brand kit.
 *
 * Extracted verbatim from `schema.ts` so that file stays inside its size budget as the assistant
 * surface grows. These are leaf validators with no dependency on tools, prompts, widgets, or the
 * assistant block, which is what makes the split one-directional and free of an import cycle.
 */

const hexColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'must be a 6-digit hex color');
export const httpsUrlSchema = z.url().regex(/^https:\/\//, 'must use https');
const managedVariableExpressionPattern = /^\$\{env\.[A-Za-z0-9_]+\}$/;
export const managedVariableExpressionSchema = z
  .string()
  .regex(managedVariableExpressionPattern, 'must be an exact managed variable expression');
// HTTP is allowed only for loopback development origins (mirrors the host-pattern loopback
// exception used for connector/CSP origins); production embedding origins stay https-only.
const assistantOriginOrVariablePattern =
  /^(?:\$\{env\.[A-Za-z0-9_]+\}|https:\/\/[^/?#@\\]+|http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?)$/;

function isCanonicalAssistantOrigin(value: string): boolean {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}

export const assistantOriginOrVariableSchema = z
  .string()
  .regex(
    assistantOriginOrVariablePattern,
    'must be a canonical bare origin using https (http is allowed only for localhost/127.0.0.1/[::1] loopback development origins)',
  )
  .refine(
    (value) => managedVariableExpressionPattern.test(value) || isCanonicalAssistantOrigin(value),
    'must be a canonical bare origin',
  );
const packagedAssetSchema: z.ZodType<PackagedAssetReference> = z
  .object({
    kind: z.literal('asset'),
    sourcePath: z.string().min(1),
    logicalId: z.string().min(1),
  })
  .strict();

const brandAssetSchema = z
  .object({
    uri: z.union([httpsUrlSchema, packagedAssetSchema]),
    darkUri: z.union([httpsUrlSchema, packagedAssetSchema]).optional(),
    alt: z.string().trim().min(1),
  })
  .strict();

const brandThemeTokensSchema = z
  .object({
    surface: hexColorSchema.optional(),
    surfaceRaised: hexColorSchema.optional(),
    surfaceMuted: hexColorSchema.optional(),
    text: hexColorSchema.optional(),
    textMuted: hexColorSchema.optional(),
    accent: hexColorSchema.optional(),
    accentText: hexColorSchema.optional(),
    link: hexColorSchema.optional(),
    border: hexColorSchema.optional(),
    borderStrong: hexColorSchema.optional(),
    focus: hexColorSchema.optional(),
    success: hexColorSchema.optional(),
    warning: hexColorSchema.optional(),
    danger: hexColorSchema.optional(),
    code: hexColorSchema.optional(),
  })
  .strict();

export const serverBrandingSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    accent: hexColorSchema.optional(),
    surface: hexColorSchema.optional(),
    surfaceDark: hexColorSchema.optional(),
    logo: brandAssetSchema.optional(),
    mark: brandAssetSchema.optional(),
    avatar: brandAssetSchema.optional(),
    theme: z
      .object({
        light: brandThemeTokensSchema.optional(),
        dark: brandThemeTokensSchema.optional(),
      })
      .strict()
      .optional(),
    radius: z.enum(['none', 'sm', 'md', 'lg']).optional(),
    density: z.enum(['compact', 'comfortable']).optional(),
    typography: z.enum(['system', 'serif', 'mono']).optional(),
    colorScheme: z.enum(['auto', 'light', 'dark']).optional(),
  })
  .strict();
