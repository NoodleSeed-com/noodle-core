import {
  type ElicitRequestFormParams,
  type ElicitResult,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import type { RuntimeArtifact } from '@noodle-borg/compiler';
import {
  type ElicitationRequest,
  type ElicitationResponse,
  type ExecuteToolDeps,
  type ExecutionError,
  executePreparedTool,
  executeToolInteractive,
  isInputRequired,
  prepareToolForConfirmation,
  resumeTool,
  resumeToolPreparation,
} from '@noodle-borg/runtime';
import {
  confirmationElicitationRequest,
  isAffirmativeConfirmation,
} from './confirmation-elicitation.js';
import { toolRequiresConfirmation } from './tool-confirmation.js';

type ArtifactTool = RuntimeArtifact['tools'][number];

/** Structural elicitation surface shared by the v1 and v2 SDK server implementations. */
interface FormElicitationServer {
  getClientCapabilities(): unknown;
  elicitInput(params: ElicitRequestFormParams): Promise<ElicitResult>;
}

export type McpToolInteractionOutcome =
  | { readonly status: 'completed'; readonly output: unknown }
  | { readonly status: 'failed'; readonly error: ExecutionError }
  | {
      readonly status: 'interaction_unavailable';
      readonly interaction: 'confirmation' | 'input';
      readonly request?: ElicitationRequest;
      readonly responses?: Readonly<Record<string, ElicitationResponse>>;
    }
  | {
      readonly status: 'stopped';
      readonly action: 'decline' | 'cancel';
      readonly source: 'input' | 'confirmation';
    };

export interface McpToolInteractionInput {
  readonly server: FormElicitationServer;
  readonly artifact: RuntimeArtifact;
  readonly tool: ArtifactTool | undefined;
  readonly toolName: string;
  readonly toolArguments: unknown;
  readonly deps: ExecuteToolDeps;
  readonly formElicitationTransport?: 'bidirectional' | 'unavailable';
  /** Answers collected by an MCP App or model and replayed through the input-only flow prefix. */
  readonly providedElicitationResponses?: Readonly<Record<string, ElicitationResponse>>;
  readonly onProtocolError: (
    errorKind: 'elicitation_unavailable' | 'invalid_confirmation_flow',
  ) => void;
}

/** Execute one MCP tool through negotiated forms or schema-validated stateless input replay. */
export async function runMcpToolInteraction({
  server,
  artifact,
  tool,
  toolName,
  toolArguments,
  deps,
  formElicitationTransport,
  providedElicitationResponses = {},
  onProtocolError,
}: McpToolInteractionInput): Promise<McpToolInteractionOutcome> {
  const confirmationRequired = toolRequiresConfirmation(tool);
  const inputRequired = toolRequiresFormElicitation(tool);
  if (
    (confirmationRequired || inputRequired) &&
    !supportsFormElicitation(server, formElicitationTransport)
  ) {
    if (inputRequired || confirmationRequired) {
      return runWithoutFormElicitation({
        artifact,
        tool,
        toolName,
        toolArguments,
        deps,
        confirmationRequired,
        providedElicitationResponses,
      });
    }
    return { status: 'interaction_unavailable', interaction: 'confirmation' };
  }

  if (confirmationRequired && tool !== undefined) {
    let preparation = await prepareToolForConfirmation(artifact, toolName, toolArguments, deps);
    while (preparation.status === 'input_required') {
      const response = await requestFormElicitation(
        server,
        {
          mode: 'form',
          message: preparation.request.message,
          requestedSchema: preparation.request
            .requestedSchema as ElicitRequestFormParams['requestedSchema'],
        },
        () => onProtocolError('elicitation_unavailable'),
      );
      preparation = await resumeToolPreparation(artifact, preparation.continuation, response, deps);
    }
    if (preparation.status === 'stopped') {
      return { ...preparation, source: 'input' };
    }
    if (preparation.status === 'failed') return preparation;

    const confirmation = confirmationElicitationRequest(tool, preparation.review);
    if (!confirmation.ok) {
      throw new McpError(
        ErrorCode.InternalError,
        'the prepared action cannot be shown completely and was not executed',
      );
    }
    const response = await requestFormElicitation(server, confirmation.request, () =>
      onProtocolError('elicitation_unavailable'),
    );
    if (response.action !== 'accept') {
      return { status: 'stopped', action: response.action, source: 'confirmation' };
    }
    if (!isAffirmativeConfirmation(response)) {
      return { status: 'stopped', action: 'decline', source: 'confirmation' };
    }
    const result = await executePreparedTool(artifact, preparation.continuation, deps);
    if (result.status === 'input_required') {
      onProtocolError('invalid_confirmation_flow');
      throw new McpError(
        ErrorCode.InternalError,
        'the prepared action reached an unexpected input boundary',
      );
    }
    return result.status === 'stopped' ? { ...result, source: 'input' } : result;
  }

  let result = await executeToolInteractive(artifact, toolName, toolArguments, deps);
  while (isInputRequired(result)) {
    const response = await requestFormElicitation(
      server,
      {
        mode: 'form',
        message: result.request.message,
        requestedSchema: result.request
          .requestedSchema as ElicitRequestFormParams['requestedSchema'],
      },
      () => onProtocolError('elicitation_unavailable'),
    );
    result = await resumeTool(artifact, result.continuation, response, deps);
  }
  return result.status === 'stopped' ? { ...result, source: 'input' } : result;
}

async function runWithoutFormElicitation(input: {
  readonly artifact: RuntimeArtifact;
  readonly tool: ArtifactTool | undefined;
  readonly toolName: string;
  readonly toolArguments: unknown;
  readonly deps: ExecuteToolDeps;
  readonly confirmationRequired: boolean;
  readonly providedElicitationResponses: Readonly<Record<string, ElicitationResponse>>;
}): Promise<McpToolInteractionOutcome> {
  const responses: Record<string, ElicitationResponse> = {
    ...input.providedElicitationResponses,
  };
  if (input.confirmationRequired && input.tool !== undefined) {
    let preparation = await prepareToolForConfirmation(
      input.artifact,
      input.toolName,
      input.toolArguments,
      input.deps,
    );
    while (preparation.status === 'input_required') {
      const response = responses[preparation.request.id];
      if (response === undefined) {
        return {
          status: 'interaction_unavailable',
          interaction: 'input',
          request: preparation.request,
          responses,
        };
      }
      preparation = await resumeToolPreparation(
        input.artifact,
        preparation.continuation,
        response,
        input.deps,
      );
    }
    if (preparation.status === 'stopped') return { ...preparation, source: 'input' };
    if (preparation.status === 'failed') return preparation;
    if (input.artifact.server.interactions?.confirmationFallback !== 'host') {
      return { status: 'interaction_unavailable', interaction: 'confirmation' };
    }
    const result = await executePreparedTool(input.artifact, preparation.continuation, input.deps);
    if (result.status === 'input_required') {
      throw new McpError(
        ErrorCode.InternalError,
        'the prepared action reached an unexpected input boundary',
      );
    }
    return result.status === 'stopped' ? { ...result, source: 'input' } : result;
  }

  let result = await executeToolInteractive(
    input.artifact,
    input.toolName,
    input.toolArguments,
    input.deps,
  );
  while (isInputRequired(result)) {
    const response = responses[result.request.id];
    if (response === undefined) {
      return {
        status: 'interaction_unavailable',
        interaction: 'input',
        request: result.request,
        responses,
      };
    }
    result = await resumeTool(input.artifact, result.continuation, response, input.deps);
  }
  return result.status === 'stopped' ? { ...result, source: 'input' } : result;
}

function toolRequiresFormElicitation(tool: ArtifactTool | undefined): boolean {
  return (
    tool?.fulfilment.kind === 'flow' && tool.fulfilment.steps.some((step) => step.kind === 'elicit')
  );
}

function supportsFormElicitation(
  server: FormElicitationServer,
  transport: McpToolInteractionInput['formElicitationTransport'],
): boolean {
  return (
    transport !== 'unavailable' &&
    clientCapabilitiesSupportFormElicitation(server.getClientCapabilities())
  );
}

/** Whether an MCP client-capabilities declaration includes standard form elicitation support. */
export function clientCapabilitiesSupportFormElicitation(capabilities: unknown): boolean {
  if (!isRecord(capabilities) || !isRecord(capabilities.elicitation)) return false;
  return (
    capabilities.elicitation.form !== undefined ||
    (capabilities.elicitation.form === undefined && capabilities.elicitation.url === undefined)
  );
}

async function requestFormElicitation(
  server: FormElicitationServer,
  params: ElicitRequestFormParams,
  onUnavailable: () => void,
): Promise<ElicitResult> {
  try {
    return await server.elicitInput(params);
  } catch {
    onUnavailable();
    throw new McpError(
      ErrorCode.InternalError,
      'this client cannot complete the required user interaction',
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
