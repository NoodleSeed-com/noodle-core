import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ErrorCode,
  ListToolsRequestSchema,
  type ListToolsResult,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import type { RuntimeArtifact } from '@noodle-borg/compiler';
import type {
  ExecuteDeps,
  ExecuteToolDeps,
  ToolDispatchDecision,
  ToolDispatchHook,
} from '@noodle-borg/runtime';
import {
  artifactDeclaresContext,
  CONTEXT_TOOL_DESCRIPTOR,
  CONTEXT_TOOL_NAME,
} from '../context-tool.js';
import { coerceToolArguments } from '../input-validation.js';
import { extractIntentCapture, intentCaptureEligible } from '../intent-capture.js';
import {
  extractElicitationResponses,
  toolUsesPortableInteractionArgument,
} from '../interaction-envelope.js';
import {
  findKnowledgeComponent,
  knowledgeToolsEnabled,
  runKnowledgeSearchTool,
} from '../knowledge-tool.js';
import {
  mapExecutionError,
  mapToolOutput,
  mapToolsList,
  redactWidgetLinkedOutput,
} from '../mapping.js';
import {
  estimateTokens,
  executionErrorObservation,
  notify,
  type ObservedOutcome,
  type ProtocolObservation,
} from '../observation.js';
import type { ProtocolRequestContext } from '../sdk-server.js';
import { evaluateToolAuthorization, TOOL_AUTHORIZATION_DENIED } from '../tool-authorization.js';
import { runMcpToolInteraction } from '../tool-interaction.js';
import { interactionUnavailableToolResult, stoppedToolResult } from '../tool-results.js';

export function registerTools(
  server: Server,
  artifact: RuntimeArtifact,
  deps: ExecuteDeps,
  context: ProtocolRequestContext,
): void {
  // Our mapping helpers return structural subsets of the SDK's result unions; the `as` casts pick the
  // intended union arm (the SDK union also has a Tasks arm that requires a `task` field we never emit).
  server.setRequestHandler(
    ListToolsRequestSchema,
    async () =>
      mapToolsList(artifact, context.caller, {
        knowledgeTools: await knowledgeToolsEnabled(artifact, deps),
        intentCapture: context.intentCapture?.enabled === true,
        ...(context.toolAuthentication === undefined
          ? {}
          : { authentication: context.toolAuthentication }),
      }) as ListToolsResult,
  );

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const toolName = request.params.name;
    let capturedIntent: ProtocolObservation['intent'];
    const observe = (
      outcome: ObservedOutcome,
      extra: Pick<ProtocolObservation, 'errorKind' | 'outputTokensEst' | 'connector'> = {},
    ): void =>
      notify(context, {
        method: 'tools/call',
        toolName,
        outcome,
        ...(capturedIntent === undefined ? {} : { intent: capturedIntent }),
        ...extra,
      });

    if (toolName === CONTEXT_TOOL_NAME && artifactDeclaresContext(artifact)) {
      const coerced = coerceToolArguments(
        CONTEXT_TOOL_DESCRIPTOR.inputSchema,
        request.params.arguments ?? {},
      );
      if (coerced.issues.length > 0) {
        observe('mcp_error', { errorKind: 'invalid_params' });
        throw new McpError(ErrorCode.InvalidParams, `invalid arguments for tool "${toolName}"`, {
          reason: 'invalid_tool_arguments',
          validation: coerced.issues,
        });
      }
      if (deps.context === undefined) {
        observe('mcp_error', { errorKind: 'invocation_context_unavailable' });
        throw new McpError(
          ErrorCode.InternalError,
          'invocation context was declared but not resolved for this request',
        );
      }
      const mapped = mapToolOutput(deps.context) as CallToolResult;
      observe('ok', { outputTokensEst: estimateTokens(deps.context) });
      return mapped;
    }

    const knowledgeComponent = findKnowledgeComponent(artifact, toolName);
    if (knowledgeComponent !== undefined && (await knowledgeToolsEnabled(artifact, deps))) {
      const captured = extractIntentCapture(request.params.arguments ?? {}, {
        enabled: context.intentCapture?.enabled === true,
        eligible: intentCaptureEligible(
          knowledgeComponent.generatedTool.inputSchema as Record<string, unknown>,
        ),
      });
      capturedIntent = captured.intent;
      const outcome = await runKnowledgeSearchTool(
        knowledgeComponent,
        deps,
        captured.arguments as Record<string, unknown>,
      );
      if (outcome.kind === 'invalid') {
        observe('mcp_error', { errorKind: 'invalid_params' });
        throw new McpError(ErrorCode.InvalidParams, `invalid arguments for tool "${toolName}"`, {
          reason: 'invalid_tool_arguments',
          validation: outcome.issues,
        });
      }
      if (outcome.kind === 'error') {
        observe('mcp_error', { errorKind: outcome.reason });
        throw new McpError(ErrorCode.InternalError, outcome.message, { reason: outcome.reason });
      }
      const mapped = mapToolOutput(outcome.output) as CallToolResult;
      observe('ok', { outputTokensEst: estimateTokens(outcome.output) });
      return mapped;
    }

    const tool = artifact.tools.find((item) => item.name === toolName);
    if (tool !== undefined) {
      const authorization = evaluateToolAuthorization(tool.authorization, context.caller);
      if (!authorization.allow) {
        observe('mcp_error', { errorKind: authorization.reason });
        throw new McpError(
          TOOL_AUTHORIZATION_DENIED,
          authorization.reason === 'insufficient_scope' ? 'insufficient scope' : 'forbidden',
          {
            reason: authorization.reason,
            ...(authorization.reason === 'insufficient_scope'
              ? { requiredScopes: authorization.requiredScopes }
              : {}),
          },
        );
      }
    }
    const captured = extractIntentCapture(request.params.arguments ?? {}, {
      enabled: context.intentCapture?.enabled === true,
      eligible: tool !== undefined && intentCaptureEligible(tool.inputSchema),
    });
    capturedIntent = captured.intent;
    const interaction = extractElicitationResponses(
      captured.arguments,
      request.params._meta,
      toolUsesPortableInteractionArgument(tool),
    );
    let toolArguments: unknown = interaction.arguments;
    if (tool !== undefined) {
      const coerced = coerceToolArguments(tool.inputSchema, toolArguments);
      if (coerced.issues.length > 0) {
        observe('mcp_error', { errorKind: 'invalid_params' });
        throw new McpError(ErrorCode.InvalidParams, `invalid arguments for tool "${toolName}"`, {
          reason: 'invalid_tool_arguments',
          validation: coerced.issues,
        });
      }
      // Schema defaults are applied on a copy; the tool executes what was validated.
      toolArguments = coerced.value;
    }
    const toolDeps: ExecuteToolDeps = {
      ...deps,
      signal: extra.signal,
      ...(context.beforeToolDispatch === undefined
        ? {}
        : {
            beforeDispatch: onceToolDispatch(
              () =>
                context.beforeToolDispatch?.({
                  toolName,
                  toolArguments,
                  requestId: extra.requestId,
                  signal: extra.signal,
                  ...(extra.sessionId !== undefined ? { sessionId: extra.sessionId } : {}),
                  ...(extra._meta !== undefined ? { requestMeta: extra._meta } : {}),
                }) ?? Promise.resolve({ allow: true }),
            ),
          }),
    };
    const result = await runMcpToolInteraction({
      server,
      artifact,
      tool,
      toolName,
      toolArguments,
      deps: toolDeps,
      ...(context.formElicitationTransport === undefined
        ? {}
        : { formElicitationTransport: context.formElicitationTransport }),
      providedElicitationResponses: interaction.responses,
      onProtocolError: (errorKind) => observe('mcp_error', { errorKind }),
    });
    if (result.status === 'interaction_unavailable') {
      observe('tool_error', { errorKind: 'interaction_unavailable' });
      return interactionUnavailableToolResult(toolName, result);
    }
    if (result.status === 'stopped') {
      observe('tool_error', { errorKind: `${result.source}_${result.action}` });
      return stoppedToolResult(
        result.action,
        result.source === 'confirmation' ? 'action' : 'requested input',
      );
    }
    if (result.status === 'completed') {
      const output =
        tool?._meta?.ui?.resourceUri !== undefined
          ? redactWidgetLinkedOutput(result.output)
          : result.output;
      const mapped = mapToolOutput(output) as CallToolResult;
      observe('ok', { outputTokensEst: estimateTokens(output) });
      return mapped;
    }
    // Two channels (docs/SPEC.md "Error Translation Matrix"): model-actionable failures become an
    // `isError` tool result; protocol faults are thrown as a JSON-RPC error the SDK serializes.
    // The same split is the analytics two-tier taxonomy: tool_error vs mcp_error (ADR 0121).
    const outcome = mapExecutionError(result.error);
    if ('result' in outcome) {
      observe('tool_error', executionErrorObservation(result.error));
      return outcome.result as CallToolResult;
    }
    observe('mcp_error', executionErrorObservation(result.error));
    throw new McpError(outcome.error.code, outcome.error.message);
  });
}

/** Cache both admission and rejection so one logical tool call cannot consume admission twice. */
function onceToolDispatch(hook: ToolDispatchHook): ToolDispatchHook {
  let pending: Promise<ToolDispatchDecision> | undefined;
  return (dispatchContext) => {
    pending ??= Promise.resolve().then(() => hook(dispatchContext));
    return pending;
  };
}
