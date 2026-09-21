import { validateJsonSchema } from '@noodle-borg/compiler';
import { z } from 'zod';
import {
  applyCapture,
  type CaptureOutcome,
  type CollectionField,
  type CollectionLedger,
  type CollectionSpec,
  neededFields,
} from './collection-ledger.js';
import { boundedJsonCall, type CollectionModelDeps } from './collection-model-call.js';
import {
  normaliseTypedValue,
  type ParsedControl,
  type ParsedSpan,
  redactSpans,
  scanTypedValues,
} from './collection-parsers.js';

const PARSED: ReadonlySet<string> = new Set<ParsedControl>(['email', 'phone', 'url']);
const extraction = z.record(z.string(), z.unknown());
type Outcome = Record<string, CaptureOutcome[string]>;

function isParsed(control: string): control is ParsedControl {
  return PARSED.has(control);
}

/**
 * Deterministic step: a parser assigns a value only when exactly one candidate meets exactly one
 * needed field of that control; competing candidates mark the field ambiguous. Every candidate,
 * assigned or not, is redacted from the text before a model sees it.
 */
function parseTurn(
  needed: readonly CollectionField[],
  utterance: string,
): { outcome: Outcome; redacted: string } {
  const controls = [...new Set(needed.map((field) => field.control).filter(isParsed))];
  const spans = scanTypedValues(utterance, controls);
  const outcome: Outcome = {};
  const assigned = new Set<ParsedSpan>();
  for (const control of controls) {
    const fields = needed.filter((field) => field.control === control);
    const candidates = spans.filter((span) => span.control === control);
    if (candidates.length === 0) continue;
    const [onlyField] = fields;
    const [onlyCandidate] = candidates;
    if (fields.length === 1 && candidates.length === 1 && onlyField && onlyCandidate) {
      outcome[onlyField.key] = { status: 'captured', value: onlyCandidate.value };
      assigned.add(onlyCandidate);
      continue;
    }
    const reason = candidates.length > 1 ? 'multiple_candidates' : 'multiple_fields';
    for (const field of fields) outcome[field.key] = { status: 'ambiguous', reason };
  }
  const redacted = redactSpans(utterance, spans, (span) =>
    assigned.has(span) ? `[${span.control} captured]` : `[${span.control} withheld]`,
  );
  return { outcome, redacted };
}

/** Control rules first, then the action's own property schema; a failure is a code, never a value. */
function validateCandidate(field: CollectionField, raw: unknown): CaptureOutcome[string] {
  let value = raw;
  if (isParsed(field.control)) {
    value = typeof raw === 'string' ? normaliseTypedValue(field.control, raw) : undefined;
    if (value === undefined) return { status: 'invalid', reason: 'format' };
  } else if (field.control === 'select') {
    const option =
      typeof raw === 'string'
        ? field.options?.find((candidate) => candidate.toLowerCase() === raw.trim().toLowerCase())
        : undefined;
    if (option === undefined) return { status: 'invalid', reason: 'option' };
    value = option;
  } else if (typeof raw === 'string') {
    value = raw.trim();
  }
  if (validateJsonSchema(field.schema, value).length > 0)
    return { status: 'invalid', reason: 'schema' };
  return { status: 'captured', value };
}

function extractionInstruction(
  needed: readonly CollectionField[],
  ledger: CollectionLedger,
): string {
  const fields = needed.map((field) => ({
    key: field.key,
    title: field.title,
    control: field.control,
    ...(field.options === undefined ? {} : { options: field.options }),
    ...(ledger.fields[field.key]?.status === 'rejected_by_user' && field.key in ledger.values
      ? {
          current: ledger.values[field.key],
          note: 'the user said this value is wrong; apply their correction to it',
        }
      : {}),
  }));
  return [
    'Read the values the user states for these fields and reply with exactly one JSON object whose keys are the field keys.',
    'Use null for any field the message does not state. Never guess, infer or invent a value.',
    'Keep the user wording for text fields. For a select field return one of its options exactly, or null.',
    'Bracketed placeholders such as [email captured] stand for values already taken; leave those fields null.',
    `Fields: ${JSON.stringify(fields)}`,
  ].join('\n');
}

/**
 * One user turn while a collection is open: parsers first, then at most one bounded extraction call
 * for whatever still needs a value. Values reach the caller only inside the returned ledger.
 */
export async function capture(
  spec: CollectionSpec,
  ledger: CollectionLedger,
  utterance: string,
  deps: CollectionModelDeps,
  now: number,
): Promise<CollectionLedger> {
  const needed = neededFields(spec, ledger);
  const { outcome, redacted } = parseTurn(needed, utterance);
  const remaining = needed.filter((field) => outcome[field.key] === undefined);
  const content = redacted.replace(/\[(?:email|phone|url) (?:captured|withheld)\]/g, '').trim();
  if (remaining.length > 0 && /[\p{L}\p{N}]/u.test(content)) {
    const extracted = await boundedJsonCall(
      deps,
      extractionInstruction(remaining, ledger),
      redacted,
      extraction,
    );
    for (const field of remaining) {
      const raw = extracted?.[field.key];
      if (raw === undefined || raw === null) continue;
      outcome[field.key] = validateCandidate(field, raw);
    }
  }
  return applyCapture(spec, ledger, outcome, now);
}
