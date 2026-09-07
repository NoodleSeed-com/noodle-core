import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  AssistantInteractionCapacityError,
  type AssistantInteractionRecord,
  type AssistantInteractionTransitionResult,
  type AssistantSessionRecord,
  assistantConfirmationReview,
  assistantConfirmationTransition,
  assistantInputTransition,
  assistantInteractionTool,
  assistantPreparedArgumentReview,
  assistantPreparedToolContinuation,
  assistantSafeOutput,
  assistantToolContinuation,
  assistantViewAvailableData,
  auditAssistantInteraction,
  boundedAssistantExecution,
  recoverableAssistantView,
  withAssistantSessionExecutionAuthority,
} from '@noodle-borg/assistant-gateway/portable';
import {
  type ConfirmationPreparationResult,
  type ExecuteDeps,
  executePreparedTool,
  executeToolInteractive,
  type InteractiveExecutionResult,
  type InvocationContext,
  resumeTool,
  resumeToolPreparation,
  type ToolContinuation,
  type ToolPreparationContinuation,
} from '@noodle-borg/runtime';
import { readJsonBody, sendJson } from '@noodle-borg/transport-http';
import {
  type AssistantRouteDeps,
  applyBrowserCors,
  authenticateSession,
  now,
} from './assistant.js';
import { replayOrConflict, writeUnknownOutcome } from './assistant-interaction-replay.js';
import { parseInteractionResponse, validateInputContent } from './assistant-interaction-request.js';
import {
  assistantInteractionScope,
  completeAssistantInteractionExecution,
  resolveAssistantInteractionContext,
  transitionAssistantInteractionExecution,
} from './assistant-interaction-resolution.js';
import {
  endInteractionSse,
  narrateResolvedInteraction,
  writeInputRequested,
  writeInteractionError,
  writeInteractionResolved,
  writeInteractionSseHeaders,
  writeToolCompleted,
  writeToolProposed,
  writeViewAvailable,
} from './assistant-interaction-stream.js';

type AssistantResolutionResult = InteractiveExecutionResult | ConfirmationPreparationResult;

class ConfirmationTransitionError extends Error {
  readonly code: 'arguments_not_presentable';

  constructor(code: 'arguments_not_presentable') {
    super(code);
    this.name = 'ConfirmationTransitionError';
    this.code = code;
  }
}

/** Accept-only compatibility route consumed by published pre-interaction assistant widgets. */
import { sessionScopedTarget } from './assistant-session-target.js';

export async function handleAssistantConfirmation(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AssistantRouteDeps,
): Promise<void> {
  return handleResolution(req, res, deps, true);
}

/** Resolve one durable server-held confirmation or structured-input interaction. */
export async function handleAssistantInteraction(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AssistantRouteDeps,
): Promise<void> {
  return handleResolution(req, res, deps, false);
}

async function handleResolution(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AssistantRouteDeps,
  legacyAcceptOnly: boolean,
): Promise<void> {
  const session = await authenticateSession(req, res, deps);
  if (!session) return;
  applyBrowserCors(req, res, session.origin);
  const body = await readJsonBody(req, deps.maxBody);
  if (!body.ok) return sendJson(res, body.status, { error: body.error });
  const response = parseInteractionResponse(body.value, legacyAcceptOnly);
  if (!response.ok) return sendJson(res, 400, { error: response.error });
  const suggestions = response.value.suggestions === true;
  if (suggestions) {
    try {
      await deps.store.replaceLatestSuggestions(session.id, undefined);
    } catch {
      // Suggestions are optional; interaction resolution remains authoritative.
    }
  }

  const scope = assistantInteractionScope(response.value.id, session, now(deps));
  const interaction = await deps.store.getInteraction(scope);
  if (!interaction) {
    return sendJson(res, 409, { error: 'interaction is invalid or expired' });
  }
  if (response.value.action !== 'accept') {
    return resolveStop(req, res, deps, session, interaction, response.value.action, suggestions);
  }
  if (interaction.kind === 'confirmation' && response.value.content !== undefined) {
    return sendJson(res, 400, { error: 'confirmation content cannot replace reviewed arguments' });
  }

  let acceptedContent = response.value.content;
  if (interaction.kind === 'input' && interaction.status === 'pending') {
    const validated = validateInputContent(interaction, acceptedContent);
    if (!validated.ok) {
      await auditAssistantInteraction({
        audit: deps.audit,
        session,
        interaction,
        eventType: 'assistant.interaction.execution',
        decision: 'deny',
        httpStatus: 400,
        action: 'accept',
        status: 'input_invalid',
        reasonCode: 'arg_invalid',
      });
      return sendJson(res, 400, {
        error: 'interaction input does not match the requested schema',
        code: 'arg_invalid',
      });
    }
    acceptedContent = validated.value;
  }

  return resolveAccept(req, res, deps, session, interaction, acceptedContent, suggestions);
}

async function resolveAccept(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AssistantRouteDeps,
  session: AssistantSessionRecord,
  interaction: AssistantInteractionRecord,
  content: unknown,
  suggestions: boolean,
): Promise<void> {
  if (interaction.status !== 'pending') {
    return replayOrConflict(res, deps, session, interaction, 'accept');
  }
  const target = await sessionScopedTarget(deps.registry, session, deps.resolveRuntimeTarget, req);
  if (!target) {
    await auditAssistantInteraction({
      audit: deps.audit,
      session,
      interaction,
      eventType: 'assistant.interaction.execution',
      decision: 'deny',
      httpStatus: 409,
      action: 'accept',
      status: 'deployment_unavailable',
      reasonCode: 'deployment_unavailable',
    });
    return sendJson(res, 409, { error: 'assistant deployment is unavailable' });
  }
  const context = await resolveAssistantInteractionContext(interaction, session, target, deps);
  const claimed = await deps.store.claimInteraction(
    assistantInteractionScope(interaction.id, session, now(deps)),
  );
  if (claimed.disposition === 'unavailable') {
    await auditAssistantInteraction({
      audit: deps.audit,
      session,
      interaction,
      eventType: 'assistant.interaction.execution',
      decision: 'deny',
      httpStatus: 409,
      action: 'accept',
      status: 'unavailable',
      reasonCode: 'interaction_unavailable',
    });
    return sendJson(res, 409, { error: 'interaction is invalid or expired' });
  }
  if (claimed.disposition === 'replay') {
    return replayOrConflict(res, deps, session, claimed.interaction, 'accept');
  }

  await auditAssistantInteraction({
    audit: deps.audit,
    session,
    interaction: claimed.interaction,
    eventType: 'assistant.interaction.resolved',
    decision: 'allow',
    httpStatus: 200,
    action: 'accept',
    status: 'accepted',
  });
  const result = await boundedAssistantExecution<AssistantResolutionResult>(
    async (signal) => {
      const executeDeps = {
        ...withAssistantSessionExecutionAuthority(
          target.served.deps as ExecuteDeps,
          target.served.artifact,
          session,
        ),
        caller: session.caller,
        context,
        invocationId: claimed.interaction.id,
        signal,
      };
      let result: AssistantResolutionResult;
      if (claimed.interaction.kind === 'confirmation') {
        const prepared = assistantPreparedToolContinuation(claimed.interaction);
        const tool = target.served.artifact.tools.find(
          (candidate) => candidate.name === claimed.interaction.tool,
        );
        if (
          !prepared &&
          tool?.fulfilment.kind === 'flow' &&
          tool.fulfilment.steps.some((step) => step.kind === 'elicit')
        ) {
          result = {
            status: 'failed',
            error: {
              code: 'invalid_continuation',
              message: 'legacy confirmation did not capture elicited input',
            },
          };
        } else {
          result = prepared
            ? await executePreparedTool(target.served.artifact, prepared, executeDeps)
            : await executeToolInteractive(
                target.served.artifact,
                claimed.interaction.tool,
                claimed.interaction.arguments,
                executeDeps,
              );
        }
      } else {
        const continuation = assistantToolContinuation(claimed.interaction);
        result = isToolPreparationContinuation(continuation)
          ? await resumeToolPreparation(
              target.served.artifact,
              continuation,
              { action: 'accept', content },
              executeDeps,
            )
          : await resumeTool(
              target.served.artifact,
              continuation,
              { action: 'accept', content },
              executeDeps,
            );
      }

      return result;
    },
    () => ({
      status: 'failed',
      error: {
        code: 'connector_error',
        reason: 'operation_outcome_unknown',
        message: 'Execution stopped. Verify the original outcome before requesting another write.',
      },
    }),
  );

  return finishExecution(
    res,
    deps,
    session,
    claimed.interaction,
    context,
    result,
    target,
    suggestions,
  );
}

async function finishExecution(
  res: ServerResponse,
  deps: AssistantRouteDeps,
  session: AssistantSessionRecord,
  interaction: AssistantInteractionRecord,
  context: InvocationContext,
  result: AssistantResolutionResult,
  target: NonNullable<Awaited<ReturnType<AssistantRouteDeps['registry']['get']>>>,
  suggestions: boolean,
): Promise<void> {
  const toolName = assistantInteractionTool(interaction) ?? 'unknown_tool';
  if (result.status === 'confirmation_required') {
    const tool = target.served.artifact.tools.find((candidate) => candidate.name === toolName);
    const review = tool
      ? assistantPreparedArgumentReview(tool.inputSchema, result.review)
      : ({ ok: false, code: 'arguments_not_presentable' } as const);
    let transition: AssistantInteractionTransitionResult;
    try {
      if (!review.ok) throw new ConfirmationTransitionError(review.code);
      const transitionAt = now(deps);
      const next = assistantConfirmationTransition({
        context,
        tool: toolName,
        arguments: result.review.input,
        review: assistantConfirmationReview({
          ...(tool?.title ? { title: tool.title } : {}),
          description: tool?.description ?? toolName,
          review,
        }),
        continuation: result.continuation,
        now: transitionAt,
      });
      transition = await transitionAssistantInteractionExecution(
        deps,
        session,
        interaction,
        'confirmation_required',
        toolName,
        next,
        transitionAt,
      );
    } catch (error) {
      const code =
        error instanceof AssistantInteractionCapacityError ||
        error instanceof ConfirmationTransitionError
          ? error.code
          : 'confirmation_interaction_failed';
      const failed = await completeAssistantInteractionExecution(
        deps,
        session,
        interaction,
        'failed',
        code,
        toolName,
      );
      if (!failed) return writeUnknownOutcome(res, deps, session, interaction, 'accept');
      await auditAssistantInteraction({
        audit: deps.audit,
        session,
        interaction: failed,
        eventType: 'assistant.interaction.execution',
        decision: 'deny',
        httpStatus: 200,
        action: 'accept',
        status: 'failed',
        reasonCode: code,
      });
      writeInteractionSseHeaders(res, session.origin);
      writeInteractionResolved(res, interaction.id, 'accept');
      writeInteractionError(res, code, false);
      return endInteractionSse(res);
    }
    if (transition.disposition === 'replay') {
      return replayOrConflict(res, deps, session, transition.interaction, 'accept');
    }
    if (transition.disposition !== 'transitioned') {
      return writeUnknownOutcome(res, deps, session, interaction, 'accept');
    }
    if (transition.next.kind !== 'confirmation') {
      return replayOrConflict(res, deps, session, transition.interaction, 'accept');
    }
    const next = transition.next;
    await auditAssistantInteraction({
      audit: deps.audit,
      session,
      interaction: next,
      eventType: 'assistant.interaction.proposed',
      decision: 'allow',
      httpStatus: 201,
      status: 'pending',
    });
    await auditAssistantInteraction({
      audit: deps.audit,
      session,
      interaction: transition.interaction,
      eventType: 'assistant.interaction.execution',
      decision: 'allow',
      httpStatus: 200,
      action: 'accept',
      status: 'confirmation_required',
    });
    writeInteractionSseHeaders(res, session.origin);
    writeInteractionResolved(res, interaction.id, 'accept');
    writeToolProposed(res, next);
    return endInteractionSse(res);
  }
  if (result.status === 'input_required') {
    let transition: AssistantInteractionTransitionResult;
    try {
      const transitionAt = now(deps);
      const next = assistantInputTransition({
        context,
        required: result,
        now: transitionAt,
      });
      transition = await transitionAssistantInteractionExecution(
        deps,
        session,
        interaction,
        'input_requested',
        toolName,
        next,
        transitionAt,
      );
    } catch (error) {
      const code =
        error instanceof AssistantInteractionCapacityError
          ? error.code
          : 'input_interaction_failed';
      const failed = await completeAssistantInteractionExecution(
        deps,
        session,
        interaction,
        'failed',
        code,
        toolName,
      );
      if (!failed) return writeUnknownOutcome(res, deps, session, interaction, 'accept');
      await auditAssistantInteraction({
        audit: deps.audit,
        session,
        interaction: failed,
        eventType: 'assistant.interaction.execution',
        decision: 'deny',
        httpStatus: 200,
        action: 'accept',
        status: 'failed',
        reasonCode: code,
      });
      writeInteractionSseHeaders(res, session.origin);
      writeInteractionResolved(res, interaction.id, 'accept');
      writeInteractionError(res, code, false);
      return endInteractionSse(res);
    }
    if (transition.disposition === 'replay') {
      return replayOrConflict(res, deps, session, transition.interaction, 'accept');
    }
    if (transition.disposition !== 'transitioned') {
      return writeUnknownOutcome(res, deps, session, interaction, 'accept');
    }
    if (transition.next.kind !== 'input') {
      return replayOrConflict(res, deps, session, transition.interaction, 'accept');
    }
    const next = transition.next;
    await auditAssistantInteraction({
      audit: deps.audit,
      session,
      interaction: next,
      eventType: 'assistant.interaction.proposed',
      decision: 'allow',
      httpStatus: 201,
      status: 'input_requested',
    });
    await auditAssistantInteraction({
      audit: deps.audit,
      session,
      interaction: transition.interaction,
      eventType: 'assistant.interaction.execution',
      decision: 'allow',
      httpStatus: 200,
      action: 'accept',
      status: 'input_requested',
    });
    writeInteractionSseHeaders(res, session.origin);
    writeInteractionResolved(res, interaction.id, 'accept');
    writeInputRequested(res, next);
    return endInteractionSse(res);
  }

  if (result.status === 'failed' || result.status === 'stopped') {
    const code = result.status === 'failed' ? result.error.code : `interaction_${result.action}`;
    const completed = await completeAssistantInteractionExecution(
      deps,
      session,
      interaction,
      'failed',
      code,
      toolName,
    );
    if (!completed) return writeUnknownOutcome(res, deps, session, interaction, 'accept');
    await auditAssistantInteraction({
      audit: deps.audit,
      session,
      interaction: completed,
      eventType: 'assistant.interaction.execution',
      decision: 'deny',
      httpStatus: 200,
      action: 'accept',
      status: 'failed',
      reasonCode: code,
    });
    writeInteractionSseHeaders(res, session.origin);
    writeInteractionResolved(res, interaction.id, 'accept');
    writeInteractionError(res, code, false);
    return endInteractionSse(res);
  }

  const completedTool = target.served.artifact.tools.find((tool) => tool.name === toolName);
  const safeOutput = assistantSafeOutput(completedTool?.outputSchema, result.output);
  const completed = await completeAssistantInteractionExecution(
    deps,
    session,
    interaction,
    'succeeded',
    'tool_completed',
    toolName,
    { result: safeOutput },
  );
  if (!completed) return writeUnknownOutcome(res, deps, session, interaction, 'accept');
  await auditAssistantInteraction({
    audit: deps.audit,
    session,
    interaction: completed,
    eventType: 'assistant.interaction.execution',
    decision: 'allow',
    httpStatus: 200,
    action: 'accept',
    status: 'succeeded',
  });
  await deps.store.appendHistory(session.id, [
    // Model-facing scaffolding: the panel saw the tool_completed card, never this row's tool JSON.
    {
      role: 'assistant',
      content: `Completed ${toolName}: ${JSON.stringify(safeOutput)}`,
      kind: 'narration',
    },
  ]);
  writeInteractionSseHeaders(res, session.origin);
  writeInteractionResolved(res, interaction.id, 'accept');
  writeToolCompleted(res, interaction.id, toolName, safeOutput);
  const view = assistantViewAvailableData(
    target.served.artifact,
    {
      id: interaction.id,
      tool: toolName,
      result: safeOutput,
    },
    (failure) => deps.logger?.warn('assistant.view.unresolved', { ...failure }),
  );
  if (view) {
    await deps.store.replaceLatestView(session.id, recoverableAssistantView(view));
    writeViewAvailable(res, view);
  }
  await narrateResolvedInteraction(
    res,
    deps,
    target,
    session,
    toolName,
    'accept',
    safeOutput,
    context,
    suggestions,
  );
  return endInteractionSse(res);
}

async function resolveStop(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AssistantRouteDeps,
  session: AssistantSessionRecord,
  interaction: AssistantInteractionRecord,
  action: 'decline' | 'cancel',
  suggestions: boolean,
): Promise<void> {
  if (interaction.status !== 'pending') {
    return replayOrConflict(res, deps, session, interaction, action);
  }
  const target = await sessionScopedTarget(deps.registry, session, deps.resolveRuntimeTarget, req);
  const context = target
    ? await resolveAssistantInteractionContext(interaction, session, target, deps)
    : undefined;
  if (interaction.kind === 'input' && target && context) {
    // This validates the stored continuation/artifact binding; decline/cancel has no connector side effect.
    const continuation = assistantToolContinuation(interaction);
    const executeDeps = {
      ...withAssistantSessionExecutionAuthority(
        target.served.deps as ExecuteDeps,
        target.served.artifact,
        session,
      ),
      caller: session.caller,
      context,
    };
    if (isToolPreparationContinuation(continuation)) {
      await resumeToolPreparation(target.served.artifact, continuation, { action }, executeDeps);
    } else {
      await resumeTool(target.served.artifact, continuation, { action }, executeDeps);
    }
  }
  const completion = await deps.store.completeInteraction({
    ...assistantInteractionScope(interaction.id, session, now(deps)),
    completion: { status: action === 'decline' ? 'declined' : 'cancelled' },
  });
  if (completion.disposition === 'replay') {
    return replayOrConflict(res, deps, session, completion.interaction, action);
  }
  if (completion.disposition !== 'completed') {
    await auditAssistantInteraction({
      audit: deps.audit,
      session,
      interaction,
      eventType: 'assistant.interaction.resolved',
      decision: 'deny',
      httpStatus: 409,
      action,
      status: 'unknown',
      reasonCode: 'interaction_state_changed',
    });
    return sendJson(res, 409, { error: 'interaction state changed before it was resolved' });
  }
  await auditAssistantInteraction({
    audit: deps.audit,
    session,
    interaction: completion.interaction,
    eventType: 'assistant.interaction.resolved',
    decision: 'deny',
    httpStatus: 200,
    action,
    status: action === 'decline' ? 'declined' : 'cancelled',
  });
  const toolName = assistantInteractionTool(completion.interaction) ?? 'tool request';
  await deps.store.appendHistory(session.id, [
    // Model-facing scaffolding: the panel saw the interaction resolve, never this summary row.
    {
      role: 'assistant',
      content: `${action === 'decline' ? 'Declined' : 'Cancelled'} ${toolName}; it was not executed.`,
      kind: 'narration',
    },
  ]);
  writeInteractionSseHeaders(res, session.origin);
  writeInteractionResolved(res, interaction.id, action);
  if (target && context) {
    await narrateResolvedInteraction(
      res,
      deps,
      target,
      session,
      toolName,
      action,
      undefined,
      context,
      suggestions,
    );
  }
  return endInteractionSse(res);
}

function isToolPreparationContinuation(
  continuation: ToolContinuation | ToolPreparationContinuation,
): continuation is ToolPreparationContinuation {
  return (continuation as { readonly kind?: unknown }).kind === 'confirmation_preparation';
}
