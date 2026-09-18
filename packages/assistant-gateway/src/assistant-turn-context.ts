import type { RuntimeArtifact } from '@noodle-borg/compiler';
import { type ExecuteDeps, freezeCustomerRoutes } from '@noodle-borg/runtime';
import { withAssistantSessionExecutionAuthority } from './assistant-customer-routing.js';
import type { AssistantSessionRecord } from './assistant-store.js';

/** Shared turn identity; a messaging participant deliberately has no browser or customer credentials. */
export interface MessagingTurnContext
  extends Pick<
    AssistantSessionRecord,
    'id' | 'tenant' | 'deploymentId' | 'caller' | 'history' | 'modelToolUses'
  > {
  readonly kind: 'messaging';
  readonly channel: 'whatsapp';
  readonly participantId: string;
  readonly bindingId: string;
}
export type AssistantTurnContext = AssistantSessionRecord | MessagingTurnContext;
export function isMessagingTurn(session: AssistantTurnContext): session is MessagingTurnContext {
  return 'kind' in session && session.kind === 'messaging';
}
export function withAssistantTurnExecutionAuthority(
  deps: ExecuteDeps,
  artifact: Pick<RuntimeArtifact, 'customerEndpoints'>,
  session:
    | Pick<AssistantSessionRecord, 'clientId' | 'customerRouting'>
    | { readonly kind: 'messaging' },
): ExecuteDeps {
  if (!('kind' in session)) return withAssistantSessionExecutionAuthority(deps, artifact, session);
  const { customerIssuer: _issuer, customerRoutes: _routes, ...anonymous } = deps;
  return {
    ...anonymous,
    ...(artifact.customerEndpoints === undefined
      ? {}
      : {
          customerRoutes: freezeCustomerRoutes(artifact.customerEndpoints, undefined),
        }),
  };
}
