import { randomUUID } from 'node:crypto';
import {
  fromJsonSchema,
  type InputRequiredResult,
  inputRequired,
} from '@modelcontextprotocol/server';
import type { RuntimeArtifact } from '@noodle-borg/compiler';
import type { ElicitationResponse } from '@noodle-borg/runtime';
import {
  digestMcpArguments,
  type RequestStateBinding,
  RequestStateError,
  type RequestStateManager,
  type SealedRequestState,
} from '../request-state.js';
import type { ProtocolRequestContext } from '../sdk-server.js';
import type { McpToolInteractionOutcome } from '../tool-interaction.js';

const REQUEST_STATE_TTL_MS = 5 * 60_000;

export function toolRequestStateBinding(
  artifact: RuntimeArtifact,
  context: ProtocolRequestContext,
  toolName: string,
  toolArguments: unknown,
  executionRevision?: string,
): RequestStateBinding {
  return {
    deploymentId: context.deploymentId ?? `local:${artifact.server.name}`,
    serverVersion: artifact.server.version,
    method: 'tools/call',
    target: toolName,
    principal: requestStatePrincipal(context),
    argumentDigest: digestMcpArguments(toolArguments),
    ...(executionRevision === undefined ? {} : { executionRevision }),
  };
}

function requestStatePrincipal(context: ProtocolRequestContext): string {
  const caller = context.caller;
  if (caller === undefined) return JSON.stringify(['anonymous']);
  // An explicit anonymous principal (a public website assistant visitor) carries an opaque subject.
  // It gets its own namespace: falling through to `platform` below would let it share request state
  // with a platform user of the same subject string.
  if (caller.identityKind === 'anonymous') return JSON.stringify(['anonymous', caller.subject]);
  if (caller.identityKind === 'service') {
    if (context.customerIssuer !== undefined) throw new RequestStateError();
    return JSON.stringify(['service', caller.subject]);
  }
  if (caller.identityKind === 'customer' || context.customerIssuer !== undefined) {
    if (context.customerIssuer === undefined) throw new RequestStateError();
    return JSON.stringify(['customer', context.customerIssuer, caller.subject]);
  }
  return JSON.stringify(['platform', caller.subject]);
}

export function mergeInputResponses(
  prior: SealedRequestState | undefined,
  current: Record<string, unknown> | undefined,
  droppedKeys: readonly string[] | undefined,
): {
  readonly responses: Readonly<Record<string, ElicitationResponse>>;
  readonly reissueDropped: boolean;
} {
  if (prior === undefined) return { responses: {}, reissueDropped: false };
  const entries = Object.entries(current ?? {});
  const dropped = droppedKeys ?? [];
  const pendingId = prior.pendingRequest.id;
  if (
    entries.length === 0 &&
    dropped.length === 1 &&
    dropped[0] === pendingId &&
    !Object.hasOwn(prior.responses, pendingId)
  ) {
    return { responses: prior.responses, reissueDropped: true };
  }
  if (dropped.length > 0) {
    throw new RequestStateError('unexpected_input_response_key');
  }
  if (
    entries.length !== 1 ||
    entries[0]?.[0] !== pendingId ||
    Object.hasOwn(prior.responses, pendingId)
  ) {
    throw new RequestStateError('unexpected_input_response_key');
  }
  const [key, value] = entries[0];
  if (
    !isRecord(value) ||
    (value.action !== 'accept' && value.action !== 'decline' && value.action !== 'cancel')
  ) {
    throw new RequestStateError('invalid_input_response_shape');
  }
  return {
    responses: {
      ...prior.responses,
      [key]: {
        action: value.action,
        ...(value.content === undefined ? {} : { content: value.content }),
      },
    },
    reissueDropped: false,
  };
}

export async function inputRequiredForTool(
  manager: RequestStateManager,
  binding: RequestStateBinding,
  result: Extract<McpToolInteractionOutcome, { status: 'interaction_unavailable' }>,
  responses: Readonly<Record<string, ElicitationResponse>>,
  prior: SealedRequestState | undefined,
): Promise<InputRequiredResult> {
  if (result.request === undefined) {
    throw new Error('modern input-required mapping needs an explicit input request');
  }
  const round = (prior?.round ?? 0) + 1;
  const requestState = await manager.seal({
    binding,
    responses,
    round,
    expiresAt: prior?.expiresAt ?? Date.now() + REQUEST_STATE_TTL_MS,
    nonce: prior?.nonce ?? randomUUID(),
    pendingRequest: {
      id: result.request.id,
      interaction: result.interaction,
    },
    ...(result.interaction === 'confirmation' ? { confirmation: true as const } : {}),
  });
  return inputRequired({
    inputRequests: {
      [result.request.id]: inputRequired.elicit({
        message: result.request.message,
        requestedSchema: fromJsonSchema(result.request.requestedSchema),
      }),
    },
    requestState,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
