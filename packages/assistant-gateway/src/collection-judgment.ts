import { z } from 'zod';
import type { CollectionSpec } from './collection-ledger.js';
import { boundedJsonCall, type CollectionModelDeps } from './collection-model-call.js';
import { type ParsedControl, scanTypedValues } from './collection-parsers.js';

/** A judged consent counts only at or above this confidence; below it the runtime re-asks. */
export const CONSENT_THRESHOLD = 0.85;
/** A judged confirmation binds a real write, so it is stricter than consent. */
export const CONFIRM_THRESHOLD = 0.95;
export const CONFIRMATION_AFFIRMATIVES: readonly string[] = [
  'yes',
  'y',
  'ok',
  'okay',
  'confirm',
  'confirmed',
  'send',
  'send it',
  'go ahead',
  'sure',
  'yes please',
  'do it',
  'looks good',
];
export const CONFIRMATION_NEGATIVES: readonly string[] = [
  'no',
  'cancel',
  'stop',
  'never mind',
  'nevermind',
  "don't",
  'dont',
  'forget it',
];
/** Words that turn a reply naming a field into an edit; shared with the runtime's reopen rule. */
export const CORRECTION_CUES =
  /\b(change|changed|actually|instead|wrong|not|should be|make it|update|correct|rather|swap|replace|edit|fix)\b/;
const judgment = z.object({ affirmative: z.boolean(), confidence: z.number().min(0).max(1) });
const PARSED: readonly ParsedControl[] = ['email', 'phone', 'url'];

/** Lowercase, collapse whitespace, straighten quotes and drop trailing punctuation. */
export function normaliseReply(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s.!?,;:…]+$/u, '');
}

/**
 * Judge whether a free reply answers the fixed question affirmatively. The two messages carry the
 * question and the reply only, never a collected value or the review.
 */
async function judgeAffirmative(
  deps: CollectionModelDeps,
  question: string,
  reply: string,
): Promise<{ affirmative: boolean; confidence: number } | undefined> {
  return boundedJsonCall(
    deps,
    [
      `The assistant asked the user this yes-or-no question: ${JSON.stringify(question)}`,
      'Judge whether the reply is an affirmative answer to exactly that question.',
      'A reply that asks for a change, adds a condition, gives new information or answers something else is not affirmative.',
      'Reply with exactly one JSON object shaped {"affirmative": true or false, "confidence": a number from 0 to 1}.',
    ].join('\n'),
    reply,
    judgment,
  );
}

export async function consentReply(
  text: string,
  spec: CollectionSpec,
  deps: CollectionModelDeps,
): Promise<'given' | 'declined' | 'unclear'> {
  const reply = normaliseReply(text);
  if (reply === 'yes') return 'given';
  if (reply === 'no') return 'declined';
  const judged = await judgeAffirmative(deps, spec.consentQuestion, text);
  if (judged === undefined || judged.confidence < CONSENT_THRESHOLD) return 'unclear';
  return judged.affirmative ? 'given' : 'declined';
}

/** A reply that offers a value or names a field with a correction cue is an edit, never a confirmation. */
function carriesEdit(text: string, spec: CollectionSpec): boolean {
  const controls = PARSED.filter((control) =>
    spec.fields.some((field) => field.control === control),
  );
  if (scanTypedValues(text, controls).length > 0) return true;
  const lower = text.toLowerCase();
  const namesField = spec.fields.some(
    (field) =>
      field.control !== 'consent' &&
      (lower.includes(field.title.toLowerCase()) ||
        new RegExp(`\\b${field.key}\\b`, 'i').test(text)),
  );
  return namesField && CORRECTION_CUES.test(lower);
}

export async function confirmationReply(
  text: string,
  spec: CollectionSpec,
  deps: CollectionModelDeps,
): Promise<'confirm' | 'cancel' | 'edit' | 'unclear'> {
  if (carriesEdit(text, spec)) return 'edit';
  const reply = normaliseReply(text);
  if (CONFIRMATION_AFFIRMATIVES.includes(reply)) return 'confirm';
  if (CONFIRMATION_NEGATIVES.includes(reply)) return 'cancel';
  const judged = await judgeAffirmative(deps, 'Shall I send it? Yes or no.', text);
  if (judged === undefined || !judged.affirmative || judged.confidence < CONFIRM_THRESHOLD)
    return 'unclear';
  return 'confirm';
}
