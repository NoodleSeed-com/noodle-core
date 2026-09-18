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

/** Read-only transport adapter over the same authorized runtime; native interactions are a later slice. */
export async function dispatchMessagingReadTool(input: {
  readonly artifact: RuntimeArtifact;
  readonly tool: RuntimeArtifact['tools'][number];
  readonly arguments: unknown;
  readonly executeDeps: ExecuteDeps;
  readonly context: InvocationContext;
  readonly session: MessagingTurnContext;
  readonly claimTool: (name: string) => Promise<boolean>;
}): Promise<AssistantToolDispatch> {
  const denied = (code: string): AssistantToolDispatch => ({
    kind: 'event',
    event: 'error',
    data: { code, retryable: false },
  });
  if (
    input.tool.annotations?.readOnlyHint !== true ||
    requiresToolConfirmation(input.tool.annotations) ||
    input.tool._meta?.ui
  )
    return denied('messaging_action_unsupported');
  if (!evaluateToolAuthorization(input.tool.authorization, input.session.caller).allow)
    return denied('tool_forbidden');
  if (assistantModelToolOncePerSession(input.tool) && !(await input.claimTool(input.tool.name)))
    return denied('invalid_model_tool_call');
  const result = await executeToolInteractive(input.artifact, input.tool.name, input.arguments, {
    ...withAssistantTurnExecutionAuthority(input.executeDeps, input.artifact, input.session),
    caller: input.session.caller,
    context: input.context,
  });
  if (result.status !== 'completed')
    return denied(result.status === 'failed' ? result.error.code : 'messaging_action_unsupported');
  return {
    kind: 'tool_result',
    output: assistantSafeOutput(input.tool.outputSchema, result.output),
  };
}
