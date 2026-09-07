import { ProtocolError } from '@modelcontextprotocol/server';
import type { RuntimeArtifact } from '@noodle-borg/compiler';
import {
  type ElicitationResponse,
  type ExecuteToolDeps,
  executePreparedTool,
  prepareToolForConfirmation,
  resumeToolPreparation,
} from '@noodle-borg/runtime';
import {
  confirmationElicitationRequest,
  isAffirmativeConfirmation,
} from '../confirmation-elicitation.js';
import { toolRequiresConfirmation } from '../tool-confirmation.js';
import type { McpToolInteractionOutcome } from '../tool-interaction.js';

const CONFIRMATION_RESPONSE_ID = '__noodle_confirmation';
type ArtifactTool = RuntimeArtifact['tools'][number];

export function toolRequiresModernConfirmation(tool: ArtifactTool | undefined): boolean {
  return toolRequiresConfirmation(tool);
}

/** Reprepare the exact action on every round; only answers cross the wire, never the continuation. */
export async function runModernConfirmedTool(input: {
  readonly artifact: RuntimeArtifact;
  readonly tool: ArtifactTool;
  readonly toolName: string;
  readonly toolArguments: unknown;
  readonly deps: ExecuteToolDeps;
  readonly responses: Readonly<Record<string, ElicitationResponse>>;
}): Promise<McpToolInteractionOutcome> {
  let preparation = await prepareToolForConfirmation(
    input.artifact,
    input.toolName,
    input.toolArguments,
    input.deps,
  );
  while (preparation.status === 'input_required') {
    const response = input.responses[preparation.request.id];
    if (response === undefined) {
      return {
        status: 'interaction_unavailable',
        interaction: 'input',
        request: preparation.request,
        responses: input.responses,
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

  const confirmation = confirmationElicitationRequest(input.tool, preparation.review);
  if (!confirmation.ok) {
    throw new ProtocolError(
      -32603,
      'the prepared action cannot be shown completely and was not executed',
    );
  }
  const response = input.responses[CONFIRMATION_RESPONSE_ID];
  if (response === undefined) {
    return {
      status: 'interaction_unavailable',
      interaction: 'confirmation',
      request: {
        id: CONFIRMATION_RESPONSE_ID,
        message: confirmation.request.message,
        requestedSchema: confirmation.request.requestedSchema,
      },
      responses: input.responses,
    };
  }
  if (response.action !== 'accept') {
    return { status: 'stopped', action: response.action, source: 'confirmation' };
  }
  if (!isAffirmativeConfirmation(response)) {
    return { status: 'stopped', action: 'decline', source: 'confirmation' };
  }

  const result = await executePreparedTool(input.artifact, preparation.continuation, input.deps);
  if (result.status === 'input_required') {
    throw new ProtocolError(-32603, 'the prepared action reached an unexpected input boundary');
  }
  return result.status === 'stopped' ? { ...result, source: 'input' } : result;
}
