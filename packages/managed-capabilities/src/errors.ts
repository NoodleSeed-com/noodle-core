export const CAPABILITY_ERROR_CODES = [
  'capability_unavailable',
  'capability_binding_invalid',
  'capability_requirement_unsupported',
  'capability_policy_denied',
  'capability_budget_exhausted',
  'capability_source_rejected',
  'capability_provider_failed',
  'capability_result_invalid',
  'capability_cancelled',
] as const;
export type CapabilityErrorCode = (typeof CAPABILITY_ERROR_CODES)[number];

/** Messages are fixed safe codes: never retain a URL, provider payload or a nested cause. */
export class CapabilityError extends Error {
  constructor(readonly code: CapabilityErrorCode) {
    super(code);
    this.name = 'CapabilityError';
  }
}
