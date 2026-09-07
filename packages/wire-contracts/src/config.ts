import { z } from 'zod';

export const ConfigSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('organization'), organizationId: z.string() }).strict(),
  z.object({ kind: z.literal('app'), organizationId: z.string(), appId: z.string() }).strict(),
  z
    .object({
      kind: z.literal('environment'),
      organizationId: z.string(),
      appId: z.string(),
      environmentId: z.string(),
      environmentName: z.string(),
      isProduction: z.boolean(),
    })
    .strict(),
]);
export type ConfigSource = z.output<typeof ConfigSourceSchema>;

const EffectiveConfigRowBaseSchema = z
  .object({
    name: z.string(),
    source: ConfigSourceSchema,
    fallbackSource: ConfigSourceSchema.optional(),
  })
  .strict();

export const EffectiveSecretConfigRowSchema = EffectiveConfigRowBaseSchema;

export const EffectiveVariableConfigRowSchema = EffectiveConfigRowBaseSchema.extend({
  value: z.string(),
}).strict();

const EffectiveConfigResponseBaseSchema = z
  .object({
    environment: z.object({ id: z.string(), name: z.string(), isProduction: z.boolean() }).strict(),
    capabilities: z.object({ canManage: z.boolean(), canReveal: z.boolean() }).strict(),
  })
  .strict();

export const EffectiveConfigResponseSchema = z.discriminatedUnion('kind', [
  EffectiveConfigResponseBaseSchema.extend({
    kind: z.literal('secret'),
    entries: z.array(EffectiveSecretConfigRowSchema),
  }).strict(),
  EffectiveConfigResponseBaseSchema.extend({
    kind: z.literal('variable'),
    entries: z.array(EffectiveVariableConfigRowSchema),
  }).strict(),
]);
export type EffectiveConfigResponse = z.output<typeof EffectiveConfigResponseSchema>;

export type RevealSecretResponse = {
  readonly ok: true;
  readonly value: string;
  readonly source: ConfigSource;
};

export const RevealSecretResponseSchema: z.ZodType<RevealSecretResponse> = z
  .object({
    ok: z.literal(true),
    value: z.string(),
    source: ConfigSourceSchema,
  })
  .strict();
