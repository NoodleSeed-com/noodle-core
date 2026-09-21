import { randomUUID } from 'node:crypto';
import {
  CONFIRMATION_AFFIRMATIVES,
  CORRECTION_CUES,
  type CollectionModelDeps,
  capture,
  confirmationReply,
  consentReply,
  normaliseReply,
} from '@noodle-borg/assistant-gateway/model-runtime';
import {
  applyConfirmation,
  applyConsent,
  attachProposal,
  type ChannelReplyButton,
  type ChannelStore,
  type CollectionLedger,
  type CollectionSpec,
  cancelCollection,
  channelDigest,
  completeCollection,
  deleteCollection,
  expireCollection,
  ledgerForModel,
  loadCollection,
  type ParsedControl,
  pendingProposal,
  redactSpans,
  rejectField,
  renderReview,
  saveCollection,
  scanTypedValues,
  withdrawProposal,
} from '@noodle-borg/assistant-gateway/portable';
import type { RuntimeArtifact } from '@noodle-borg/compiler';
import type {
  ConfirmationPreparationResult,
  InteractiveExecutionResult,
  PreparedToolContinuation,
} from '@noodle-borg/runtime';
import type { ReviewButtonBinding } from './reply-buttons.js';

/**
 * One inbound message while a participant's natural collection is open (ADR 0240 decision 5). The
 * runtime, not the model, handles consent, the verbatim review, confirmation acts, expiry and the
 * one native write; the model sees a turn only while fields are still being gathered, and then only
 * a redacted utterance plus the ledger's statuses.
 */
export interface CollectionTurnDeps {
  readonly spec: CollectionSpec;
  readonly artifact: RuntimeArtifact;
  readonly model: CollectionModelDeps;
  readonly now: number;
  readonly supportEmail: string;
  readonly prepare: (
    action: string,
    input: Readonly<Record<string, unknown>>,
  ) => Promise<ConfirmationPreparationResult>;
  /** Executes the confirmed proposal; the id keeps the runtime execution identity stable on replay. */
  readonly execute: (
    proposalId: string,
    continuation: PreparedToolContinuation,
  ) => Promise<InteractiveExecutionResult>;
  /** Durable custody: called before any external effect and after every state change. */
  readonly persist: (ledger: CollectionLedger) => Promise<void>;
  readonly remove: () => Promise<void>;
  /** Native review buttons where the channel has them; absent means typed acts only. */
  readonly buttons?: ReviewButtonBinding;
}
export type CollectionTurnOutcome =
  /** A runtime-authored reply, with the review's buttons when a proposal was just offered; no conversation model call. */
  | {
      readonly kind: 'reply';
      readonly ledger: CollectionLedger;
      readonly reply: string;
      readonly buttons?: readonly ChannelReplyButton[];
    }
  /** A tapped button that binds to nothing: close the turn with this code, no reply, no model call. */
  | { readonly kind: 'ignored'; readonly code: string }
  /** Fields are still being gathered: run the conversation model with these inputs. */
  | {
      readonly kind: 'model';
      readonly ledger: CollectionLedger;
      readonly utterance: string;
      readonly note: string;
    }
  /** No collection is open any more; run the turn as usual. */
  | { readonly kind: 'none' };

const PARSED: ReadonlySet<string> = new Set<ParsedControl>(['email', 'phone', 'url']);
function isParsed(control: string): control is ParsedControl {
  return PARSED.has(control);
}
const reply = (ledger: CollectionLedger, text: string): CollectionTurnOutcome => ({
  kind: 'reply',
  ledger,
  reply: text,
});
const IGNORED = {
  kind: 'ignored',
  code: 'button_unbound',
} as const satisfies CollectionTurnOutcome;

export async function runCollectionTurn(
  open: CollectionLedger,
  text: string,
  deps: CollectionTurnDeps,
  /** The opaque id of a tapped review button; the text is then not conversation input. */
  button?: string,
): Promise<CollectionTurnOutcome> {
  const { spec, now } = deps;
  // Re-entry after a crash between the durable claim and the receipt: the write may already have
  // committed, so no clock governs this phase; the same identity re-executes and the connector replays.
  if (open.phase === 'executing') return execute(open, deps);
  const ledger = expireCollection(open, now);
  if (ledger.phase === 'expired') {
    await deps.remove();
    return button === undefined ? { kind: 'none' } : IGNORED;
  }
  if (ledger !== open) {
    // The pending proposal lapsed: nothing was sent, and the participant may start over.
    const cancelled = cancelCollection(ledger, now);
    await deps.persist(cancelled);
    return reply(
      cancelled,
      'That review expired before it was confirmed, so nothing was sent. Tell me if you would like to start again.',
    );
  }
  switch (ledger.phase) {
    case 'completed': {
      // A repeated confirmation inside the window, typed or tapped on the executed review's own
      // button, is the same confirmation: the receipt is echoed without a model call or a write.
      const within = Date.parse(ledger.updatedAt) + spec.confirmationExpiryMs > now;
      const echo =
        within &&
        (button === undefined
          ? CONFIRMATION_AFFIRMATIVES.includes(normaliseReply(text))
          : ledger.executedProposalId !== undefined &&
            deps.buttons?.act(ledger.executedProposalId, button) === 'confirm');
      if (echo) return reply(ledger, spec.successMessage);
      await deps.remove();
      return button === undefined ? { kind: 'none' } : IGNORED;
    }
    case 'cancelled':
      await deps.remove();
      return button === undefined ? { kind: 'none' } : IGNORED;
    case 'awaiting_confirmation': {
      const proposal = pendingProposal(ledger, now);
      // Nothing is pending because the participant withdrew the proposal to edit: capture first.
      if (proposal === undefined)
        return button === undefined ? collect(ledger, text, deps) : IGNORED;
      const act =
        button === undefined
          ? await confirmationReply(text, spec, deps.model)
          : deps.buttons?.act(proposal.id, button);
      if (act === undefined) return IGNORED;
      if (act === 'confirm') return execute(applyConfirmation(ledger, 'confirm', now), deps);
      if (act === 'cancel') {
        const cancelled = cancelCollection(ledger, now);
        await deps.persist(cancelled);
        return reply(cancelled, 'Okay, I have cancelled that. Nothing was sent.');
      }
      if (act === 'unclear') return reply(ledger, 'Shall I send it? Yes or no.');
      if (button !== undefined) {
        // Edit: this proposal and its buttons lapse now; the next message is captured as the change.
        const withdrawn = withdrawProposal(ledger, now);
        await deps.persist(withdrawn);
        return reply(withdrawn, 'Sure. What would you like to change?');
      }
      return collect(ledger, text, deps);
    }
    case 'awaiting_consent': {
      if (button !== undefined) return IGNORED;
      const decision = await consentReply(text, spec, deps.model);
      if (decision === 'unclear') return reply(ledger, 'Just to be clear, is that a yes or a no?');
      const next = applyConsent(spec, ledger, decision, consentVersion(spec), now);
      if (decision === 'declined') {
        await deps.persist(next);
        return reply(next, 'Understood. I have not sent anything.');
      }
      return propose(next, deps);
    }
    default:
      return button === undefined ? collect(ledger, text, deps) : IGNORED;
  }
}

/** Load, persist and clear the participant's ledger inside the binding's own transaction scope. */
export function collectionCustody(store: ChannelStore, bindingId: string, participantId: string) {
  return {
    load: () =>
      store.transaction([bindingId], (tx) => loadCollection(tx, bindingId, participantId)),
    persist: (ledger: CollectionLedger) =>
      store.transaction([bindingId], (tx) =>
        ledger.phase === 'cancelled' || ledger.phase === 'expired'
          ? deleteCollection(tx, bindingId, participantId)
          : saveCollection(tx, ledger),
      ),
    remove: () =>
      store.transaction([bindingId], (tx) => deleteCollection(tx, bindingId, participantId)),
  };
}

/** The trusted messaging admission bucket: binding-scoped, derived after webhook authentication. */
export function messagingAdmissionDigest(bindingId: string, participantId: string): string {
  return channelDigest(JSON.stringify(['messaging', bindingId, participantId]));
}

/**
 * Remove marked-private values from text bound for the conversation model or the transcript: every
 * candidate of a private typed control, plus literal occurrences of a captured private text value.
 */
export function redactPrivate(
  spec: CollectionSpec,
  ledger: CollectionLedger,
  text: string,
): string {
  const privates = spec.fields.filter((field) => field.private === true);
  const controls = [...new Set(privates.map((field) => field.control).filter(isParsed))];
  let out = redactSpans(
    text,
    scanTypedValues(text, controls),
    (span) =>
      `[${privates.find((field) => field.control === span.control)?.title ?? span.control} withheld]`,
  );
  for (const field of privates) {
    if (isParsed(field.control)) continue;
    const value = ledger.values[field.key];
    if (typeof value !== 'string' || value.trim().length < 2) continue;
    out = out.replace(
      new RegExp(value.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
      `[${field.title} withheld]`,
    );
  }
  return out;
}

async function collect(
  ledger: CollectionLedger,
  text: string,
  deps: CollectionTurnDeps,
): Promise<CollectionTurnOutcome> {
  const { spec, now } = deps;
  const captured = await capture(
    spec,
    reopenCorrected(spec, ledger, text, now),
    text,
    deps.model,
    now,
  );
  if (captured.phase === 'awaiting_consent') {
    await deps.persist(captured);
    return reply(captured, spec.consentQuestion);
  }
  if (captured.phase === 'awaiting_confirmation') return propose(captured, deps);
  await deps.persist(captured);
  return {
    kind: 'model',
    ledger: captured,
    utterance: redactPrivate(spec, captured, text),
    note: modelNote(spec, captured, now),
  };
}

/**
 * A captured field named beside a correction cue, or a fresh value of a typed control that has one
 * field, is a correction: reopen it so capture can apply the change and the proposal is invalidated.
 */
function reopenCorrected(
  spec: CollectionSpec,
  ledger: CollectionLedger,
  text: string,
  now: number,
): CollectionLedger {
  const lower = text.toLowerCase();
  const cue = CORRECTION_CUES.test(lower);
  let next = ledger;
  for (const field of spec.fields) {
    if (field.control === 'consent' || next.fields[field.key]?.status !== 'captured') continue;
    const named =
      lower.includes(field.title.toLowerCase()) || new RegExp(`\\b${field.key}\\b`, 'i').test(text);
    const typed =
      isParsed(field.control) &&
      spec.fields.filter((candidate) => candidate.control === field.control).length === 1 &&
      scanTypedValues(text, [field.control]).length > 0;
    if ((named && cue) || typed) next = rejectField(spec, next, field.key, now);
  }
  return next;
}

async function propose(
  ledger: CollectionLedger,
  deps: CollectionTurnDeps,
): Promise<CollectionTurnOutcome> {
  const { spec, now } = deps;
  const prepared = await deps.prepare(spec.action, actionInput(spec, deps.artifact, ledger));
  if (prepared.status !== 'confirmation_required') {
    const cancelled = cancelCollection(ledger, now);
    await deps.persist(cancelled);
    return reply(
      cancelled,
      `I could not prepare that for sending, so nothing was saved. For help, contact ${deps.supportEmail}.`,
    );
  }
  const review = renderReview(spec, ledger.values, ledger.consent);
  const id = randomUUID();
  const proposed = attachProposal(
    spec,
    ledger,
    { id, review, continuation: prepared.continuation },
    now,
  );
  await deps.persist(proposed);
  const buttons = deps.buttons?.render(id);
  return {
    kind: 'reply',
    ledger: proposed,
    reply: `${review}\n\nShall I send it?`,
    ...(buttons === undefined ? {} : { buttons }),
  };
}

async function execute(
  ledger: CollectionLedger,
  deps: CollectionTurnDeps,
): Promise<CollectionTurnOutcome> {
  const { spec, now } = deps;
  const proposal = ledger.proposal;
  if (proposal === undefined) {
    const cancelled = cancelCollection(ledger, now);
    await deps.persist(cancelled);
    return reply(cancelled, 'That review is no longer available, so nothing was sent.');
  }
  // The durable claim precedes the external effect; a retry re-enters here with the same identity.
  await deps.persist(ledger);
  const result = await deps.execute(proposal.id, proposal.continuation as PreparedToolContinuation);
  if (result.status === 'completed') {
    const done = completeCollection(ledger, now);
    await deps.persist(done);
    return reply(done, spec.successMessage);
  }
  const cancelled = cancelCollection(ledger, now);
  await deps.persist(cancelled);
  const changed = result.status === 'failed' && result.error.code === 'configuration_changed';
  return reply(
    cancelled,
    `${changed ? 'The application changed while you were reviewing, so ' : ''}I could not send that, and nothing was saved. Please try again later or contact ${deps.supportEmail}.`,
  );
}

/** The prepared action's input: every ledger value, plus the empty value for an optional field the schema still requires. */
function actionInput(
  spec: CollectionSpec,
  artifact: RuntimeArtifact,
  ledger: CollectionLedger,
): Readonly<Record<string, unknown>> {
  const action = artifact.tools.find((tool) => tool.name === spec.action);
  const required = new Set(
    Array.isArray(action?.inputSchema.required)
      ? action.inputSchema.required.filter((key): key is string => typeof key === 'string')
      : [],
  );
  const input: Record<string, unknown> = { ...ledger.values };
  for (const field of spec.fields)
    if (field.optional === true && !(field.key in input) && required.has(field.key))
      input[field.key] = '';
  return input;
}

function consentVersion(spec: CollectionSpec): string {
  return channelDigest(spec.consentQuestion).slice(0, 16);
}

function modelNote(spec: CollectionSpec, ledger: CollectionLedger, now: number): string {
  const optional = spec.fields.filter((field) => field.optional === true).map((field) => field.key);
  return [
    `Natural collection is open for "${spec.interactionId}": the platform validates values, asks the consent question, shows the review and confirms; you only converse.`,
    `Ledger: ${JSON.stringify({ ...ledgerForModel(spec, ledger, now), optional })}`,
    'Ask naturally, in any grouping and without counters, only for fields whose status is missing, invalid, ambiguous or rejected_by_user; optional fields may stay blank. Answer side questions normally.',
    'Never ask for or repeat a private value, never mention a form, never claim anything was sent, and never ask a yes-or-no question while a proposal is pending.',
  ].join('\n');
}
