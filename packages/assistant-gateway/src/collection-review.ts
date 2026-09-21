import type {
  CollectionConsent,
  CollectionFieldStatus,
  CollectionLedger,
  CollectionPhase,
  CollectionSpec,
} from './collection-ledger.js';
import { pendingProposal } from './collection-ledger.js';

/** What the conversation model may see: statuses, reason codes and non-private values only. */
export interface CollectionModelView {
  readonly phase: CollectionPhase;
  readonly consent?: 'given' | 'declined';
  readonly fields: readonly {
    readonly key: string;
    readonly title: string;
    readonly status: CollectionFieldStatus;
    readonly reason?: string;
  }[];
  readonly values: Readonly<Record<string, unknown>>;
  readonly pendingProposal: boolean;
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return 'none';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * The exact review the confirmation binds to: one `Title: value` line per non-consent field in spec
 * order, then the contact permission line. The caller renders this string; a model never restates it.
 */
export function renderReview(
  spec: CollectionSpec,
  values: Readonly<Record<string, unknown>>,
  consent: CollectionConsent | undefined,
): string {
  const lines = spec.fields
    .filter((field) => field.control !== 'consent')
    .map((field) => `${field.title}: ${formatValue(values[field.key])}`);
  if (spec.fields.some((field) => field.control === 'consent'))
    lines.push(`Contact permission: ${consent?.given === true ? 'yes' : 'no'}`);
  return lines.join('\n');
}

export function ledgerForModel(
  spec: CollectionSpec,
  ledger: CollectionLedger,
  now: number,
): CollectionModelView {
  const values: Record<string, unknown> = {};
  const fields = spec.fields
    .filter((field) => field.control !== 'consent')
    .map((field) => {
      const state = ledger.fields[field.key] ?? { status: 'missing' as const, attempts: 0 };
      if (state.status === 'captured' && field.private !== true && field.key in ledger.values)
        values[field.key] = ledger.values[field.key];
      return {
        key: field.key,
        title: field.title,
        status: state.status,
        ...(state.reason === undefined ? {} : { reason: state.reason }),
      };
    });
  return {
    phase: ledger.phase,
    ...(ledger.consent === undefined
      ? {}
      : { consent: ledger.consent.given ? ('given' as const) : ('declined' as const) }),
    fields,
    values,
    pendingProposal: pendingProposal(ledger, now) !== undefined,
  };
}
