import { z } from 'zod';

const hasControlCharacters = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
const scalar = (label: string, max: number) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .max(max, `${label} must be ${max} characters or fewer`)
    .refine((value) => !hasControlCharacters(value), `${label} cannot contain control characters`);

export const BILLING_METER_READINESS_SCHEMA_VERSION = 1 as const;
export const BILLING_METER_READINESS_CHECK_CODES = [
  'durable_postgres',
  'billing_attribution_complete',
  'legacy_platform_quota_retired',
  'key_generation_consistent',
  'prepared_meter_epoch',
  'partition_horizon',
  'receipt_retention',
  'exact_key_tombstones',
  'aggregate_reconciliation',
  'validation_mirror',
  'writer_health',
  'scheduler_health',
] as const;
export const BILLING_METER_LATER_CUTOVER_GATES = [
  'traffic_fleet_convergence_proof',
  'plan_volume_capacity_proof',
  'nonproduction_fail_closed_drill',
  'grant_expiry_contract',
  'authoritative_activation',
  'protected_production_approval',
] as const;
const instant = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());
const readinessReport = (loose = false) => {
  const object = loose ? z.object : z.strictObject;
  const check = object({
    code: z.enum(BILLING_METER_READINESS_CHECK_CODES),
    state: z.enum(['pass', 'fail', 'unknown']),
    checkedAt: instant.optional(),
  });
  const checks = z
    .array(check)
    .length(BILLING_METER_READINESS_CHECK_CODES.length)
    .superRefine((values, context) => {
      for (const [index, code] of BILLING_METER_READINESS_CHECK_CODES.entries()) {
        if (values[index]?.code !== code) {
          context.addIssue({
            code: 'custom',
            message: `expected readiness check ${code} at index ${index}`,
            path: [index, 'code'],
          });
        }
      }
    });
  return object({
    schemaVersion: z.literal(BILLING_METER_READINESS_SCHEMA_VERSION),
    checkedAt: instant,
    technicalReadiness: z.enum(['ready', 'blocked', 'unavailable']),
    metering: z.union([
      object({ mode: z.literal('not_started'), coverage: z.null() }),
      object({ mode: z.literal('shadow'), coverage: z.literal('partial') }),
    ]),
    enforcement: object({ state: z.literal('legacy_unchanged') }),
    activation: object({ state: z.literal('not_available') }),
    checks,
    laterCutoverGates: z.tuple([
      z.literal('traffic_fleet_convergence_proof'),
      z.literal('plan_volume_capacity_proof'),
      z.literal('nonproduction_fail_closed_drill'),
      z.literal('grant_expiry_contract'),
      z.literal('authoritative_activation'),
      z.literal('protected_production_approval'),
    ]),
  }).superRefine((report, context) => {
    const allPass = report.checks.every((item) => item.state === 'pass');
    if ((report.technicalReadiness === 'ready') !== allPass) {
      context.addIssue({
        code: 'custom',
        message: 'technical readiness must be ready exactly when every readiness check passes',
        path: ['technicalReadiness'],
      });
    }
  });
};
export const BillingMeterReadinessReportSchema = readinessReport();
export const BillingMeterReadinessClientReportSchema = readinessReport(true);
export const BillingMeterReadinessResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: BillingMeterReadinessReportSchema,
});
export const BillingMeterReadinessClientResponseSchema = z.object({
  ok: z.literal(true),
  data: BillingMeterReadinessClientReportSchema,
});
export type BillingMeterReadinessCheckCode = (typeof BILLING_METER_READINESS_CHECK_CODES)[number];
export type BillingMeterLaterCutoverGate = (typeof BILLING_METER_LATER_CUTOVER_GATES)[number];
export type BillingMeterReadinessReport = z.infer<typeof BillingMeterReadinessReportSchema>;
export type BillingMeterReadinessCheck = BillingMeterReadinessReport['checks'][number];
export type BillingMeterReadinessCheckState = BillingMeterReadinessCheck['state'];

export const BILLING_METER_VALIDATION_WRITER_CONTRACT_VERSION = 1;
export const BillingMeterValidationEpochPrepareRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  mode: z.literal('validation'),
  reason: scalar('reason', 512),
  idempotencyKey: scalar('idempotencyKey', 256),
  confirmed: z.literal(true),
});
export const BillingMeterValidationEpochRetireRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  epochId: scalar('epochId', 128),
  reason: scalar('reason', 512),
  idempotencyKey: scalar('idempotencyKey', 256),
  confirmed: z.literal(true),
});
const epochResultShape = {
  schemaVersion: z.literal(1),
  epochId: scalar('epochId', 128),
  mode: z.literal('validation'),
  state: z.enum(['prepared', 'retired']),
  replayed: z.boolean(),
  preparedAt: z.iso.datetime({ offset: true }),
  retiredAt: z.union([z.iso.datetime({ offset: true }), z.null()]),
  retryIdentityVersion: z.number().int().positive(),
  writerContractVersion: z.number().int().positive(),
  serviceReleaseSha: z
    .string()
    .regex(/^[0-9a-f]{40}$/, 'serviceReleaseSha must be a full lowercase Git SHA'),
  meteringMode: z.literal('shadow'),
  enforcementMode: z.literal('legacy_unchanged'),
} as const;
const epochResult = (loose = false) =>
  (loose ? z.object : z.strictObject)(epochResultShape).superRefine((result, context) => {
    if (result.state === 'prepared' && result.retiredAt !== null) {
      context.addIssue({
        code: 'custom',
        path: ['retiredAt'],
        message: 'a prepared validation epoch cannot have a retirement timestamp',
      });
    }
    if (result.state === 'retired' && result.retiredAt === null) {
      context.addIssue({
        code: 'custom',
        path: ['retiredAt'],
        message: 'a retired validation epoch requires a retirement timestamp',
      });
    }
  });
export const BillingMeterValidationEpochResultSchema = epochResult();
export const BillingMeterValidationEpochClientResultSchema = epochResult(true);
export const BillingMeterValidationEpochResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: BillingMeterValidationEpochResultSchema,
});
export const BillingMeterValidationEpochClientResponseSchema = z.object({
  ok: z.literal(true),
  data: BillingMeterValidationEpochClientResultSchema,
});
export type BillingMeterValidationEpochPrepareRequest = z.infer<
  typeof BillingMeterValidationEpochPrepareRequestSchema
>;
export type BillingMeterValidationEpochRetireRequest = z.infer<
  typeof BillingMeterValidationEpochRetireRequestSchema
>;
export type BillingMeterValidationEpochResult = z.infer<
  typeof BillingMeterValidationEpochResultSchema
>;
export function parseBillingMeterValidationEpochPrepareRequest(
  value: unknown,
): BillingMeterValidationEpochPrepareRequest {
  const result = BillingMeterValidationEpochPrepareRequestSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `invalid billing meter validation epoch prepare: ${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}
export function parseBillingMeterValidationEpochRetireRequest(
  value: unknown,
): BillingMeterValidationEpochRetireRequest {
  const result = BillingMeterValidationEpochRetireRequestSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `invalid billing meter validation epoch retire: ${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}
