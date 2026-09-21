import { z } from 'zod';
import { NAME_PATTERN } from './naming.js';

/**
 * The `collect` interaction block (ADR 0240): bounded metadata on an opener tool describing which
 * fields a platform renderer collects for one confirmed action, which are private, what is reviewed,
 * and what to say on success. It carries meaning only: no layout, ordering script or screen language.
 * Field, action and output references are checked against the declared tools by the compile pass
 * (`interaction-validation.ts`), which also bounds `confirmationExpiry` so a bad value reports its own
 * code instead of a shape error.
 */
export const COLLECT_CONTROLS = [
  'text',
  'textarea',
  'email',
  'phone',
  'url',
  'select',
  'consent',
] as const;
export type CollectControl = (typeof COLLECT_CONTROLS)[number];

const MAX_COLLECT_FIELDS = 32;
const MAX_PROPERTY_KEY_CHARS = 128;
const MAX_OUTCOME_CHARS = 280;

const propertyKeySchema = z.string().min(1).max(MAX_PROPERTY_KEY_CHARS);

const collectFieldSchema = z
  .object({
    key: propertyKeySchema,
    control: z.enum(COLLECT_CONTROLS),
    /** Never enters the conversation model, transcript, logs or diagnostics. Opt-in per field. */
    private: z.literal(true).optional(),
    /** The person may leave it blank; the renderer submits the schema's empty value. */
    optional: z.literal(true).optional(),
  })
  .strict();

export const toolInteractionSchema = z
  .object({
    kind: z.literal('collect'),
    /** The confirmed action tool this collection prepares, by name. */
    action: z.string().regex(NAME_PATTERN),
    /** Action input property -> the opener output property that seeds it. */
    initialValues: z
      .record(propertyKeySchema, z.object({ fromOutput: propertyKeySchema }).strict())
      .optional(),
    fields: z
      .array(collectFieldSchema)
      .min(1)
      .max(MAX_COLLECT_FIELDS)
      .superRefine((fields, ctx) => {
        const seen = new Set<string>();
        for (const field of fields) {
          if (seen.has(field.key)) {
            ctx.addIssue({ code: 'custom', message: `duplicate field key "${field.key}"` });
          }
          seen.add(field.key);
        }
      }),
    review: z.literal('all'),
    outcome: z.object({ success: z.string().trim().min(1).max(MAX_OUTCOME_CHARS) }).strict(),
    /** A developer may only shorten the profile default; the compile pass checks the bound. */
    confirmationExpiry: z.object({ seconds: z.number() }).strict().optional(),
  })
  .strict();

export type ToolInteractionManifest = z.infer<typeof toolInteractionSchema>;
