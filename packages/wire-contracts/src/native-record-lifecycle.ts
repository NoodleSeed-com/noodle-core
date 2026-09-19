import { z } from 'zod';

const policy = z.enum(['legacy_expiry', 'explicit_erasure']);
const preview = {
  policy,
  installationRevision: z.number().int().positive(),
  observedAt: z.iso.datetime(),
  recordsToPreserve: z.number().int().nonnegative(),
  expiredRecords: z.number().int().nonnegative(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
};
const result = {
  policy: z.literal('explicit_erasure'),
  installationRevision: z.number().int().positive(),
  recordsPreserved: z.number().int().nonnegative(),
  replayed: z.boolean(),
};
export const NativeRecordLifecyclePreviewSchema = z.strictObject(preview);
export type NativeRecordLifecyclePreview = z.infer<typeof NativeRecordLifecyclePreviewSchema>;
export const NativeRecordLifecycleMigrateRequestSchema = z.strictObject({
  preview: NativeRecordLifecyclePreviewSchema,
  confirm: z.literal(true),
});
export const NativeRecordLifecyclePreviewResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: NativeRecordLifecyclePreviewSchema,
});
export const NativeRecordLifecyclePreviewClientResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object(preview),
});
export const NativeRecordLifecycleResultSchema = z.strictObject(result);
export type NativeRecordLifecycleResult = z.infer<typeof NativeRecordLifecycleResultSchema>;
export const NativeRecordLifecycleResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: NativeRecordLifecycleResultSchema,
});
export const NativeRecordLifecycleClientResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object(result),
});
