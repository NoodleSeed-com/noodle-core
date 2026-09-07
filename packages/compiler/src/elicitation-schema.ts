import { z } from 'zod';
import type { JsonSchema } from './artifact/types.js';
import type { CompileError } from './errors.js';

const titledChoice = z.object({ const: z.string(), title: z.string().min(1) }).strict();
const baseText = {
  title: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
} as const;
const primitiveSchema = z.union([
  z
    .object({
      type: z.literal('string'),
      ...baseText,
      oneOf: z.array(titledChoice).min(1),
      default: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('string'),
      ...baseText,
      enum: z.array(z.string()).min(1),
      default: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('array'),
      ...baseText,
      minItems: z.number().int().min(0).optional(),
      maxItems: z.number().int().min(0).optional(),
      items: z.union([
        z.object({ type: z.literal('string'), enum: z.array(z.string()).min(1) }).strict(),
        z.object({ anyOf: z.array(titledChoice).min(1) }).strict(),
      ]),
      default: z.array(z.string()).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('string'),
      ...baseText,
      minLength: z.number().int().min(0).optional(),
      maxLength: z.number().int().min(0).optional(),
      format: z.enum(['email', 'uri', 'date', 'date-time']).optional(),
      default: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.enum(['number', 'integer']),
      ...baseText,
      minimum: z.number().optional(),
      maximum: z.number().optional(),
      default: z.number().optional(),
    })
    .strict(),
  z.object({ type: z.literal('boolean'), ...baseText, default: z.boolean().optional() }).strict(),
]);

const portableFormSchema = z
  .object({
    $schema: z.string().optional(),
    type: z.literal('object'),
    properties: z.record(z.string(), primitiveSchema),
    required: z.array(z.string()).optional(),
    // Zod's input projection emits this; MCP form elicitation is closed by construction, so it is
    // accepted only when false and omitted from the portable wire-facing artifact shape.
    additionalProperties: z.literal(false).optional(),
  })
  .strict();

const SENSITIVE_FIELD =
  /(?:password|passcode|secret|access[_-]?token|refresh[_-]?token|api[_-]?key|private[_-]?key|credential|card[_-]?number|cvv|cvc)/i;

/** Validate and normalize the portable, non-sensitive MCP form-elicitation schema subset. */
export function normalizeElicitationSchema(
  value: unknown,
  path: string,
  errors: CompileError[],
): JsonSchema | undefined {
  const parsed = portableFormSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    errors.push({
      code: 'invalid_elicitation_schema',
      path: [path, ...(issue?.path ?? [])].join('.'),
      message:
        'elicitation input must be a flat object of MCP form fields (string, number, boolean, ' +
        'string enum, or string multi-select)',
    });
    return undefined;
  }

  const propertyNames = Object.keys(parsed.data.properties);
  const sensitive = propertyNames.find((name) => SENSITIVE_FIELD.test(name));
  if (sensitive !== undefined) {
    errors.push({
      code: 'invalid_elicitation_schema',
      path: `${path}.properties.${sensitive}`,
      message: `form elicitation cannot request credential-shaped field "${sensitive}"`,
    });
    return undefined;
  }
  const unknownRequired = (parsed.data.required ?? []).find(
    (name) => !Object.hasOwn(parsed.data.properties, name),
  );
  if (unknownRequired !== undefined) {
    errors.push({
      code: 'invalid_elicitation_schema',
      path: `${path}.required`,
      message: `required elicitation field "${unknownRequired}" is not declared in properties`,
    });
    return undefined;
  }

  return {
    type: 'object',
    properties: parsed.data.properties,
    ...(parsed.data.required?.length ? { required: parsed.data.required } : {}),
  };
}
