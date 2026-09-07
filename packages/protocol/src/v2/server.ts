import {
  type CallToolResult,
  CLIENT_CAPABILITIES_META_KEY,
  type GetPromptResult,
  type ListPromptsResult,
  type ListResourcesResult,
  type ListResourceTemplatesResult,
  type ListToolsResult,
  ProtocolError,
  type ReadResourceResult,
  ResourceNotFoundError,
  Server,
  type ServerCapabilities,
} from '@modelcontextprotocol/server';
import type { RuntimeArtifact } from '@noodle-borg/compiler';
import {
  type ElicitationResponse,
  type ExecuteDeps,
  type ExecuteToolDeps,
  executePrompt,
  executeResource,
  type ToolDispatchDecision,
  type ToolDispatchHook,
} from '@noodle-borg/runtime';
import { parseUriTemplate } from '@noodle-borg/uri-template';
import {
  artifactDeclaresContext,
  assertNoContextToolCollision,
  CONTEXT_TOOL_DESCRIPTOR,
  CONTEXT_TOOL_NAME,
} from '../context-tool.js';
import { LEGACY_MCP_ERROR } from '../error-codes.js';
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
  mapPromptMessages,
  mapPromptsList,
  mapResourceContents,
  mapResourcesList,
  mapResourceTemplatesList,
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
import { buildProtocolRequestDeps } from '../request-deps.js';
import {
  assertRequestStateBinding,
  RequestStateError,
  type SealedRequestState,
} from '../request-state.js';
import type { ProtocolRequestContext, ServedArtifact } from '../sdk-server.js';
import { evaluateToolAuthorization } from '../tool-authorization.js';
import {
  clientCapabilitiesSupportFormElicitation,
  runMcpToolInteraction,
} from '../tool-interaction.js';
import { interactionUnavailableToolResult, stoppedToolResult } from '../tool-results.js';
import { NOODLE_MCP_CACHE_HINTS } from './cache-hints.js';
import { runModernConfirmedTool, toolRequiresModernConfirmation } from './confirmation.js';
import {
  inputRequiredForTool,
  mergeInputResponses,
  toolRequestStateBinding,
} from './input-required.js';
import { type McpSkillProjection, projectMcpSkill, registerMcpSkillMethods } from './skills.js';
import { shapeModernToolsList } from './tool-list.js';
import { type McpProtocolEra, SERVED_MCP_PROTOCOL_VERSIONS } from './versions.js';

export function buildDualEraMcpServer(
  { artifact, deps, appPackageSnapshot }: ServedArtifact,
  era: McpProtocolEra,
  context: ProtocolRequestContext = {},
): Server {
  assertNoContextToolCollision(artifact);
  const skill =
    era === 'modern' ? projectMcpSkill(appPackageSnapshot, artifact, context.caller) : undefined;
  const hasResources = (artifact.resources?.length ?? 0) > 0 || skill !== undefined;
  const hasPrompts = (artifact.prompts?.length ?? 0) > 0;
  const extensions = {
    ...(artifactHasMcpApp(artifact)
      ? {
          'io.modelcontextprotocol/ui': {
            mimeTypes: ['text/html;profile=mcp-app'],
          },
        }
      : {}),
    ...(context.oauthClientCredentialsReady === true
      ? { 'io.modelcontextprotocol/oauth-client-credentials': {} }
      : {}),
    ...(skill?.extension ?? {}),
  };
  const capabilities: ServerCapabilities = {
    tools: {},
    ...(hasResources ? { resources: {} } : {}),
    ...(hasPrompts ? { prompts: {} } : {}),
    ...(era === 'modern' && Object.keys(extensions).length > 0 ? { extensions } : {}),
  };
  const requestStateManager = context.requestState;
  const server = new Server(
    {
      name: artifact.server.name,
      title: artifact.server.title,
      version: artifact.server.version,
    },
    {
      supportedProtocolVersions: [...SERVED_MCP_PROTOCOL_VERSIONS],
      capabilities,
      cacheHints: NOODLE_MCP_CACHE_HINTS,
      inputRequired: { maxRounds: 8, legacyShim: false },
      ...(requestStateManager === undefined
        ? {}
        : {
            requestState: {
              verify: async (state: string, ctx) => {
                try {
                  return await requestStateManager.open(state);
                } catch (error) {
                  const rejection = asRequestStateError(error);
                  notify(context, {
                    method: ctx.mcpReq.method,
                    outcome: 'mcp_error',
                    errorKind: rejection.reason,
                  });
                  throw rejection;
                }
              },
            },
          }),
      ...(artifact.server.instructions === undefined
        ? {}
        : { instructions: artifact.server.instructions }),
    },
  );
  const requestDeps = buildProtocolRequestDeps(artifact, deps, context);
  registerV2Tools(server, artifact, requestDeps, context, era);
  if (hasResources) registerV2Resources(server, artifact, requestDeps, context, era, skill);
  if (skill !== undefined) registerMcpSkillMethods(server, skill);
  if (hasPrompts) registerV2Prompts(server, artifact, requestDeps, context);
  return server;
}

function registerV2Tools(
  server: Server,
  artifact: RuntimeArtifact,
  deps: ExecuteDeps,
  context: ProtocolRequestContext,
  era: McpProtocolEra,
): void {
  server.setRequestHandler('tools/list', async () => {
    const mapped = mapToolsList(artifact, context.caller, {
      knowledgeTools: await knowledgeToolsEnabled(artifact, deps),
      intentCapture: context.intentCapture?.enabled === true,
    });
    return (era === 'modern' ? shapeModernToolsList(mapped) : mapped) as ListToolsResult;
  });

  server.setRequestHandler('tools/call', async (request, ctx) => {
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
        throw new ProtocolError(-32602, `invalid arguments for tool "${toolName}"`, {
          reason: 'invalid_tool_arguments',
          validation: coerced.issues,
        });
      }
      if (deps.context === undefined) {
        observe('mcp_error', { errorKind: 'invocation_context_unavailable' });
        throw new ProtocolError(
          -32603,
          'invocation context was declared but not resolved for this request',
        );
      }
      const mapped = mapToolOutput(deps.context) as CallToolResult;
      observe('ok', { outputTokensEst: estimateTokens(deps.context) });
      return server.projectCallToolResult(mapped, CONTEXT_TOOL_DESCRIPTOR.outputSchema);
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
        throw new ProtocolError(-32602, `invalid arguments for tool "${toolName}"`, {
          reason: 'invalid_tool_arguments',
          validation: outcome.issues,
        });
      }
      if (outcome.kind === 'error') {
        observe('mcp_error', { errorKind: outcome.reason });
        throw new ProtocolError(-32603, outcome.message, { reason: outcome.reason });
      }
      const mapped = mapToolOutput(outcome.output) as CallToolResult;
      observe('ok', { outputTokensEst: estimateTokens(outcome.output) });
      return server.projectCallToolResult(
        mapped,
        knowledgeComponent.generatedTool.outputSchema as Record<string, unknown>,
      );
    }

    const tool = artifact.tools.find((item) => item.name === toolName);
    if (tool !== undefined) {
      const authorization = evaluateToolAuthorization(tool.authorization, context.caller);
      if (!authorization.allow) {
        observe('mcp_error', { errorKind: authorization.reason });
        throw new ProtocolError(
          LEGACY_MCP_ERROR.TOOL_AUTHORIZATION_DENIED,
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
    const interaction =
      era === 'legacy'
        ? extractElicitationResponses(
            captured.arguments,
            ctx.mcpReq._meta,
            toolUsesPortableInteractionArgument(tool),
          )
        : { arguments: captured.arguments, responses: {} };
    let toolArguments: unknown = interaction.arguments;
    const requestState =
      era === 'modern' ? ctx.mcpReq.requestState<SealedRequestState>() : undefined;
    const modernBinding = () =>
      toolRequestStateBinding(
        artifact,
        context,
        toolName,
        interaction.arguments,
        deps.executionBinding?.revision,
      );
    const rejectRequestState = (error: unknown): never => {
      const rejection = asRequestStateError(error);
      observe('mcp_error', { errorKind: rejection.reason });
      throw invalidRequestStateError();
    };
    if (requestState !== undefined) {
      try {
        assertRequestStateBinding(requestState, modernBinding());
      } catch (error) {
        rejectRequestState(error);
      }
    }
    if (
      era === 'modern' &&
      requestState === undefined &&
      (ctx.mcpReq.inputResponses !== undefined || ctx.mcpReq.droppedInputResponseKeys !== undefined)
    ) {
      rejectRequestState(new RequestStateError('missing_request_state'));
    }
    let modernResponses: Readonly<Record<string, ElicitationResponse>> = interaction.responses;
    let reissueDropped = false;
    try {
      if (era === 'modern') {
        const merged = mergeInputResponses(
          requestState,
          ctx.mcpReq.inputResponses,
          ctx.mcpReq.droppedInputResponseKeys,
        );
        modernResponses = merged.responses;
        reissueDropped = merged.reissueDropped;
      } else {
        modernResponses = interaction.responses;
      }
    } catch (error) {
      rejectRequestState(error);
    }
    if (era === 'modern' && requestState?.confirmation === true && !reissueDropped) {
      const ledger =
        context.confirmationNonceLedger ??
        rejectRequestState(new RequestStateError('confirmation_ledger_unavailable'));
      let consumed = false;
      try {
        consumed = await ledger.consume(requestState.nonce, requestState.expiresAt);
      } catch {
        rejectRequestState(new RequestStateError('confirmation_ledger_unavailable'));
      }
      if (!consumed) rejectRequestState(new RequestStateError('confirmation_replay'));
    }
    if (tool !== undefined) {
      const coerced = coerceToolArguments(tool.inputSchema, toolArguments);
      if (coerced.issues.length > 0) {
        observe('mcp_error', { errorKind: 'invalid_params' });
        throw new ProtocolError(-32602, `invalid arguments for tool "${toolName}"`, {
          reason: 'invalid_tool_arguments',
          validation: coerced.issues,
        });
      }
      toolArguments = coerced.value;
    }
    const toolDeps: ExecuteToolDeps = {
      ...deps,
      ...(requestState === undefined ? {} : { invocationId: requestState.nonce }),
      signal: ctx.mcpReq.signal,
      ...(context.beforeToolDispatch === undefined
        ? {}
        : {
            beforeDispatch: onceToolDispatch(
              () =>
                context.beforeToolDispatch?.({
                  toolName,
                  toolArguments,
                  requestId: ctx.mcpReq.id,
                  signal: ctx.mcpReq.signal,
                  ...(ctx.sessionId === undefined ? {} : { sessionId: ctx.sessionId }),
                  ...(requestState === undefined
                    ? {}
                    : {
                        invocationId: requestState.nonce,
                        invocationRound: requestState.round,
                      }),
                  ...(ctx.mcpReq._meta === undefined ? {} : { requestMeta: ctx.mcpReq._meta }),
                }) ?? Promise.resolve({ allow: true }),
            ),
          }),
    };
    const useHostConfirmationFallback =
      era === 'modern' &&
      requestState === undefined &&
      tool !== undefined &&
      toolRequiresModernConfirmation(tool) &&
      artifact.server.interactions?.confirmationFallback === 'host' &&
      !clientCapabilitiesSupportFormElicitation(requestClientCapabilities(ctx.mcpReq.envelope));
    const result =
      era === 'modern' &&
      toolRequiresModernConfirmation(tool) &&
      tool !== undefined &&
      !useHostConfirmationFallback
        ? await runModernConfirmedTool({
            artifact,
            tool,
            toolName,
            toolArguments,
            deps: toolDeps,
            responses: modernResponses,
          })
        : await runMcpToolInteraction({
            server,
            artifact,
            tool,
            toolName,
            toolArguments,
            deps: toolDeps,
            formElicitationTransport: 'unavailable',
            providedElicitationResponses: modernResponses,
            onProtocolError: (errorKind) => observe('mcp_error', { errorKind }),
          });
    if (result.status === 'interaction_unavailable') {
      if (era === 'modern' && context.requestState !== undefined) {
        try {
          const pending = await inputRequiredForTool(
            context.requestState,
            modernBinding(),
            result,
            modernResponses,
            requestState,
          );
          if (reissueDropped) {
            observe('mcp_error', { errorKind: 'dropped_input_response_envelope' });
          }
          return pending;
        } catch (error) {
          if (error instanceof RequestStateError) rejectRequestState(error);
          throw error;
        }
      }
      observe('tool_error', { errorKind: 'interaction_unavailable' });
      return interactionUnavailableToolResult(toolName, result) as CallToolResult;
    }
    if (result.status === 'stopped') {
      observe('tool_error', { errorKind: `${result.source}_${result.action}` });
      return stoppedToolResult(
        result.action,
        result.source === 'confirmation' ? 'action' : 'requested input',
      ) as CallToolResult;
    }
    if (result.status === 'completed') {
      const output =
        tool?._meta?.ui?.resourceUri === undefined
          ? result.output
          : redactWidgetLinkedOutput(result.output);
      const mapped = mapToolOutput(output) as CallToolResult;
      observe('ok', { outputTokensEst: estimateTokens(output) });
      return server.projectCallToolResult(mapped, tool?.outputSchema);
    }
    const outcome = mapExecutionError(result.error);
    if ('result' in outcome) {
      observe('tool_error', executionErrorObservation(result.error));
      return outcome.result as CallToolResult;
    }
    observe('mcp_error', executionErrorObservation(result.error));
    throw new ProtocolError(outcome.error.code, outcome.error.message);
  });
}

function registerV2Resources(
  server: Server,
  artifact: RuntimeArtifact,
  deps: ExecuteDeps,
  context: ProtocolRequestContext,
  era: McpProtocolEra,
  skill?: McpSkillProjection,
): void {
  server.setRequestHandler(
    'resources/list',
    () => mapResourcesList(artifact) as ListResourcesResult,
  );
  server.setRequestHandler(
    'resources/templates/list',
    () => mapResourceTemplatesList(artifact) as ListResourceTemplatesResult,
  );
  server.setRequestHandler('resources/read', async (request) => {
    const { uri } = request.params;
    const skillResource = skill?.resource(uri);
    if (skillResource !== undefined) {
      notify(context, {
        method: 'resources/read',
        outcome: 'ok',
        outputTokensEst: estimateTokens(skillResource.text),
      });
      return {
        contents: [
          {
            uri: skillResource.uri,
            mimeType: skillResource.mimeType,
            text: skillResource.text,
          },
        ],
      } as ReadResourceResult;
    }
    for (const resource of artifact.resources ?? []) {
      const variables = matchResourceUri(resource.uri, resource.isTemplate, uri);
      if (variables === null) continue;
      const result = await executeResource(artifact, resource.name, variables, deps);
      if (!result.ok) {
        notify(context, {
          method: 'resources/read',
          resourceName: resource.name,
          outcome: 'mcp_error',
          ...executionErrorObservation(result.error),
        });
        throw new ProtocolError(-32603, result.error.message);
      }
      const mapped = mapResourceContents(
        uri,
        resource.mimeType,
        result.output,
        resource._meta,
        context.widgetDomain,
      ) as ReadResourceResult;
      notify(context, {
        method: 'resources/read',
        resourceName: resource.name,
        outcome: 'ok',
        outputTokensEst: estimateTokens(result.output),
      });
      return mapped;
    }
    notify(context, {
      method: 'resources/read',
      outcome: 'mcp_error',
      errorKind: 'resource_not_found',
    });
    if (era === 'modern') throw new ResourceNotFoundError(uri, `resource not found: ${uri}`);
    throw new ProtocolError(LEGACY_MCP_ERROR.RESOURCE_NOT_FOUND, `resource not found: ${uri}`);
  });
}

function registerV2Prompts(
  server: Server,
  artifact: RuntimeArtifact,
  deps: ExecuteDeps,
  context: ProtocolRequestContext,
): void {
  server.setRequestHandler('prompts/list', () => mapPromptsList(artifact) as ListPromptsResult);
  server.setRequestHandler('prompts/get', async (request) => {
    const { name, arguments: args } = request.params;
    const observe = (
      outcome: ObservedOutcome,
      extra: Pick<ProtocolObservation, 'errorKind' | 'outputTokensEst' | 'connector'> = {},
    ): void => notify(context, { method: 'prompts/get', promptName: name, outcome, ...extra });
    const prompt = (artifact.prompts ?? []).find((item) => item.name === name);
    if (prompt === undefined) {
      observe('mcp_error', { errorKind: 'unknown_prompt' });
      throw new ProtocolError(-32602, `unknown prompt "${name}"`);
    }
    for (const argument of prompt.arguments ?? []) {
      if (argument.required && args?.[argument.name] === undefined) {
        observe('mcp_error', { errorKind: 'invalid_params' });
        throw new ProtocolError(-32602, `missing required argument "${argument.name}"`);
      }
    }
    const result = await executePrompt(artifact, name, args ?? {}, deps);
    if (!result.ok) {
      observe('mcp_error', executionErrorObservation(result.error));
      throw new ProtocolError(-32603, result.error.message);
    }
    const mapped = mapPromptMessages(result.output, prompt.description) as GetPromptResult;
    observe('ok', { outputTokensEst: estimateTokens(result.output) });
    return mapped;
  });
}

function matchResourceUri(
  pattern: string,
  isTemplate: boolean,
  uri: string,
): Record<string, string> | null {
  if (!isTemplate) return pattern === uri ? {} : null;
  const parsed = parseUriTemplate(pattern);
  return parsed.ok && parsed.value.kind === 'template' ? parsed.value.match(uri) : null;
}

function onceToolDispatch(hook: ToolDispatchHook): ToolDispatchHook {
  let pending: Promise<ToolDispatchDecision> | undefined;
  return (dispatchContext) => {
    pending ??= Promise.resolve().then(() => hook(dispatchContext));
    return pending;
  };
}

function artifactHasMcpApp(artifact: RuntimeArtifact): boolean {
  return (artifact.resources ?? []).some(
    (resource) =>
      resource.uri.startsWith('ui://') ||
      resource.mimeType?.toLowerCase() === 'text/html;profile=mcp-app',
  );
}

function requestClientCapabilities(envelope: unknown): unknown {
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
    return undefined;
  }
  return (envelope as Record<string, unknown>)[CLIENT_CAPABILITIES_META_KEY];
}

function invalidRequestStateError(): ProtocolError {
  return new ProtocolError(-32602, 'Invalid or expired requestState', {
    reason: 'invalid_request_state',
  });
}

function asRequestStateError(error: unknown): RequestStateError {
  return error instanceof RequestStateError ? error : new RequestStateError();
}
