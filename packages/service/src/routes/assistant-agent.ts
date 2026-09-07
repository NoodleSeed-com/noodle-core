import { ADMISSION_DEFAULTS } from '@noodle-borg/admission-limits/portable';
import {
  type AssistantModelMessage,
  type AssistantModelRequestPolicy,
  assistantCoreModelMessages,
  assistantTurnModelContextMessages,
  type ModelCompletion,
  type ModelToolCall,
  type ResolvedAssistantModel,
  requestAssistantSuggestedPrompts,
  requestModelCompletion,
  resolveAssistantContextProviderModelResult,
} from '@noodle-borg/assistant-gateway/model-runtime';
import {
  type AssistantSessionRecord,
  assistantGuideModelContext,
  assistantModelToolOncePerSession,
  assistantModelToolRequiredWhenVisible,
  assistantOmittedToolResult,
  assistantViewAvailableData,
  dispatchAssistantTool,
  projectAssistantGuide,
  publicSurfaceOf,
  recoverableAssistantView,
  remainingTurnTokens,
  selectAssistantModelTools,
  toolTouchesDelegatedAuth,
  withAssistantSessionExecutionAuthority,
} from '@noodle-borg/assistant-gateway/portable';
import { type ArtifactTool, validateJsonSchemaWithDefaults } from '@noodle-borg/compiler';
import { guardedFetch } from '@noodle-borg/connector-http';
import { evaluateToolAuthorization } from '@noodle-borg/protocol';
import type { ExecuteDeps, InvocationContext } from '@noodle-borg/runtime';
import type { ServedTarget } from '@noodle-borg/transport-http';
import type {
  AssistantModelContextUpdate,
  AssistantPageContext,
} from '@noodle-borg/wire-contracts';
import type { AssistantRouteDeps } from './assistant.js';
import { interceptForElevation, offersSignIn } from './assistant-elevation.js';
import {
  assistantKnowledgeModelTools,
  executeAssistantKnowledgeSearch,
  findAssistantKnowledgeComponent,
  KNOWLEDGE_CITATION_GUIDANCE,
  resolveAssistantKnowledge,
} from './assistant-knowledge.js';
import { resolveAssistantModelBinding } from './assistant-model-binding.js';

const MAX_MODEL_RESPONSE = 1 << 20;
/**
 * The agent-loop bounds come from the admission envelope so an operator lowering them changes
 * behaviour. They used to be a constant here that happened to equal the envelope's default, which
 * meant the envelope documented a limit it did not control.
 */
function agentBounds(deps: AssistantRouteDeps, policy?: AssistantModelRequestPolicy) {
  const { modelStepsPerTurn, toolCallsPerTurn } = deps.admissionEnvelope ?? ADMISSION_DEFAULTS;
  // A per-tenant policy narrows a turn; it can never widen one, so the envelope wins when lower.
  return {
    steps: Math.min(modelStepsPerTurn, policy?.maxModelStepsPerTurn ?? modelStepsPerTurn),
    toolCalls: Math.min(toolCallsPerTurn, policy?.maxToolCallsPerTurn ?? toolCallsPerTurn),
  };
}

export interface AssistantEvent {
  readonly event:
    | 'content'
    | 'tool_started'
    | 'tool_proposed'
    | 'input_requested'
    | 'view_available'
    // Mid-conversation sign-in (5.6b). Additive on purpose: a published widget that predates it
    // resolves unknown events to `unrecognized` and ignores them, so an old page degrades to "the
    // tool simply does not work for me" rather than a broken conversation.
    | 'auth_requested'
    | 'suggested_prompts'
    | 'error';
  readonly data: Readonly<Record<string, unknown>>;
}

export interface AssistantTurnStats {
  modelRequests: number;
  toolCalls: number;
  interactionCount: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export function createAssistantTurnStats(): AssistantTurnStats {
  return {
    modelRequests: 0,
    toolCalls: 0,
    interactionCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };
}

/** Run one model/tool loop against the immutable invocation-context snapshot for this turn. */
export async function runAgentTurn(
  target: ServedTarget,
  session: AssistantSessionRecord,
  message: string,
  context: InvocationContext,
  deps: AssistantRouteDeps,
  emit: (event: AssistantEvent) => void,
  modelContext?: AssistantModelContextUpdate,
  pageContext?: AssistantPageContext,
  stats: AssistantTurnStats = createAssistantTurnStats(),
  suggestions = false,
): Promise<void> {
  // Every terminal failure in this loop is one shape: a code, and the turn ends. Naming it keeps the
  // dozen sites readable and stops a new one inventing a different envelope.
  const fail = (code: string) => emit({ event: 'error', data: { code } });
  const assistant = target.served.artifact.server.assistant;
  if (!assistant) return fail('assistant_unavailable');
  const binding = await resolveAssistantModelBinding(
    target,
    session.tenant,
    session.deploymentId,
    deps,
  );
  if (!binding) {
    return emit({
      event: 'error',
      data: {
        code:
          assistant.model.kind === 'noodle-managed'
            ? 'managed_model_unavailable'
            : 'model_not_configured',
      },
    });
  }
  // Zero means offer none, from every source — not "call one and meet `tool_call_budget_exhausted`".
  // A required tool and a knowledge tool each reach the model by their own path, so silencing only
  // the ordinary ones would still advertise a tool the turn can never run.
  const bounds = agentBounds(deps, binding.requestPolicy);
  const toolless = bounds.toolCalls === 0;
  const knowledge = toolless ? undefined : await resolveAssistantKnowledge(target.served);
  let modelTools = toolless
    ? []
    : selectTurnModelTools(target, session.caller, message, session.modelToolUses);
  const requiredTools = modelTools.filter(assistantModelToolRequiredWhenVisible);
  if (requiredTools.length > 1) return fail('multiple_required_model_tools');
  let requiredTool = requiredTools[0];
  const guideProjection = projectAssistantGuide({
    appPackage: target.served.appPackageSnapshot?.artifact,
    modelTools,
  });
  if (
    guideProjection.status === 'unavailable' &&
    (guideProjection.reason === 'context_too_large' ||
      (guideProjection.reason === 'package_unavailable' &&
        target.served.appPackageSnapshot !== undefined))
  ) {
    deps.logger?.warn('assistant.guide.unavailable', { reason: guideProjection.reason });
  }
  const guideContext = assistantGuideModelContext(guideProjection);
  const contextProvider = await resolveAssistantContextProviderModelResult({
    artifact: target.served.artifact,
    executionDeps: target.served.deps as ExecuteDeps,
    session,
    invocationContext: context,
  });
  const messages: ModelMessage[] = [
    ...assistantTurnModelContextMessages({
      artifact: target.served.artifact,
      session,
      invocationContext: context,
      guideContext,
      ...(knowledge ? { knowledgeGuidance: KNOWLEDGE_CITATION_GUIDANCE } : {}),
      ...(contextProvider === undefined ? {} : { contextProvider }),
      ...(pageContext === undefined ? {} : { pageContext }),
      ...(modelContext === undefined ? {} : { modelContext }),
    }),
    ...session.history,
    { role: 'user', content: message },
  ];
  // Across every step of this turn, not per step: eight tool calls is eight, however the model splits
  // them, or a model that loops one call per step would spend the budget a step at a time.
  let toolCallsThisTurn = 0;
  let omittedToolRecoveries = 0;
  let remainingTokens = binding.requestPolicy?.maxTokensPerTurn;
  const turnSignal =
    binding.requestPolicy?.maxTurnMs === undefined
      ? undefined
      : AbortSignal.timeout(binding.requestPolicy.maxTurnMs);
  for (let step = 0; step < bounds.steps; step += 1) {
    if (remainingTokens !== undefined && remainingTokens <= 0)
      return fail('model_token_budget_exhausted');
    const requestTokenLimit = Math.min(
      binding.requestPolicy?.maxCompletionTokens ?? Number.MAX_SAFE_INTEGER,
      remainingTokens ?? Number.MAX_SAFE_INTEGER,
    );
    const requiredToolForStep = requiredTool;
    const stepModelTools = requiredToolForStep === undefined ? modelTools : [requiredToolForStep];
    stats.modelRequests += 1;
    let streamedContent = '';
    const completion = await requestCompletion(
      binding,
      messages,
      target,
      session.caller,
      deps.modelFetch,
      requiredToolForStep === undefined
        ? (delta) => {
            streamedContent += delta;
            emit({ event: 'content', data: { delta } });
          }
        : () => undefined,
      requiredToolForStep === undefined ? assistantKnowledgeModelTools(knowledge) : [],
      stepModelTools,
      requestTokenLimit === Number.MAX_SAFE_INTEGER ? undefined : requestTokenLimit,
      turnSignal,
      requiredToolForStep === undefined ? undefined : 'required',
    );
    stats.promptTokens += completion.usage?.promptTokens ?? 0;
    stats.completionTokens += completion.usage?.completionTokens ?? 0;
    stats.reasoningTokens += completion.usage?.reasoningTokens ?? 0;
    stats.totalTokens += completion.usage?.totalTokens ?? 0;
    if (remainingTokens !== undefined) {
      remainingTokens = remainingTurnTokens(remainingTokens, completion.usage, requestTokenLimit);
    }
    const response = completion.choices[0]?.message;
    if (!response) return fail('invalid_model_response');
    if (
      requiredToolForStep !== undefined &&
      (response.tool_calls?.length !== 1 ||
        response.tool_calls[0]?.function.name !== requiredToolForStep.name)
    )
      return fail('required_model_tool_missing');
    if (!response.tool_calls?.length) {
      const assistantContent = response.content || streamedContent;
      if (assistantContent) messages.push({ role: 'assistant', content: assistantContent });
      if (suggestions && step + 1 < bounds.steps && (remainingTokens ?? 1) > 0) {
        try {
          const prompts = await requestAssistantSuggestedPrompts(
            binding,
            messages,
            assistantModelFetcher(deps.modelFetch),
            stats,
            remainingTokens,
            turnSignal,
          );
          if (prompts.length > 0) {
            await deps.store.replaceLatestSuggestions(session.id, {
              phase: 'follow_up',
              prompts,
            });
            emit({ event: 'suggested_prompts', data: { phase: 'follow_up', prompts } });
          }
        } catch {
          // Suggestions are a soft enhancement after the useful assistant response already streamed.
        }
      }
      return;
    }
    messages.push({
      role: 'assistant',
      content: response.content ?? '',
      tool_calls: response.tool_calls,
    });
    for (const call of response.tool_calls) {
      toolCallsThisTurn += 1;
      stats.toolCalls += 1;
      if (toolCallsThisTurn > bounds.toolCalls) return fail('tool_call_budget_exhausted');
      const knowledgeComponent = findAssistantKnowledgeComponent(knowledge, call.function.name);
      if (knowledge !== undefined && knowledgeComponent !== undefined) {
        let knowledgeArgs: unknown;
        try {
          knowledgeArgs = JSON.parse(call.function.arguments);
        } catch {
          return fail('invalid_tool_arguments');
        }
        emit({ event: 'tool_started', data: { id: call.id, tool: call.function.name } });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: await executeAssistantKnowledgeSearch(
            knowledge,
            knowledgeComponent,
            knowledgeArgs,
          ),
        });
        continue;
      }
      const tool = stepModelTools.find((candidate) => candidate.name === call.function.name);
      if (!tool) {
        // Tell the model rather than ending the turn on a bare error; `assistantOmittedToolResult`
        // carries the reasoning. Once per turn: a model that insists after being told is the
        // protocol violation the error code exists for, and it stops paying for extra steps.
        if (omittedToolRecoveries > 0) return fail('invalid_model_tool_call');
        omittedToolRecoveries += 1;
        modelTools = [];
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: assistantOmittedToolResult(call.function.name),
        });
        continue;
      }
      // A mixed surface turns "denied" into "sign in first". The intercept runs BEFORE the
      // authorization denial — an ADR 0185-gated tool is exactly what an anonymous visitor signs
      // in to reach (ADR 0201 decision 4), so the offer replaces the denial for that one case;
      // the intercept returns undefined for every other caller, and execution authority is still
      // checked below for all of them.
      // The hosted broker exposes its delegated binding keys so the intercept can classify on
      // connector auth kind too; a broker without the method leaves the base classification alone.
      const delegatedKeys = (
        target.served.deps.broker as {
          readonly assistantDelegatedAuthKeys?: () => ReadonlySet<string>;
        }
      ).assistantDelegatedAuthKeys?.();
      const elevation = await interceptForElevation({
        tool,
        session,
        assistant,
        ...(target.served.artifact.server.state === undefined
          ? {}
          : { state: target.served.artifact.server.state }),
        elevations: deps.elevations,
        ...(delegatedKeys !== undefined && delegatedKeys.size > 0
          ? {
              requiresDelegatedIdentity: (candidate: typeof tool) =>
                toolTouchesDelegatedAuth(candidate, delegatedKeys),
            }
          : {}),
        now: deps.clock?.() ?? new Date(),
      });
      if (elevation) {
        stats.interactionCount += 1;
        emit(elevation.event);
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: elevation.modelResult,
        });
        continue;
      }
      if (!evaluateToolAuthorization(tool.authorization, session.caller).allow)
        return fail('invalid_model_tool_call');
      let args: unknown;
      try {
        args = JSON.parse(call.function.arguments);
      } catch {
        return fail('invalid_tool_arguments');
      }
      // Validate AND apply schema defaults; the pending record and the execution below both use
      // the coerced copy, so the confirmed call equals the executed call (roadmap S5).
      const coerced = validateJsonSchemaWithDefaults(tool.inputSchema, args);
      if (coerced.issues.length > 0) return fail('invalid_tool_arguments');
      args = coerced.value;
      const dispatch = await dispatchAssistantTool({
        artifact: target.served.artifact,
        tool,
        arguments: args,
        executeDeps: withAssistantSessionExecutionAuthority(
          target.served.deps as ExecuteDeps,
          target.served.artifact,
          session,
        ),
        caller: session.caller,
        context,
        session,
        store: deps.store,
        audit: deps.audit,
        now: () => deps.clock?.() ?? new Date(),
        onToolStarted: () =>
          emit({ event: 'tool_started', data: { id: call.id, tool: tool.name } }),
      });
      if (
        assistantModelToolOncePerSession(tool) &&
        (dispatch.kind !== 'event' || dispatch.event !== 'error')
      ) {
        modelTools = modelTools.filter((candidate) => candidate.name !== tool.name);
      }
      if (requiredToolForStep?.name === tool.name) requiredTool = undefined;
      if (dispatch.kind === 'event') {
        stats.interactionCount += 1;
        return emit({ event: dispatch.event, data: dispatch.data });
      }
      const view = assistantViewAvailableData(
        target.served.artifact,
        {
          id: call.id,
          tool: tool.name,
          result: dispatch.output,
          arguments: args,
        },
        (failure) => deps.logger?.warn('assistant.view.unresolved', { ...failure }),
      );
      if (view) {
        await deps.store.replaceLatestView(session.id, recoverableAssistantView(view));
        emit({ event: 'view_available', data: { ...view } });
      }
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(dispatch.output),
      });
    }
  }
  fail('step_limit');
}

/** Generate an initial prompt set from the same exact surface/context assembly as an ordinary turn. */
export async function generateInitialAssistantSuggestions(
  target: ServedTarget,
  session: AssistantSessionRecord,
  context: InvocationContext,
  deps: AssistantRouteDeps,
  modelContext?: AssistantModelContextUpdate,
  pageContext?: AssistantPageContext,
): Promise<readonly string[]> {
  const assistant = target.served.artifact.server.assistant;
  if (!assistant) return [];
  const binding = await resolveAssistantModelBinding(
    target,
    session.tenant,
    session.deploymentId,
    deps,
  );
  if (!binding) return [];
  const knowledge = await resolveAssistantKnowledge(target.served);
  const modelTools = selectTurnModelTools(target, session.caller, undefined, session.modelToolUses);
  const guideProjection = projectAssistantGuide({
    appPackage: target.served.appPackageSnapshot?.artifact,
    modelTools,
  });
  const guideContext = assistantGuideModelContext(guideProjection);
  const contextProvider = await resolveAssistantContextProviderModelResult({
    artifact: target.served.artifact,
    executionDeps: target.served.deps as ExecuteDeps,
    session,
    invocationContext: context,
  });
  const messages = assistantTurnModelContextMessages({
    artifact: target.served.artifact,
    session,
    invocationContext: context,
    guideContext,
    ...(knowledge ? { knowledgeGuidance: KNOWLEDGE_CITATION_GUIDANCE } : {}),
    ...(contextProvider === undefined ? {} : { contextProvider }),
    ...(pageContext === undefined ? {} : { pageContext }),
    ...(modelContext === undefined ? {} : { modelContext }),
  });
  return requestAssistantSuggestedPrompts(
    binding,
    messages,
    assistantModelFetcher(deps.modelFetch),
  );
}

/**
 * One model call narrating a resolved interaction. The outcome is framed as a clearly marked
 * platform message (never an orphan `role:'tool'` message, which OpenAI-compatible providers
 * reject without its original tool_calls envelope). Any tool_calls in the narration response are
 * ignored — this is a reply, not another agent step.
 */
export async function narrateInteractionResolution(
  target: ServedTarget,
  session: AssistantSessionRecord,
  tool: string,
  action: 'accept' | 'decline' | 'cancel',
  result: unknown | undefined,
  context: InvocationContext,
  deps: AssistantRouteDeps,
  onDelta: (delta: string) => void,
  suggestions = false,
): Promise<{ readonly narration: string; readonly suggestions: readonly string[] }> {
  const assistant = target.served.artifact.server.assistant;
  if (!assistant) return { narration: '', suggestions: [] };
  const binding = await resolveAssistantModelBinding(
    target,
    session.tenant,
    session.deploymentId,
    deps,
  );
  if (!binding) return { narration: '', suggestions: [] };
  const knowledge = await resolveAssistantKnowledge(target.served);
  const messages: ModelMessage[] = [
    ...assistantCoreModelMessages({
      artifact: target.served.artifact,
      session,
      invocationContext: context,
      ...(knowledge ? { knowledgeGuidance: KNOWLEDGE_CITATION_GUIDANCE } : {}),
    }),
    ...session.history,
    {
      role: 'user',
      content:
        action === 'accept'
          ? `[platform] The user approved the pending "${tool}" action and it has executed with this result: ${JSON.stringify(result)}. Tell the user the outcome in one short, natural reply. Do not call tools.`
          : `[platform] The user ${action === 'decline' ? 'declined' : 'cancelled'} the pending "${tool}" action. It was not executed. Acknowledge that outcome in one short, natural reply. Do not call tools.`,
    },
  ];
  let narrated = '';
  const completion = await requestCompletion(
    binding,
    messages,
    target,
    session.caller,
    deps.modelFetch,
    (delta) => {
      narrated += delta;
      onDelta(delta);
    },
  );
  const content = completion.choices[0]?.message?.content;
  if (typeof content === 'string' && content && !narrated) {
    narrated = content;
    onDelta(content);
  }
  let prompts: readonly string[] = [];
  if (suggestions && narrated) {
    try {
      prompts = await requestAssistantSuggestedPrompts(
        binding,
        [...messages, { role: 'assistant', content: narrated }],
        assistantModelFetcher(deps.modelFetch),
      );
    } catch {
      // The durable interaction and its narration have already succeeded.
    }
  }
  return { narration: narrated, suggestions: prompts };
}

async function requestCompletion(
  binding: ResolvedAssistantModel,
  messages: readonly ModelMessage[],
  target: ServedTarget,
  caller: AssistantSessionRecord['caller'],
  injected?: typeof fetch,
  onContent: (delta: string) => void = () => undefined,
  extraTools: ReturnType<typeof assistantKnowledgeModelTools> = [],
  selectedModelTools?: readonly ArtifactTool[],
  maxCompletionTokens?: number,
  signal?: AbortSignal,
  toolChoice?: 'auto' | 'none' | 'required',
): Promise<ModelCompletion> {
  return requestModelCompletion({
    binding,
    messages,
    tools: [
      // On a mixed surface an anonymous caller sees gated tools too: projecting one to the
      // surface is the author's opt-in to advertise it, and dispatch converts the call into a
      // sign-in offer instead of executing (ADR 0201 decision 4). The same selector feeds the
      // compact product guide, keeping instructions and callable tools in lockstep.
      ...(selectedModelTools ?? selectTurnModelTools(target, caller)).map((tool) => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      })),
      ...extraTools.map((tool) => ({ ...tool, type: 'function' as const })),
    ],
    fetcher: assistantModelFetcher(injected),
    onContent,
    maxResponseBytes: MAX_MODEL_RESPONSE,
    ...(maxCompletionTokens === undefined ? {} : { maxCompletionTokens }),
    ...(signal === undefined ? {} : { signal }),
    ...(toolChoice === undefined ? {} : { toolChoice }),
  });
}

function selectTurnModelTools(
  target: ServedTarget,
  caller: AssistantSessionRecord['caller'],
  latestMessage?: string,
  usedToolNames?: readonly string[],
): readonly ArtifactTool[] {
  const assistant = target.served.artifact.server.assistant;
  if (caller.identityKind === 'anonymous' && offersSignIn(assistant)) {
    const surface = publicSurfaceOf(assistant);
    if (surface !== undefined) {
      return selectAssistantModelTools(target.served.artifact, caller, {
        anonymousSignInOfferSurface: surface.capabilities,
        ...(latestMessage === undefined ? {} : { latestMessage }),
        ...(usedToolNames === undefined ? {} : { usedToolNames }),
      });
    }
  }
  return selectAssistantModelTools(target.served.artifact, caller, {
    ...(latestMessage === undefined ? {} : { latestMessage }),
    ...(usedToolNames === undefined ? {} : { usedToolNames }),
  });
}

type ModelMessage = AssistantModelMessage & { readonly tool_calls?: readonly ModelToolCall[] };

function assistantModelFetcher(injected?: typeof fetch): typeof fetch {
  return injected ?? ((url, init) => guardedFetch(new URL(url), init));
}
