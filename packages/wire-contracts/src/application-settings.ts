import { z } from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const key = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_]+$/)
  .refine((value) => !['__proto__', 'prototype', 'constructor'].includes(value));
const values = z.record(key, z.json());
const declaration = z
  .object({
    name: key,
    schemaVersion: z.literal(1),
    valueSchema: z.record(z.string(), z.json()),
    default: z.json().optional(),
    portal: z
      .object({
        label: z.string().min(1).max(120),
        help: z.string().max(1000).optional(),
        group: z.string().max(120).optional(),
      })
      .strict(),
    requiredFor: z.array(z.string().min(1).max(128)).max(128),
    schemaDigest: z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/),
  })
  .strict();

export const ApplicationSettingsProjectionSchema = z
  .object({
    revision: digest,
    schemaDigest: digest,
    releaseDigest: z.string().min(1).max(128),
    declarations: z.array(declaration).max(128),
    values,
    provenance: z.record(key, z.enum(['operator', 'default', 'organization', 'app', 'unset'])),
    readiness: z
      .array(
        z
          .object({
            tool: z.string().min(1).max(128),
            ready: z.boolean(),
            missing: z.array(key).max(128),
          })
          .strict(),
      )
      .max(256),
    canEdit: z.boolean(),
  })
  .strict();

export type ApplicationSettingsProjection = z.infer<typeof ApplicationSettingsProjectionSchema>;
export const ApplicationSettingsResponseSchema = z
  .object({
    ok: z.literal(true),
    data: ApplicationSettingsProjectionSchema,
  })
  .strict();

// Browser/CLI response readers tolerate additive server fields at every object boundary.
export const ApplicationSettingsClientResponseSchema = z
  .object({
    ok: z.literal(true),
    data: ApplicationSettingsProjectionSchema.extend({
      declarations: z.array(
        declaration.extend({ portal: declaration.shape.portal.strip() }).strip(),
      ),
      readiness: z.array(ApplicationSettingsProjectionSchema.shape.readiness.element.strip()),
    }).strip(),
  })
  .strip();

export const ApplicationSettingsSaveRequestSchema = z
  .object({
    expectedRevision: digest,
    schemaDigest: digest,
    values,
    resetKeys: z.array(key).max(128).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (Object.keys(input.values).length > 128) {
      context.addIssue({ code: 'custom', message: 'too many setting values', path: ['values'] });
    }
    if (new Set(input.resetKeys).size !== (input.resetKeys?.length ?? 0)) {
      context.addIssue({ code: 'custom', message: 'duplicate reset key', path: ['resetKeys'] });
    }
    for (const name of input.resetKeys ?? []) {
      if (Object.hasOwn(input.values, name)) {
        context.addIssue({
          code: 'custom',
          message: 'cannot set and reset the same key',
          path: ['values', name],
        });
      }
    }
  });

export type ApplicationSettingsSaveRequest = z.infer<typeof ApplicationSettingsSaveRequestSchema>;
