import type {
  AssistantInteractionPublicOutcome,
  AssistantInteractionRecord,
  AssistantInteractionTransitionNext,
  AssistantInteractionTransitionResult,
  AssistantSessionRecord,
} from '@noodle-borg/assistant-gateway/portable';
import {
  resolveInvocationContextSnapshot,
  withAssistantSessionExecutionAuthority,
} from '@noodle-borg/assistant-gateway/portable';
import type { ExecuteDeps, InvocationContext } from '@noodle-borg/runtime';
import { type AssistantRouteDeps, now } from './assistant.js';

type AssistantTarget = NonNullable<Awaited<ReturnType<AssistantRouteDeps['registry']['get']>>>;

export function assistantInteractionScope(
  id: string,
  session: AssistantSessionRecord,
  instant: Date,
) {
  return {
    id,
    sessionId: session.id,
    deploymentId: session.deploymentId,
    now: instant,
  };
}

export async function resolveAssistantInteractionContext(
  interaction: AssistantInteractionRecord,
  session: AssistantSessionRecord,
  target: AssistantTarget,
  deps: AssistantRouteDeps,
): Promise<InvocationContext> {
  return (
    interaction.context ??
    (await resolveInvocationContextSnapshot({
      artifact: target.served.artifact,
      executeDeps: withAssistantSessionExecutionAuthority(
        target.served.deps as ExecuteDeps,
        target.served.artifact,
        session,
      ),
      caller: session.caller,
      instant: now(deps),
      ...(session.preferences ? { applicationPreference: session.preferences } : {}),
    }))
  );
}

export async function completeAssistantInteractionExecution(
  deps: AssistantRouteDeps,
  session: AssistantSessionRecord,
  interaction: AssistantInteractionRecord,
  status: 'succeeded' | 'failed',
  code: string,
  tool: string,
  outcome?: {
    readonly result?: AssistantInteractionPublicOutcome['result'];
  },
): Promise<AssistantInteractionRecord | undefined> {
  const completion = await deps.store.completeInteraction({
    ...assistantInteractionScope(interaction.id, session, now(deps)),
    completion: {
      status,
      publicOutcome: {
        code,
        summary:
          status === 'succeeded' ? 'Tool interaction completed.' : 'Tool interaction failed.',
        details: { tool },
        ...(outcome?.result !== undefined ? { result: outcome.result } : {}),
      },
    },
  });
  return completion.disposition === 'completed' ? completion.interaction : undefined;
}

export async function transitionAssistantInteractionExecution(
  deps: AssistantRouteDeps,
  session: AssistantSessionRecord,
  interaction: AssistantInteractionRecord,
  code: 'confirmation_required' | 'input_requested',
  tool: string,
  next: AssistantInteractionTransitionNext,
  instant: Date,
): Promise<AssistantInteractionTransitionResult> {
  return deps.store.transitionInteraction({
    ...assistantInteractionScope(interaction.id, session, instant),
    publicOutcome: {
      code,
      summary: 'Tool interaction completed.',
      details: { tool },
    },
    next,
  });
}
