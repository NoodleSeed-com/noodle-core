import { printRecovery } from '../diagnostics.js';
import { EXIT, printJsonFailure } from './output.js';

export type ProductionCapacityErrorCode =
  | 'production_app_limit_exceeded'
  | 'billing_enforcement_unavailable';

export function isProductionCapacityErrorCode(
  value: string | undefined,
): value is ProductionCapacityErrorCode {
  return value === 'production_app_limit_exceeded' || value === 'billing_enforcement_unavailable';
}

/** Stable, privacy-bounded recovery text shared by deploy, rollback, and restore commands. */
export function productionCapacityRecovery(
  code: ProductionCapacityErrorCode,
  org: string,
): {
  readonly code: ProductionCapacityErrorCode;
  readonly cause: string;
  readonly fix: string;
  readonly next: string;
} {
  return code === 'production_app_limit_exceeded'
    ? {
        code,
        cause: 'production app limit reached; archive an active app or contact support',
        fix: 'Archive an active production app on this billing account, or contact Noodle Seed support.',
        next: `noodle billing org inspect ${org}`,
      }
    : {
        code,
        cause: 'billing enforcement is temporarily unavailable; retry later',
        fix: 'Wait briefly and retry; do not bypass billing enforcement.',
        next: 'noodle deploy',
      };
}

/** Render a deploy capacity failure when present; return undefined for every other deploy error. */
export function handleProductionCapacityFailure(
  outcome: { readonly code?: string; readonly message: string; readonly status: number },
  org: string,
  json: boolean,
): number | undefined {
  if (!isProductionCapacityErrorCode(outcome.code)) return undefined;
  const recovery = productionCapacityRecovery(outcome.code, org);
  if (json) {
    return printJsonFailure(
      {
        code: recovery.code,
        message: outcome.message,
        cause: recovery.cause,
        fix: recovery.fix,
        next: recovery.next,
        detail: { status: outcome.status },
      },
      EXIT.FAILURE,
    );
  }
  printRecovery({ command: 'deploy', ...recovery, message: outcome.message });
  return EXIT.FAILURE;
}
