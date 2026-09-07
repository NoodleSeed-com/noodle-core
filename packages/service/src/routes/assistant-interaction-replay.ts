import type { ServerResponse } from 'node:http';
import type {
  AssistantInteractionRecord,
  AssistantSessionRecord,
} from '@noodle-borg/assistant-gateway/portable';
import {
  assistantInteractionTool,
  assistantViewAvailableData,
  auditAssistantInteraction,
  recoverableAssistantView,
} from '@noodle-borg/assistant-gateway/portable';
import { sendJson } from '@noodle-borg/transport-http';
import { type AssistantRouteDeps, now } from './assistant.js';
import type { InteractionAction } from './assistant-interaction-request.js';
import { assistantInteractionScope } from './assistant-interaction-resolution.js';
import {
  endInteractionSse,
  writeInputRequested,
  writeInteractionError,
  writeInteractionResolved,
  writeInteractionSseHeaders,
  writeToolCompleted,
  writeToolProposed,
  writeViewAvailable,
} from './assistant-interaction-stream.js';

const MAX_REPLAY_CHAIN_HOPS = 32;

type ReplayTarget =
  | { readonly disposition: 'found'; readonly interaction: AssistantInteractionRecord }
  | { readonly disposition: 'unavailable' };

/** Replay a durable outcome for the same decision, or reject a conflicting second decision. */
import { sessionScopedTarget } from './assistant-session-target.js';

export async function replayOrConflict(
  res: ServerResponse,
  deps: AssistantRouteDeps,
  session: AssistantSessionRecord,
  interaction: AssistantInteractionRecord,
  action: InteractionAction,
): Promise<void> {
  if (interaction.status === 'executing') {
    return writeUnknownOutcome(res, deps, session, interaction, action);
  }
  const storedAction =
    interaction.status === 'declined'
      ? 'decline'
      : interaction.status === 'cancelled'
        ? 'cancel'
        : interaction.status === 'succeeded' || interaction.status === 'failed'
          ? 'accept'
          : undefined;
  if (!storedAction || storedAction !== action) {
    await auditAssistantInteraction({
      audit: deps.audit,
      session,
      interaction,
      eventType: 'assistant.interaction.resolved',
      decision: 'deny',
      httpStatus: 409,
      action,
      status: 'decision_conflict',
      reasonCode: 'interaction_decision_conflict',
    });
    return sendJson(res, 409, { error: 'interaction was already resolved differently' });
  }

  const target = await resolveReplayTarget(deps, session, interaction);
  if (target.disposition === 'found' && target.interaction.status === 'executing') {
    return writeUnknownOutcome(res, deps, session, target.interaction, action);
  }
  await auditAssistantInteraction({
    audit: deps.audit,
    session,
    interaction,
    eventType: 'assistant.interaction.execution',
    decision: 'allow',
    httpStatus: 200,
    action,
    status: 'replayed',
  });
  writeInteractionSseHeaders(res, session.origin);
  writeInteractionResolved(res, interaction.id, action);
  if (target.disposition === 'unavailable') {
    writeInteractionError(res, 'next_interaction_unavailable', false);
    return endInteractionSse(res);
  }

  const current = target.interaction;
  if (current.status === 'pending') {
    if (current.kind === 'input') writeInputRequested(res, current);
    else writeToolProposed(res, current);
  } else if (current.status === 'succeeded') {
    const tool = assistantInteractionTool(current) ?? 'unknown_tool';
    const result = current.publicOutcome.result ?? current.publicOutcome;
    writeToolCompleted(res, current.id, tool, result, true);
    const deployment = await sessionScopedTarget(deps.registry, session);
    const view = deployment
      ? assistantViewAvailableData(
          deployment.served.artifact,
          {
            id: current.id,
            tool,
            result,
            replayed: true,
          },
          (failure) => deps.logger?.warn('assistant.view.unresolved', { ...failure }),
        )
      : undefined;
    if (view) {
      await deps.store.replaceLatestView(session.id, recoverableAssistantView(view));
      writeViewAvailable(res, view);
    }
  } else if (current.status === 'failed') {
    writeInteractionError(res, current.publicOutcome.code, false);
  } else if (
    current.id !== interaction.id &&
    (current.status === 'declined' || current.status === 'cancelled')
  ) {
    writeInteractionResolved(res, current.id, current.status === 'declined' ? 'decline' : 'cancel');
  }
  return endInteractionSse(res);
}

/** Follow immutable handoff links so a retry reflects the live leaf, never a stale form. */
async function resolveReplayTarget(
  deps: AssistantRouteDeps,
  session: AssistantSessionRecord,
  interaction: AssistantInteractionRecord,
): Promise<ReplayTarget> {
  let current = interaction;
  const visited = new Set([current.id]);
  let hops = 0;

  while (
    current.status === 'succeeded' &&
    (current.publicOutcome.code === 'input_requested' ||
      current.publicOutcome.code === 'confirmation_required')
  ) {
    if (hops >= MAX_REPLAY_CHAIN_HOPS) return { disposition: 'unavailable' };
    const nextId = current.publicOutcome.details?.nextInteractionId;
    if (typeof nextId !== 'string' || visited.has(nextId)) {
      return { disposition: 'unavailable' };
    }
    visited.add(nextId);
    const next = await deps.store.getInteraction(
      assistantInteractionScope(nextId, session, now(deps)),
    );
    if (!next) return { disposition: 'unavailable' };
    current = next;
    hops += 1;
  }

  return { disposition: 'found', interaction: current };
}

export async function writeUnknownOutcome(
  res: ServerResponse,
  deps: AssistantRouteDeps,
  session: AssistantSessionRecord,
  interaction: AssistantInteractionRecord,
  action: InteractionAction,
): Promise<void> {
  await auditAssistantInteraction({
    audit: deps.audit,
    session,
    interaction,
    eventType: 'assistant.interaction.execution',
    decision: 'deny',
    httpStatus: 409,
    action,
    status: 'unknown',
    reasonCode: 'interaction_outcome_unknown',
  });
  return sendJson(res, 409, {
    error: 'interaction execution is already in progress; its outcome is not yet known',
    code: 'interaction_outcome_unknown',
  });
}
