import type { JsonSchema } from '@noodle-borg/compiler';
import { CHANNEL_RETENTION_MS } from './channel-types.js';

/**
 * Runtime-owned natural collection ledger (ADR 0240 decision 5). The ledger is the pre-proposal
 * stage of the shared confirmation lifecycle: once fields are complete the proposal it stores is an
 * opaque prepared-tool continuation, never a second confirmation engine.
 */
export type CollectionControl =
  | 'text'
  | 'textarea'
  | 'email'
  | 'phone'
  | 'url'
  | 'select'
  | 'consent';
export interface CollectionField {
  readonly key: string;
  readonly title: string;
  readonly control: CollectionControl;
  /** Never enters the conversation model, transcript, logs or diagnostics. */
  readonly private?: true;
  readonly optional?: true;
  readonly options?: readonly string[];
  /** The action input property this field fills; every candidate is validated against it. */
  readonly schema: JsonSchema;
}
export interface CollectionSpec {
  /** Opener tool name. */
  readonly interactionId: string;
  readonly action: string;
  readonly fields: readonly CollectionField[];
  readonly consentQuestion: string;
  readonly successMessage: string;
  readonly confirmationExpiryMs: number;
}
export type CollectionPhase =
  | 'collecting'
  | 'awaiting_consent'
  | 'awaiting_confirmation'
  | 'executing'
  | 'completed'
  | 'cancelled'
  | 'expired';
export type CollectionFieldStatus =
  | 'missing'
  | 'captured'
  | 'invalid'
  | 'ambiguous'
  | 'rejected_by_user';
export interface CollectionFieldState {
  readonly status: CollectionFieldStatus;
  /** Short structured code, never a value. */
  readonly reason?: string;
  readonly attempts: number;
}
export interface CollectionConsent {
  readonly given: boolean;
  readonly questionVersion: string;
  readonly at: string;
}
export interface CollectionProposal {
  readonly id: string;
  /** Exact runtime-rendered review the confirmation binds to. */
  readonly review: string;
  /** Opaque prepared-tool continuation released to the runtime only after confirmation. */
  readonly continuation: unknown;
  readonly createdAt: string;
  readonly expiresAt: string;
}
/** Sealed at rest: values include private fields, so this record never leaves custody unredacted. */
export interface CollectionLedger {
  readonly id: string;
  readonly bindingId: string;
  readonly participantId: string;
  readonly interactionId: string;
  readonly action: string;
  readonly phase: CollectionPhase;
  readonly fields: Readonly<Record<string, CollectionFieldState>>;
  readonly values: Readonly<Record<string, unknown>>;
  readonly consent?: CollectionConsent;
  readonly proposal?: CollectionProposal;
  /** The proposal that was executed, kept after completion so its native confirmation echoes the same receipt. */
  readonly executedProposalId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
}
export type CaptureOutcome = Readonly<
  Record<
    string,
    | { readonly status: 'captured'; readonly value: unknown }
    | { readonly status: 'invalid' | 'ambiguous'; readonly reason: string }
  >
>;
export class CollectionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'CollectionError';
  }
}

const TERMINAL: ReadonlySet<CollectionPhase> = new Set(['completed', 'cancelled', 'expired']);
const iso = (now: number): string => new Date(now).toISOString();

export function openCollection(
  spec: CollectionSpec,
  input: {
    readonly id: string;
    readonly bindingId: string;
    readonly participantId: string;
    readonly now: number;
    readonly retentionMs?: number;
  },
): CollectionLedger {
  const fields: Record<string, CollectionFieldState> = {};
  for (const field of spec.fields) fields[field.key] = { status: 'missing', attempts: 0 };
  return {
    id: input.id,
    bindingId: input.bindingId,
    participantId: input.participantId,
    interactionId: spec.interactionId,
    action: spec.action,
    phase: 'collecting',
    fields,
    values: {},
    createdAt: iso(input.now),
    updatedAt: iso(input.now),
    expiresAt: iso(input.now + (input.retentionMs ?? CHANNEL_RETENTION_MS)),
  };
}

/** Non-consent fields a capture turn may still fill or repair. */
export function neededFields(
  spec: CollectionSpec,
  ledger: CollectionLedger,
): readonly CollectionField[] {
  return spec.fields.filter(
    (field) => field.control !== 'consent' && ledger.fields[field.key]?.status !== 'captured',
  );
}
function complete(spec: CollectionSpec, ledger: CollectionLedger): boolean {
  return spec.fields.every(
    (field) =>
      field.control === 'consent' ||
      field.optional === true ||
      ledger.fields[field.key]?.status === 'captured',
  );
}
/** A spec without a consent control needs no consent turn: fields complete straight to confirmation. */
function consentRequired(spec: CollectionSpec): boolean {
  return spec.fields.some((field) => field.control === 'consent');
}
function requireOpen(ledger: CollectionLedger): void {
  if (TERMINAL.has(ledger.phase) || ledger.phase === 'executing')
    throw new CollectionError('phase_invalid');
}
/** Recompute the phase after fields changed; a changed value always drops the pending proposal. */
function settle(spec: CollectionSpec, ledger: CollectionLedger, now: number): CollectionLedger {
  const { proposal: _dropped, ...rest } = ledger;
  const phase: CollectionPhase = !complete(spec, ledger)
    ? 'collecting'
    : ledger.consent?.given || !consentRequired(spec)
      ? 'awaiting_confirmation'
      : 'awaiting_consent';
  return { ...rest, phase, updatedAt: iso(now) };
}
function close(ledger: CollectionLedger, phase: CollectionPhase, now: number): CollectionLedger {
  const { proposal: _continuation, ...rest } = ledger;
  return { ...rest, phase, values: {}, updatedAt: iso(now) };
}

export function applyCapture(
  spec: CollectionSpec,
  ledger: CollectionLedger,
  outcome: CaptureOutcome,
  now: number,
): CollectionLedger {
  requireOpen(ledger);
  const fields = { ...ledger.fields };
  const values = { ...ledger.values };
  let touched = false;
  for (const field of spec.fields) {
    const result = outcome[field.key];
    if (result === undefined || field.control === 'consent') continue;
    touched = true;
    const attempts = (fields[field.key]?.attempts ?? 0) + 1;
    if (result.status === 'captured') {
      fields[field.key] = { status: 'captured', attempts };
      values[field.key] = result.value;
    } else {
      fields[field.key] = { status: result.status, reason: result.reason, attempts };
      delete values[field.key];
    }
  }
  // A turn that changes nothing keeps the pending proposal; only a new value invalidates it.
  if (!touched) return { ...ledger, updatedAt: iso(now) };
  return settle(spec, { ...ledger, fields, values }, now);
}

/** The user said a stored value is wrong; keep it so a partial correction can be applied. */
export function rejectField(
  spec: CollectionSpec,
  ledger: CollectionLedger,
  key: string,
  now: number,
): CollectionLedger {
  requireOpen(ledger);
  const current = ledger.fields[key];
  if (current === undefined) throw new CollectionError('field_unknown');
  return settle(
    spec,
    {
      ...ledger,
      fields: {
        ...ledger.fields,
        [key]: { status: 'rejected_by_user', reason: 'rejected', attempts: current.attempts },
      },
    },
    now,
  );
}

export function applyConsent(
  spec: CollectionSpec,
  ledger: CollectionLedger,
  decision: 'given' | 'declined',
  questionVersion: string,
  now: number,
): CollectionLedger {
  if (ledger.phase !== 'awaiting_consent') throw new CollectionError('phase_invalid');
  const consent: CollectionConsent = { given: decision === 'given', questionVersion, at: iso(now) };
  if (decision === 'declined') return close({ ...ledger, consent }, 'cancelled', now);
  const fields = { ...ledger.fields };
  const values = { ...ledger.values };
  for (const field of spec.fields) {
    if (field.control !== 'consent') continue;
    fields[field.key] = { status: 'captured', attempts: (fields[field.key]?.attempts ?? 0) + 1 };
    values[field.key] = true;
  }
  return {
    ...ledger,
    consent,
    fields,
    values,
    phase: 'awaiting_confirmation',
    updatedAt: iso(now),
  };
}

export function attachProposal(
  spec: CollectionSpec,
  ledger: CollectionLedger,
  proposal: { readonly id: string; readonly review: string; readonly continuation: unknown },
  now: number,
): CollectionLedger {
  if (
    ledger.phase !== 'awaiting_confirmation' ||
    (consentRequired(spec) && ledger.consent?.given !== true)
  )
    throw new CollectionError('phase_invalid');
  return {
    ...ledger,
    proposal: {
      ...proposal,
      createdAt: iso(now),
      expiresAt: iso(now + spec.confirmationExpiryMs),
    },
    updatedAt: iso(now),
  };
}

export function pendingProposal(
  ledger: CollectionLedger,
  now: number,
): CollectionProposal | undefined {
  const proposal = ledger.proposal;
  if (proposal === undefined || Date.parse(proposal.expiresAt) <= now) return undefined;
  return proposal;
}

export function applyConfirmation(
  ledger: CollectionLedger,
  act: 'confirm' | 'cancel',
  now: number,
): CollectionLedger {
  if (act === 'cancel') return cancelCollection(ledger, now);
  if (ledger.phase !== 'awaiting_confirmation') throw new CollectionError('phase_invalid');
  if (ledger.proposal === undefined) throw new CollectionError('proposal_missing');
  if (pendingProposal(ledger, now) === undefined) throw new CollectionError('proposal_expired');
  return { ...ledger, phase: 'executing', updatedAt: iso(now) };
}

export function completeCollection(ledger: CollectionLedger, now: number): CollectionLedger {
  if (ledger.phase !== 'executing') throw new CollectionError('phase_invalid');
  const done = close(ledger, 'completed', now);
  return ledger.proposal === undefined ? done : { ...done, executedProposalId: ledger.proposal.id };
}

/** The participant asked to change something before saying what: the proposal and its acts lapse, every value stays. */
export function withdrawProposal(ledger: CollectionLedger, now: number): CollectionLedger {
  requireOpen(ledger);
  const { proposal: _withdrawn, ...rest } = ledger;
  return { ...rest, updatedAt: iso(now) };
}

export function cancelCollection(ledger: CollectionLedger, now: number): CollectionLedger {
  if (TERMINAL.has(ledger.phase)) throw new CollectionError('phase_invalid');
  return close(ledger, 'cancelled', now);
}

/** Returns the same ledger when nothing has expired, so callers can detect a change by identity. */
export function expireCollection(ledger: CollectionLedger, now: number): CollectionLedger {
  if (TERMINAL.has(ledger.phase)) return ledger;
  if (Date.parse(ledger.expiresAt) <= now) return close(ledger, 'expired', now);
  if (ledger.proposal !== undefined && pendingProposal(ledger, now) === undefined) {
    const { proposal: _expired, ...rest } = ledger;
    return { ...rest, updatedAt: iso(now) };
  }
  return ledger;
}
