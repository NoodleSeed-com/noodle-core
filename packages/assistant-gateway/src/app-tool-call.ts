import type { RuntimeArtifact } from '@noodle-borg/compiler';
import { validateJsonSchemaWithDefaults } from '@noodle-borg/compiler';
import { evaluateToolAuthorization } from '@noodle-borg/protocol';
import type { ExecuteDeps } from '@noodle-borg/runtime';
import { resolveInvocationContextSnapshot } from './assistant-context.js';
import { withAssistantSessionExecutionAuthority } from './assistant-customer-routing.js';
import { dispatchAssistantTool } from './assistant-interactive.js';
import type { AssistantSessionRecord } from './assistant-store.js';

/**
 * What one apps-bridge tool call decided, before anything turns it into an HTTP answer.
 *
 * Projection, authorization, argument validation, and dispatch are all this package's already —
 * `dispatchAssistantTool` lives beside this — so the decision belongs here and only the status code
 * belongs to the route. Keeping them apart is also what lets every outcome be recorded in one
 * place: the call used to leave no trace at all, which made `webmcp` a surface label with nothing
 * to put it on.
 */
export type AssistantAppToolCallResult =
  | { readonly kind: 'not-found' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'invalid-arguments' }
  | {
      readonly kind: 'interaction';
      readonly event: string;
      readonly data: Readonly<Record<string, unknown>>;
    }
  | { readonly kind: 'error'; readonly code: string }
  | { readonly kind: 'output'; readonly output: unknown };

export interface AssistantAppToolCallInput {
  readonly artifact: RuntimeArtifact;
  readonly deps: ExecuteDeps;
  readonly session: AssistantSessionRecord;
  readonly toolName: string;
  readonly arguments?: unknown;
  readonly now: () => Date;
  readonly store: Parameters<typeof dispatchAssistantTool>[0]['store'];
  readonly audit: Parameters<typeof dispatchAssistantTool>[0]['audit'];
}

export async function executeAssistantAppToolCall(
  input: AssistantAppToolCallInput,
): Promise<AssistantAppToolCallResult> {
  const { artifact, session } = input;
  const tool: RuntimeArtifact['tools'][number] | undefined = artifact.tools.find(
    (candidate) => candidate.name === input.toolName,
  );
  // The same gate `tools/list` projected with: a tool an app may not see is a tool it may not call.
  if (!tool || tool._meta?.ui?.visibility?.includes('app') === false) return { kind: 'not-found' };
  if (!evaluateToolAuthorization(tool.authorization, session.caller).allow) {
    return { kind: 'forbidden' };
  }
  const executeDeps = withAssistantSessionExecutionAuthority(input.deps, artifact, session);
  // Validated before the snapshot, because resolving it can run the artifact's ambient provider,
  // which is a real fulfilment that may reach the credential broker and an upstream connector.
  // Rejecting bad arguments afterwards would let a malformed call buy one round trip per attempt.
  const validated = validateJsonSchemaWithDefaults(tool.inputSchema, input.arguments ?? {});
  if (validated.issues.length > 0) return { kind: 'invalid-arguments' };
  const context = await resolveInvocationContextSnapshot({
    artifact,
    executeDeps,
    caller: session.caller,
    instant: input.now(),
    ...(session.preferences ? { applicationPreference: session.preferences } : {}),
  });
  const dispatched = await dispatchAssistantTool({
    artifact,
    tool,
    arguments: validated.value,
    executeDeps,
    caller: session.caller,
    context,
    session,
    store: input.store,
    audit: input.audit,
    now: input.now,
  });
  if (dispatched.kind !== 'event') return { kind: 'output', output: dispatched.output };
  if (dispatched.event === 'tool_proposed' || dispatched.event === 'input_requested') {
    return { kind: 'interaction', event: dispatched.event, data: dispatched.data };
  }
  return { kind: 'error', code: String(dispatched.data.code ?? dispatched.event) };
}
