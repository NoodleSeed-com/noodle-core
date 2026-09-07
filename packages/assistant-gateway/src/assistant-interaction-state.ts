import type { InvocationContext } from '@noodle-borg/runtime';
import { isCredentialShapedAssistantText } from './assistant-sensitive-values.js';

export const DEFAULT_MAX_PENDING_INTERACTIONS_PER_SESSION = 8;
export const ASSISTANT_INTERACTION_OUTCOME_RETENTION_MS = 24 * 60 * 60 * 1000;
/** Enforced maximum for one accepted flow; individual connector actions keep their shorter bounds. */
export const ASSISTANT_INTERACTION_EXECUTION_LIMIT_MS = 120_000;

export type AssistantInteractionKind = 'confirmation' | 'input';
export type AssistantInteractionStatus =
  | 'pending'
  | 'executing'
  | 'succeeded'
  | 'failed'
  | 'declined'
  | 'cancelled';

export type AssistantInteractionPublicScalar = string | number | boolean | null;
export interface AssistantInteractionPublicArray
  extends ReadonlyArray<AssistantInteractionPublicValue> {
  readonly [index: number]: AssistantInteractionPublicValue;
}
export interface AssistantInteractionPublicObject {
  readonly [key: string]: AssistantInteractionPublicValue;
}
export type AssistantInteractionPublicValue =
  | AssistantInteractionPublicScalar
  | AssistantInteractionPublicArray
  | AssistantInteractionPublicObject;

/** Compact replay-safe data only. Exact connector output and errors must never enter this shape. */
export interface AssistantInteractionPublicOutcome {
  readonly code: string;
  readonly summary: string;
  readonly details?: Readonly<Record<string, AssistantInteractionPublicScalar>>;
  readonly result?: AssistantInteractionPublicValue;
}

export const ASSISTANT_INTERACTION_UNKNOWN_OUTCOME: AssistantInteractionPublicOutcome = {
  code: 'interaction_outcome_unknown',
  summary: 'The action may have completed, but its outcome could not be verified.',
};

interface AssistantInteractionCommon {
  readonly id: string;
  readonly sessionId: string;
  readonly deploymentId: string;
  /** Immutable proposal-time snapshot reused when the interaction resumes. */
  readonly context?: InvocationContext;
  /** Set when an interaction's exact private payload has left durable custody. */
  readonly payloadScrubbedAt?: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

interface AssistantConfirmationInteractionPayload {
  readonly kind: 'confirmation';
  readonly tool: string;
  /** Exact validated arguments. Store-internal; renderers receive a separate review projection. */
  readonly arguments: unknown;
  /** Prepared post-elicitation execution state. Server-internal and absent on legacy proposals. */
  readonly continuation?: unknown;
  /** Complete, already-redacted review projection retained so a lost response can be replayed. */
  readonly review?: unknown;
}

interface AssistantInputInteractionPayload {
  readonly kind: 'input';
  readonly tool: string;
  readonly message: string;
  readonly requestedSchema: Readonly<Record<string, unknown>>;
  /** Exact runtime continuation. Store-internal and never part of the public interaction event. */
  readonly continuation: unknown;
}

export interface AssistantPendingInteractionState {
  readonly status: 'pending';
}

export interface AssistantExecutingInteractionState {
  readonly status: 'executing';
  readonly claimedAt: string;
}

export interface AssistantSucceededInteractionState {
  readonly status: 'succeeded';
  readonly claimedAt: string;
  readonly completedAt: string;
  readonly publicOutcome: AssistantInteractionPublicOutcome;
}

export interface AssistantFailedInteractionState {
  readonly status: 'failed';
  readonly claimedAt: string;
  readonly completedAt: string;
  readonly publicOutcome: AssistantInteractionPublicOutcome;
}

export interface AssistantDeclinedInteractionState {
  readonly status: 'declined';
  readonly completedAt: string;
  readonly publicOutcome: AssistantInteractionPublicOutcome;
}

export interface AssistantCancelledInteractionState {
  readonly status: 'cancelled';
  readonly completedAt: string;
  readonly publicOutcome: AssistantInteractionPublicOutcome;
}

export type AssistantInteractionState =
  | AssistantPendingInteractionState
  | AssistantExecutingInteractionState
  | AssistantSucceededInteractionState
  | AssistantFailedInteractionState
  | AssistantDeclinedInteractionState
  | AssistantCancelledInteractionState;
export type AssistantTerminalInteractionState =
  | AssistantSucceededInteractionState
  | AssistantFailedInteractionState
  | AssistantDeclinedInteractionState
  | AssistantCancelledInteractionState;

export type AssistantConfirmationInteractionRecord = AssistantInteractionCommon &
  AssistantConfirmationInteractionPayload &
  AssistantInteractionState;
export type AssistantInputInteractionRecord = AssistantInteractionCommon &
  AssistantInputInteractionPayload &
  AssistantInteractionState;
export type AssistantInteractionRecord =
  | AssistantConfirmationInteractionRecord
  | AssistantInputInteractionRecord;

export type AssistantPendingConfirmationInteractionRecord = AssistantInteractionCommon &
  AssistantConfirmationInteractionPayload &
  AssistantPendingInteractionState;
export type AssistantPendingInputInteractionRecord = AssistantInteractionCommon &
  AssistantInputInteractionPayload &
  AssistantPendingInteractionState;
export type AssistantPendingInteractionRecord =
  | AssistantPendingConfirmationInteractionRecord
  | AssistantPendingInputInteractionRecord;

interface AssistantInteractionCreateCommon {
  readonly sessionId: string;
  readonly deploymentId: string;
  readonly context?: InvocationContext;
  /** Omit only when the persistence adapter should stamp its own proposal time. */
  readonly createdAt?: string;
  readonly expiresAt: string;
}

export type AssistantConfirmationInteractionCreateInput = AssistantInteractionCreateCommon &
  Omit<AssistantConfirmationInteractionPayload, never>;
export type AssistantInputInteractionCreateInput = AssistantInteractionCreateCommon &
  Omit<AssistantInputInteractionPayload, never>;
export type AssistantInteractionCreateInput =
  | AssistantConfirmationInteractionCreateInput
  | AssistantInputInteractionCreateInput;

export interface AssistantInteractionScope {
  readonly id: string;
  readonly sessionId: string;
  readonly deploymentId: string;
  readonly now: Date;
}

export type AssistantInteractionClaimResult =
  | {
      readonly disposition: 'claimed';
      readonly interaction: AssistantInteractionRecord & AssistantExecutingInteractionState;
    }
  | { readonly disposition: 'replay'; readonly interaction: AssistantInteractionRecord }
  | { readonly disposition: 'unavailable' };

export type AssistantInteractionCompletion =
  | {
      readonly status: 'succeeded' | 'failed';
      readonly publicOutcome: AssistantInteractionPublicOutcome;
    }
  | {
      readonly status: 'declined' | 'cancelled';
      readonly publicOutcome?: AssistantInteractionPublicOutcome;
    };

export type AssistantInteractionCompletionResult =
  | { readonly disposition: 'completed'; readonly interaction: AssistantInteractionRecord }
  | { readonly disposition: 'replay'; readonly interaction: AssistantInteractionRecord }
  | { readonly disposition: 'conflict'; readonly interaction: AssistantInteractionRecord }
  | { readonly disposition: 'unavailable' };

export type AssistantInteractionTransitionNext =
  | Omit<AssistantConfirmationInteractionCreateInput, 'sessionId' | 'deploymentId' | 'createdAt'>
  | Omit<AssistantInputInteractionCreateInput, 'sessionId' | 'deploymentId' | 'createdAt'>;

/**
 * Atomically records that an executing interaction handed control to one new pending interaction.
 * The store owns the child identity and persists it in the parent's replay-safe public outcome.
 */
export interface AssistantInteractionTransitionInput extends AssistantInteractionScope {
  readonly publicOutcome: AssistantInteractionPublicOutcome;
  readonly next: AssistantInteractionTransitionNext;
}

export type AssistantInteractionTransitionResult =
  | {
      readonly disposition: 'transitioned';
      readonly interaction: AssistantInteractionRecord & AssistantSucceededInteractionState;
      readonly next: AssistantPendingInteractionRecord;
    }
  | { readonly disposition: 'replay'; readonly interaction: AssistantInteractionRecord }
  | { readonly disposition: 'conflict'; readonly interaction: AssistantInteractionRecord }
  | { readonly disposition: 'unavailable' };

export class AssistantInteractionCapacityError extends Error {
  readonly code = 'pending_interaction_limit' as const;

  constructor() {
    super('assistant session has too many pending interactions');
    this.name = 'AssistantInteractionCapacityError';
  }
}

export function createPendingInteraction(
  id: string,
  input: AssistantConfirmationInteractionCreateInput,
): AssistantPendingConfirmationInteractionRecord;
export function createPendingInteraction(
  id: string,
  input: AssistantInputInteractionCreateInput,
): AssistantPendingInputInteractionRecord;
export function createPendingInteraction(
  id: string,
  input: AssistantInteractionCreateInput,
): AssistantPendingInteractionRecord {
  const createdAt = validTimestamp(input.createdAt ?? new Date().toISOString(), 'createdAt');
  const common = {
    id,
    sessionId: input.sessionId,
    deploymentId: input.deploymentId,
    ...(input.context !== undefined ? { context: cloneJson(input.context, 'context') } : {}),
    createdAt,
    expiresAt: validTimestamp(input.expiresAt, 'expiresAt'),
    status: 'pending' as const,
  };
  return input.kind === 'confirmation'
    ? {
        ...common,
        kind: 'confirmation',
        tool: input.tool,
        arguments: cloneJson(input.arguments, 'arguments'),
        ...(input.continuation !== undefined
          ? { continuation: cloneJson(input.continuation, 'continuation') }
          : {}),
        ...(input.review !== undefined ? { review: cloneJson(input.review, 'review') } : {}),
      }
    : {
        ...common,
        kind: 'input',
        tool: input.tool,
        message: input.message,
        requestedSchema: cloneJson(input.requestedSchema, 'requestedSchema'),
        continuation: cloneJson(input.continuation, 'continuation'),
      };
}

export function executingInteraction(
  interaction: AssistantInteractionRecord,
  claimedAt: Date,
): AssistantInteractionRecord & AssistantExecutingInteractionState {
  if (interaction.status !== 'pending') throw new Error('only pending interactions can be claimed');
  return cloneInteraction({
    ...interaction,
    status: 'executing',
    claimedAt: claimedAt.toISOString(),
  });
}

export function completedInteraction(
  interaction: AssistantInteractionRecord,
  completion: AssistantInteractionCompletion,
  completedAt: Date,
): AssistantInteractionRecord & AssistantTerminalInteractionState {
  if (completion.status === 'succeeded' || completion.status === 'failed') {
    if (interaction.status !== 'executing') {
      throw new Error('successful or failed completion requires an executing interaction');
    }
    const publicOutcome = normalizePublicOutcome(completion.publicOutcome);
    return scrubTerminalInteraction({
      ...interaction,
      status: completion.status,
      completedAt: completedAt.toISOString(),
      publicOutcome,
    } as AssistantInteractionRecord & AssistantTerminalInteractionState);
  }
  if (interaction.status !== 'pending') {
    throw new Error('decline or cancel completion requires a pending interaction');
  }
  const publicOutcome = normalizePublicOutcome(
    completion.publicOutcome ?? defaultPublicOutcome(completion.status),
  );
  return scrubTerminalInteraction({
    ...interaction,
    status: completion.status,
    completedAt: completedAt.toISOString(),
    publicOutcome,
  } as AssistantInteractionRecord & AssistantTerminalInteractionState);
}

export function transitionedInteractions(
  interaction: AssistantInteractionRecord,
  input: AssistantInteractionTransitionInput,
  nextId: string,
): {
  readonly interaction: AssistantInteractionRecord & AssistantSucceededInteractionState;
  readonly next: AssistantPendingInteractionRecord;
} {
  if (interaction.status !== 'executing') {
    throw new Error('interaction transition requires an executing interaction');
  }
  const nextInput = {
    ...input.next,
    sessionId: interaction.sessionId,
    deploymentId: interaction.deploymentId,
    createdAt: input.now.toISOString(),
  };
  const next =
    nextInput.kind === 'confirmation'
      ? createPendingInteraction(nextId, nextInput)
      : createPendingInteraction(nextId, nextInput);
  const details = Object.fromEntries(
    Object.entries(input.publicOutcome.details ?? {}).filter(
      ([key]) => key !== 'nextInteractionId',
    ),
  );
  const completed = completedInteraction(
    interaction,
    {
      status: 'succeeded',
      publicOutcome: {
        ...input.publicOutcome,
        // Reserve the replay link and put it first so bounded normalization cannot omit it.
        details: { nextInteractionId: next.id, ...details },
      },
    },
    input.now,
  );
  if (completed.status !== 'succeeded') {
    throw new Error('assistant interaction transition did not produce a succeeded parent');
  }
  return { interaction: completed, next };
}

export function isTerminalInteraction(
  interaction: AssistantInteractionRecord,
): interaction is AssistantInteractionRecord & AssistantTerminalInteractionState {
  return (
    interaction.status === 'succeeded' ||
    interaction.status === 'failed' ||
    interaction.status === 'declined' ||
    interaction.status === 'cancelled'
  );
}

/**
 * Pending proposals expire at their decision deadline. Executing/unknown work keeps a tombstone, and a
 * terminal public outcome remains replayable for a bounded reconciliation window after completion.
 */
export function isPrunableInteraction(interaction: AssistantInteractionRecord, now: Date): boolean {
  if (interaction.status === 'executing') return false;
  if (interaction.status === 'pending') return Date.parse(interaction.expiresAt) <= now.getTime();
  return (
    Date.parse(interaction.completedAt) + ASSISTANT_INTERACTION_OUTCOME_RETENTION_MS <=
    now.getTime()
  );
}

export function shouldExpireStrandedExecutingInteraction(
  interaction: AssistantInteractionRecord,
  now: Date,
): interaction is AssistantInteractionRecord & AssistantExecutingInteractionState {
  return (
    interaction.status === 'executing' &&
    Date.parse(interaction.claimedAt) + ASSISTANT_INTERACTION_EXECUTION_LIMIT_MS <= now.getTime()
  );
}

/** Preserve a non-retryable unknown outcome without retaining its exact private payload. */
export function expireStrandedExecutingInteraction(
  interaction: AssistantInteractionRecord & AssistantExecutingInteractionState,
  scrubbedAt: Date,
): AssistantInteractionRecord & AssistantFailedInteractionState {
  const completedAt = scrubbedAt.toISOString();
  return scrubTerminalInteraction({
    ...interaction,
    status: 'failed' as const,
    completedAt,
    publicOutcome: ASSISTANT_INTERACTION_UNKNOWN_OUTCOME,
  } as AssistantInteractionRecord & AssistantFailedInteractionState) as AssistantInteractionRecord &
    AssistantFailedInteractionState;
}

/** Exact inputs leave durable custody when handed to the single executor, before connector I/O. */
export function scrubExecutingInteraction(
  interaction: AssistantInteractionRecord & AssistantExecutingInteractionState,
): AssistantInteractionRecord & AssistantExecutingInteractionState {
  const scrubbed = scrubInteractionPayload(interaction, interaction.claimedAt);
  if (scrubbed.status !== 'executing') throw new Error('interaction status changed during scrub');
  return scrubbed;
}
function scrubTerminalInteraction(
  interaction: AssistantInteractionRecord & AssistantTerminalInteractionState,
): AssistantInteractionRecord & AssistantTerminalInteractionState {
  const scrubbed = scrubInteractionPayload(interaction, interaction.completedAt);
  if (!isTerminalInteraction(scrubbed)) throw new Error('interaction status changed during scrub');
  return scrubbed;
}
function scrubInteractionPayload(
  interaction: AssistantInteractionRecord,
  instant: string,
): AssistantInteractionRecord {
  if (interaction.kind === 'confirmation') {
    const {
      context: _context,
      continuation: _continuation,
      review: _review,
      ...withoutPrivate
    } = interaction;
    return cloneInteraction({
      ...withoutPrivate,
      arguments: null,
      payloadScrubbedAt: instant,
    });
  }
  const { context: _context, ...withoutContext } = interaction;
  return cloneInteraction({
    ...withoutContext,
    continuation: null,
    payloadScrubbedAt: instant,
  });
}

export function cloneInteraction<T extends AssistantInteractionRecord>(interaction: T): T {
  return cloneJson(interaction, 'interaction');
}

const MAX_PUBLIC_OUTCOME_CODE = 64;
const MAX_PUBLIC_OUTCOME_SUMMARY = 500;
const MAX_PUBLIC_OUTCOME_DETAILS = 16;
const MAX_PUBLIC_OUTCOME_DETAIL_STRING = 240;
const MAX_PUBLIC_OUTCOME_RESULT_BYTES = 16 * 1024;
const MAX_PUBLIC_OUTCOME_RESULT_DEPTH = 8;
const MAX_PUBLIC_OUTCOME_RESULT_ENTRIES = 128;
const MAX_PUBLIC_OUTCOME_RESULT_TOTAL_ENTRIES = 512;
const MAX_PUBLIC_OUTCOME_RESULT_STRING = 2_048;
const MAX_PUBLIC_OUTCOME_RESULT_KEY = 128;
const SAFE_DETAIL_KEY = /^[A-Za-z0-9_.-]{1,64}$/;
const UNSAFE_OBJECT_KEY = /^(?:__proto__|constructor|prototype)$/;
const SENSITIVE_KEY =
  /(?:authorization|bearer|token|refresh|secret|api[_-]?key|apikey|password|private[_-]?key|credential|cookie|set-cookie)/i;
const REDACTED = '[redacted]';

export function normalizePublicOutcome(
  input: AssistantInteractionPublicOutcome,
): AssistantInteractionPublicOutcome {
  const code = /^[A-Za-z0-9_.-]+$/.test(input.code)
    ? input.code.slice(0, MAX_PUBLIC_OUTCOME_CODE)
    : 'interaction_outcome';
  const summary = redactString(input.summary, MAX_PUBLIC_OUTCOME_SUMMARY);
  const details: Record<string, AssistantInteractionPublicScalar> = {};
  for (const [key, value] of Object.entries(input.details ?? {})) {
    if (Object.keys(details).length >= MAX_PUBLIC_OUTCOME_DETAILS) break;
    if (!SAFE_DETAIL_KEY.test(key)) continue;
    details[key] = SENSITIVE_KEY.test(key) ? REDACTED : normalizePublicScalar(value as unknown);
  }
  return {
    code,
    summary,
    ...(Object.keys(details).length > 0 ? { details } : {}),
    ...(input.result !== undefined ? { result: normalizePublicResult(input.result) } : {}),
  };
}

function normalizePublicResult(value: unknown): AssistantInteractionPublicValue {
  const result = projectPublicResult(value, 0, {
    remainingEntries: MAX_PUBLIC_OUTCOME_RESULT_TOTAL_ENTRIES,
    ancestors: new WeakSet<object>(),
  });
  const serialized = JSON.stringify(result);
  if (new TextEncoder().encode(serialized).byteLength <= MAX_PUBLIC_OUTCOME_RESULT_BYTES) {
    return result;
  }
  return { notice: '[result omitted: exceeds 16 KiB]' };
}

interface PublicResultProjectionState {
  remainingEntries: number;
  readonly ancestors: WeakSet<object>;
}

function projectPublicResult(
  value: unknown,
  depth: number,
  state: PublicResultProjectionState,
): AssistantInteractionPublicValue {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : REDACTED;
  if (typeof value === 'string') return redactString(value, MAX_PUBLIC_OUTCOME_RESULT_STRING);
  if (typeof value !== 'object') return REDACTED;
  if (depth >= MAX_PUBLIC_OUTCOME_RESULT_DEPTH) return '[truncated: maximum depth]';
  if (state.ancestors.has(value)) return '[redacted: circular reference]';

  state.ancestors.add(value);
  if (Array.isArray(value)) {
    const projected: AssistantInteractionPublicValue[] = [];
    for (const item of value.slice(0, MAX_PUBLIC_OUTCOME_RESULT_ENTRIES)) {
      if (state.remainingEntries <= 0) {
        projected.push('[truncated: entry limit]');
        break;
      }
      state.remainingEntries -= 1;
      projected.push(projectPublicResult(item, depth + 1, state));
    }
    if (value.length > MAX_PUBLIC_OUTCOME_RESULT_ENTRIES) {
      projected.push('[truncated: container entry limit]');
    }
    state.ancestors.delete(value);
    return projected;
  }

  const projected: Record<string, AssistantInteractionPublicValue> = Object.create(null) as Record<
    string,
    AssistantInteractionPublicValue
  >;
  const entries = Object.entries(value as Readonly<Record<string, unknown>>);
  for (const [rawKey, item] of entries.slice(0, MAX_PUBLIC_OUTCOME_RESULT_ENTRIES)) {
    if (state.remainingEntries <= 0) {
      projected.resultTruncated = '[truncated: entry limit]';
      break;
    }
    state.remainingEntries -= 1;
    const key = rawKey.slice(0, MAX_PUBLIC_OUTCOME_RESULT_KEY);
    if (UNSAFE_OBJECT_KEY.test(key)) continue;
    projected[key] = SENSITIVE_KEY.test(key)
      ? REDACTED
      : projectPublicResult(item, depth + 1, state);
  }
  if (entries.length > MAX_PUBLIC_OUTCOME_RESULT_ENTRIES) {
    projected.resultTruncated = '[truncated: container entry limit]';
  }
  state.ancestors.delete(value);
  return projected;
}

function normalizePublicScalar(value: unknown): AssistantInteractionPublicScalar {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : REDACTED;
  if (typeof value === 'string') return redactString(value, MAX_PUBLIC_OUTCOME_DETAIL_STRING);
  return REDACTED;
}

function redactString(value: string, limit: number): string {
  return isCredentialShapedAssistantText(value) ? REDACTED : value.slice(0, limit);
}

function defaultPublicOutcome(status: 'declined' | 'cancelled'): AssistantInteractionPublicOutcome {
  return {
    code: `interaction_${status}`,
    summary: status === 'declined' ? 'Interaction declined.' : 'Interaction cancelled.',
  };
}

function validTimestamp(value: string, field: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new RangeError(`invalid interaction ${field}`);
  return new Date(value).toISOString();
}

function cloneJson<T>(value: T, field: string): T {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`interaction ${field} must be JSON-serializable`, { cause: error });
  }
  if (serialized === undefined) {
    throw new TypeError(`interaction ${field} must be JSON-serializable`);
  }
  return JSON.parse(serialized) as T;
}
