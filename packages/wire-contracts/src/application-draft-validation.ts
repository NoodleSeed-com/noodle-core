import { z } from 'zod';
import { ApplicationDraftIdSchema } from './application-drafts.js';

/** A source check is transient evidence, never a stored publication/activation receipt. */
function response(additive: boolean) {
  const object = additive ? z.object : z.strictObject;
  const common = {
    draftId: ApplicationDraftIdSchema,
    revision: z.number().int().min(1).max(2147483647),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    check: z.literal('source-and-manifest'),
    published: z.literal(false),
  };
  const validation = z.discriminatedUnion('status', [
    object({
      ...common,
      status: z.literal('valid'),
      compilerDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      artifactDigest: z.string().regex(/^[a-f0-9]{64}$/),
      issues: z.array(z.never()).max(0),
    }),
    object({
      ...common,
      status: z.literal('invalid'),
      issues: z
        .array(
          object({
            code: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/),
            message: z.string().max(500),
            path: z.string().max(240).optional(),
          }),
        )
        .min(1)
        .max(20),
    }),
  ]);
  return object({ ok: z.literal(true), data: object({ validation }) });
}
export const ApplicationDraftValidationResponseSchema = response(false);
export const ApplicationDraftValidationClientResponseSchema = response(true);
export type ApplicationDraftValidation = z.infer<
  typeof ApplicationDraftValidationResponseSchema
>['data']['validation'];
