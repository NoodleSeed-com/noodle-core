import { z } from 'zod';

const ResourceSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const OperationCoordinationListRequestSchema = z.strictObject({
  limit: z.number().int().min(1).max(100).optional(),
  beforeResource: ResourceSchema.optional(),
});
export const OperationCoordinationResolveRequestSchema = z.strictObject({
  resource: ResourceSchema,
  token: z.uuid(),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .regex(/^[^\p{Cc}\p{Zl}\p{Zp}]*$/u),
});
const RecordSchema = z.strictObject({
  resource: ResourceSchema,
  token: z.uuid(),
  reference: z
    .string()
    .regex(/^[A-Za-z0-9._:@/-]{1,256}$/)
    .refine((value) => !value.includes('://')),
  operationDigest: ResourceSchema,
  startedAt: z.iso.datetime(),
  deadline: z.iso.datetime(),
  state: z.enum(['executing', 'unknown']),
});
export const OperationCoordinationListResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({
    records: z.array(RecordSchema).max(100),
    nextBeforeResource: ResourceSchema.optional(),
  }),
});
export const OperationCoordinationListClientResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    records: z.array(z.object(RecordSchema.shape)).max(100),
    nextBeforeResource: ResourceSchema.optional(),
  }),
});
export const OperationCoordinationResolveResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({ resolved: z.literal(true) }),
});
export const OperationCoordinationResolveClientResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({ resolved: z.literal(true) }),
});
