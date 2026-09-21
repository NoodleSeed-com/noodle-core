import { randomUUID } from 'node:crypto';
import { type RuntimeArtifact, requiresToolConfirmation } from '@noodle-borg/compiler';
import { evaluateToolAuthorization } from '@noodle-borg/protocol';
import {
  type ExecuteDeps,
  executeToolInteractive,
  type InvocationContext,
} from '@noodle-borg/runtime';
import { assistantModelToolOncePerSession } from './assistant-guide.js';
import type { AssistantToolDispatch } from './assistant-interactive.js';
import { assistantSafeOutput } from './assistant-presentation.js';
import {
  type MessagingTurnContext,
  withAssistantTurnExecutionAuthority,
} from './assistant-turn-context.js';
import { type CollectionLedger, type CollectionSpec, openCollection } from './collection-ledger.js';
import { ledgerForModel } from './collection-review.js';
import { collectionSpecFor, seedCollection } from './collection-spec.js';

/**
 * How a messaging turn opens natural collection when the model calls a `collect` opener (ADR 0240).
 * The transport owns the participant's ledger custody; the dispatcher only opens and seeds.
 */
export interface MessagingCollectionPort {
  /** The participant's open ledger, if any: an opener never opens a second one. */
  readonly open: CollectionLedger | undefined;
  readonly now: number;
  readonly retentionMs: number;
  readonly confirmationExpiryMs: number;
  save(ledger: CollectionLedger): Promise<void>;
}

const COLLECTION_GUIDANCE =
  'The platform is collecting these fields in this conversation: ask naturally for the ones still missing, in any order and without counters. It validates values, asks for consent, shows the review and confirms. Never mention a form, never ask for or repeat private values, and never claim anything was sent.';

/**
 * Read-only transport adapter over the same authorized runtime. A `collect` opener is the one
 * exception: it runs as a read, then opens the participant's collection and tells the model which
 * fields are needed; its confirmed action is never callable here and executes only through the
 * confirmed proposal path.
 */
export async function dispatchMessagingReadTool(input: {
  readonly artifact: RuntimeArtifact;
  readonly tool: RuntimeArtifact['tools'][number];
  readonly arguments: unknown;
  readonly executeDeps: ExecuteDeps;
  readonly context: InvocationContext;
  readonly session: MessagingTurnContext;
  readonly claimTool: (name: string) => Promise<boolean>;
  readonly collection?: MessagingCollectionPort;
}): Promise<AssistantToolDispatch> {
  const denied = (code: string): AssistantToolDispatch => ({
    kind: 'event',
    event: 'error',
    data: { code, retryable: false },
  });
  const collection =
    input.artifact.toolInteractions?.[input.tool.name] === undefined ? undefined : input.collection;
  if (
    input.tool.annotations?.readOnlyHint !== true ||
    requiresToolConfirmation(input.tool.annotations) ||
    (input.tool._meta?.ui && collection === undefined)
  )
    return denied('messaging_action_unsupported');
  if (!evaluateToolAuthorization(input.tool.authorization, input.session.caller).allow)
    return denied('tool_forbidden');
  if (assistantModelToolOncePerSession(input.tool) && !(await input.claimTool(input.tool.name)))
    return denied('invalid_model_tool_call');
  const spec =
    collection === undefined
      ? undefined
      : collectionSpecFor(input.artifact, input.tool.name, collection.confirmationExpiryMs);
  if (collection !== undefined && spec === undefined) return denied('messaging_action_unsupported');
  if (collection?.open !== undefined && spec !== undefined)
    return collectionResult(spec, collection.open, collection.now, 'already_open');
  const result = await executeToolInteractive(input.artifact, input.tool.name, input.arguments, {
    ...withAssistantTurnExecutionAuthority(input.executeDeps, input.artifact, input.session),
    caller: input.session.caller,
    context: input.context,
  });
  if (result.status !== 'completed')
    return denied(result.status === 'failed' ? result.error.code : 'messaging_action_unsupported');
  if (collection !== undefined && spec !== undefined) {
    const ledger = seedCollection(
      input.artifact,
      spec,
      openCollection(spec, {
        id: randomUUID(),
        bindingId: input.session.bindingId,
        participantId: input.session.participantId,
        now: collection.now,
        retentionMs: collection.retentionMs,
      }),
      result.output,
      collection.now,
    );
    await collection.save(ledger);
    return collectionResult(spec, ledger, collection.now, 'opened');
  }
  return {
    kind: 'tool_result',
    output: assistantSafeOutput(input.tool.outputSchema, result.output),
  };
}

/** The model sees the ledger view, never the opener's own output, which may carry website copy. */
function collectionResult(
  spec: CollectionSpec,
  ledger: CollectionLedger,
  now: number,
  collection: 'opened' | 'already_open',
): AssistantToolDispatch {
  return {
    kind: 'tool_result',
    output: { collection, ...ledgerForModel(spec, ledger, now), guidance: COLLECTION_GUIDANCE },
  };
}
