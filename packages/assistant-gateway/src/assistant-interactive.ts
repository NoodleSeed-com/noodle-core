import { ADMISSION_DEFAULTS } from '@noodle-borg/admission-limits/portable';
import { type RuntimeArtifact, requiresToolConfirmation } from '@noodle-borg/compiler';
import type { AuditSink } from '@noodle-borg/module';
import { evaluateToolAuthorization } from '@noodle-borg/protocol';
import type {
  CallerIdentity,
  ConfirmationPreparationResult,
  ExecuteDeps,
  InteractiveExecutionResult,
  InvocationContext,
  PreparedToolContinuation,
  ToolContinuation,
  ToolPreparationContinuation,
} from '@noodle-borg/runtime';
import { executeToolInteractive, prepareToolForConfirmation } from '@noodle-borg/runtime';
import { withAssistantSessionExecutionAuthority } from './assistant-customer-routing.js';
import { assistantModelToolOncePerSession } from './assistant-guide.js';
import {
  AssistantInteractionCapacityError,
  type AssistantInteractionRecord,
  type AssistantInteractionTransitionNext,
  type AssistantPendingConfirmationInteractionRecord,
  type AssistantPendingInputInteractionRecord,
} from './assistant-interaction-state.js';
import {
  assistantConfirmationProposal,
  assistantConfirmationReview,
  assistantPreparedArgumentReview,
  assistantSafeOutput,
} from './assistant-presentation.js';
import type { AssistantSessionRecord, AssistantStore } from './assistant-store.js';

/**
 * Single-use confirmation lifetime, owned by the admission envelope rather than restated here. The
 * value is unchanged; what changes is that lowering `confirmationTtlMs` now does something, where
 * before the envelope documented a bound this constant silently outranked.
 */
export const ASSISTANT_INTERACTION_TTL_MS = ADMISSION_DEFAULTS.confirmationTtlMs;

type InputRequired =
  | Extract<InteractiveExecutionResult, { readonly status: 'input_required' }>
  | Extract<ConfirmationPreparationResult, { readonly status: 'input_required' }>;

export type AssistantToolDispatch =
  | {
      readonly kind: 'event';
      readonly event: 'tool_proposed' | 'input_requested' | 'error';
      readonly data: Readonly<Record<string, unknown>>;
    }
  | { readonly kind: 'tool_result'; readonly output: unknown };

/** Apply the same confirmation and suspend/resume policy to one model-proposed tool call. */
export async function dispatchAssistantTool(input: {
  readonly artifact: RuntimeArtifact;
  readonly tool: RuntimeArtifact['tools'][number];
  readonly arguments: unknown;
  readonly executeDeps: ExecuteDeps;
  readonly caller: CallerIdentity;
  readonly context: InvocationContext;
  readonly session: AssistantSessionRecord;
  readonly store: AssistantStore;
  readonly audit: AuditSink;
  readonly now: () => Date;
  readonly onToolStarted?: () => void;
}): Promise<AssistantToolDispatch> {
  if (!evaluateToolAuthorization(input.tool.authorization, input.caller).allow) {
    return {
      kind: 'event',
      event: 'error',
      data: { code: 'tool_forbidden', retryable: false },
    };
  }
  const oncePerSession = assistantModelToolOncePerSession(input.tool);
  if (oncePerSession && !(await input.store.claimModelToolUse(input.session.id, input.tool.name))) {
    return {
      kind: 'event',
      event: 'error',
      data: { code: 'invalid_model_tool_call', retryable: false },
    };
  }
  try {
    const dispatch = await dispatchClaimedAssistantTool(input);
    if (oncePerSession && dispatch.kind === 'event' && dispatch.event === 'error') {
      await input.store.releaseModelToolUse(input.session.id, input.tool.name);
    }
    return dispatch;
  } catch (error) {
    if (oncePerSession) await input.store.releaseModelToolUse(input.session.id, input.tool.name);
    throw error;
  }
}

async function dispatchClaimedAssistantTool(
  input: Parameters<typeof dispatchAssistantTool>[0],
): Promise<AssistantToolDispatch> {
  const executeDeps = {
    ...withAssistantSessionExecutionAuthority(input.executeDeps, input.artifact, input.session),
    caller: input.caller,
    context: input.context,
  };
  if (requiresToolConfirmation(input.tool.annotations)) {
    const prepared = await prepareToolForConfirmation(
      input.artifact,
      input.tool.name,
      input.arguments,
      executeDeps,
    );
    try {
      if (prepared.status === 'input_required') {
        const interaction = await createAssistantInputInteraction({
          store: input.store,
          audit: input.audit,
          session: input.session,
          context: input.context,
          required: prepared,
          now: input.now(),
        });
        return { kind: 'event', event: 'input_requested', data: inputRequestData(interaction) };
      }
      if (prepared.status === 'confirmation_required') {
        const review = assistantPreparedArgumentReview(input.tool.inputSchema, prepared.review);
        if (!review.ok) {
          return {
            kind: 'event',
            event: 'error',
            data: { code: review.code, retryable: false },
          };
        }
        const interaction = await createAssistantConfirmationInteraction({
          store: input.store,
          audit: input.audit,
          session: input.session,
          context: input.context,
          tool: input.tool.name,
          arguments: input.arguments,
          review: assistantConfirmationReview({
            ...(input.tool.title ? { title: input.tool.title } : {}),
            description: input.tool.description,
            review,
          }),
          continuation: prepared.continuation,
          now: input.now(),
        });
        return {
          kind: 'event',
          event: 'tool_proposed',
          data: assistantConfirmationProposalData(interaction),
        };
      }
      return {
        kind: 'event',
        event: 'error',
        data: {
          code:
            prepared.status === 'failed' ? prepared.error.code : `interaction_${prepared.action}`,
          retryable: false,
        },
      };
    } catch (error) {
      if (error instanceof AssistantInteractionCapacityError) {
        return {
          kind: 'event',
          event: 'error',
          data: { code: error.code, retryable: false },
        };
      }
      throw error;
    }
  }

  input.onToolStarted?.();
  const result = await executeToolInteractive(
    input.artifact,
    input.tool.name,
    input.arguments,
    executeDeps,
  );
  if (result.status === 'input_required') {
    try {
      const interaction = await createAssistantInputInteraction({
        store: input.store,
        audit: input.audit,
        session: input.session,
        context: input.context,
        required: result,
        now: input.now(),
      });
      return { kind: 'event', event: 'input_requested', data: inputRequestData(interaction) };
    } catch (error) {
      if (error instanceof AssistantInteractionCapacityError) {
        return {
          kind: 'event',
          event: 'error',
          data: { code: error.code, retryable: false },
        };
      }
      throw error;
    }
  }
  return {
    kind: 'tool_result',
    output:
      result.status === 'completed'
        ? assistantSafeOutput(input.tool.outputSchema, result.output)
        : result.status === 'failed'
          ? { error: result.error.code }
          : { error: `interaction_${result.action}` },
  };
}

/** Persist a complete, reviewable proposal and its server-only prepared execution state. */
export async function createAssistantConfirmationInteraction(input: {
  readonly store: AssistantStore;
  readonly audit: AuditSink;
  readonly session: AssistantSessionRecord;
  readonly context: InvocationContext;
  readonly tool: string;
  readonly arguments: unknown;
  readonly review: unknown;
  readonly continuation: PreparedToolContinuation;
  readonly now: Date;
}): Promise<AssistantPendingConfirmationInteractionRecord> {
  const next = assistantConfirmationTransition(input);
  const interaction = await input.store.createInteraction({
    ...next,
    sessionId: input.session.id,
    deploymentId: input.session.deploymentId,
    createdAt: input.now.toISOString(),
  });
  await auditAssistantInteraction({
    audit: input.audit,
    session: input.session,
    interaction,
    eventType: 'assistant.interaction.proposed',
    decision: 'allow',
    httpStatus: 201,
    status: 'pending',
  });
  return interaction;
}

export function assistantConfirmationTransition(input: {
  readonly context: InvocationContext;
  readonly tool: string;
  readonly arguments: unknown;
  readonly review: unknown;
  readonly continuation: PreparedToolContinuation;
  readonly now: Date;
}): Extract<AssistantInteractionTransitionNext, { readonly kind: 'confirmation' }> {
  return {
    kind: 'confirmation',
    tool: input.tool,
    arguments: input.arguments,
    review: input.review,
    continuation: input.continuation,
    context: input.context,
    expiresAt: new Date(input.now.getTime() + ASSISTANT_INTERACTION_TTL_MS).toISOString(),
  };
}

export function assistantConfirmationProposalData(
  interaction: AssistantPendingConfirmationInteractionRecord,
): Readonly<Record<string, unknown>> {
  return {
    id: interaction.id,
    tool: interaction.tool,
    ...assistantConfirmationProposal(interaction.review),
    expiresAt: interaction.expiresAt,
    requiresConfirmation: true,
  };
}

function inputRequestData(
  interaction: AssistantPendingInputInteractionRecord,
): Readonly<Record<string, unknown>> {
  return {
    id: interaction.id,
    message: interaction.message,
    requestedSchema: interaction.requestedSchema,
    expiresAt: interaction.expiresAt,
  };
}

/** Persist an opaque input interaction and audit only scalar metadata about the suspension. */
export async function createAssistantInputInteraction(input: {
  readonly store: AssistantStore;
  readonly audit: AuditSink;
  readonly session: AssistantSessionRecord;
  readonly context: InvocationContext;
  readonly required: InputRequired;
  readonly now: Date;
}): Promise<AssistantPendingInputInteractionRecord> {
  const next = assistantInputTransition(input);
  const interaction = await input.store.createInteraction({
    ...next,
    sessionId: input.session.id,
    deploymentId: input.session.deploymentId,
    createdAt: input.now.toISOString(),
  });
  await auditAssistantInteraction({
    audit: input.audit,
    session: input.session,
    interaction,
    eventType: 'assistant.interaction.proposed',
    decision: 'allow',
    httpStatus: 201,
    status: 'input_requested',
  });
  return interaction;
}

export function assistantInputTransition(input: {
  readonly context: InvocationContext;
  readonly required: InputRequired;
  readonly now: Date;
}): Extract<AssistantInteractionTransitionNext, { readonly kind: 'input' }> {
  return {
    kind: 'input',
    tool: input.required.continuation.toolName,
    message: input.required.request.message,
    requestedSchema: input.required.request.requestedSchema,
    continuation: input.required.continuation,
    context: input.context,
    expiresAt: new Date(input.now.getTime() + ASSISTANT_INTERACTION_TTL_MS).toISOString(),
  };
}

/** Emit one tenant-scoped, scalar-only interaction audit record. */
export async function auditAssistantInteraction(input: {
  readonly audit: AuditSink;
  readonly session: AssistantSessionRecord;
  readonly interaction: AssistantInteractionRecord;
  readonly eventType:
    | 'assistant.interaction.proposed'
    | 'assistant.interaction.resolved'
    | 'assistant.interaction.execution';
  readonly decision: 'allow' | 'deny';
  readonly httpStatus: number;
  readonly status: string;
  readonly action?: 'accept' | 'decline' | 'cancel';
  readonly reasonCode?: string;
}): Promise<void> {
  const tool = assistantInteractionTool(input.interaction);
  await input.audit.emit({
    eventType: input.eventType,
    org: input.session.tenant.org,
    app: input.session.tenant.app,
    env: input.session.tenant.env,
    deploymentId: input.interaction.deploymentId,
    actorSubject: input.session.caller.subject,
    ...(input.session.caller.email ? { actorEmail: input.session.caller.email } : {}),
    decision: input.decision,
    status: input.httpStatus,
    ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
    details: {
      interactionId: input.interaction.id,
      kind: input.interaction.kind,
      ...(tool ? { tool } : {}),
      ...(input.action ? { action: input.action } : {}),
      status: input.status,
    },
  });
}

export function assistantInteractionTool(
  interaction: AssistantInteractionRecord,
): string | undefined {
  return interaction.tool;
}

/** The store is the only trust boundary allowed to deserialize this runtime continuation. */
export function assistantToolContinuation(
  interaction: Extract<AssistantInteractionRecord, { readonly kind: 'input' }>,
): ToolContinuation | ToolPreparationContinuation {
  return interaction.continuation as ToolContinuation | ToolPreparationContinuation;
}

export function assistantPreparedToolContinuation(
  interaction: Extract<AssistantInteractionRecord, { readonly kind: 'confirmation' }>,
): PreparedToolContinuation | undefined {
  const continuation = interaction.continuation as PreparedToolContinuation | undefined;
  return continuation?.kind === 'prepared_confirmation' ? continuation : undefined;
}
