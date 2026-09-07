import { z } from 'zod';

export const SolutionInstallationOptionsQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(100),
  cursor: z
    .string()
    .min(1)
    .max(192)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
});

function responseSchema(additive: boolean) {
  const object = additive ? z.object : z.strictObject;
  return object({
    ok: z.literal(true),
    data: object({
      organizations: z
        .array(
          object({
            slug: z.string().min(1).max(100),
            displayName: z.string().min(1).max(200).optional(),
          }),
        )
        .max(100),
      nextCursor: z.string().min(1).max(192).optional(),
    }),
  });
}

export const SolutionInstallationOptionsResponseSchema = responseSchema(false);
export const SolutionInstallationOptionsClientResponseSchema = responseSchema(true);
export type SolutionInstallationOptionsResponse = z.infer<
  typeof SolutionInstallationOptionsResponseSchema
>;
