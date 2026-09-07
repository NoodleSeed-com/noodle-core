import type { ServerResponse } from 'node:http';
import {
  type ProtocolRequestContext,
  type ServedArtifact,
  TOOL_AUTHORIZATION_DENIED,
  toolRequiresConfirmation,
} from '@noodle-borg/protocol';
import { rpcMethod, rpcTargetName, safeRpcId } from './request-capture.js';

const SERVICE_CONFIRMATION_RULE_CLASS = 'human_confirmation';
const SERVICE_CONFIRMATION_RULE_FINGERPRINT = 'service-confirmation:v1';

export interface ServicePrincipalToolAuthorizationObservation {
  readonly toolName: string;
  readonly decision: 'allow' | 'deny';
  readonly reason: 'allowed' | 'human_confirmation_required';
  readonly ruleClass: typeof SERVICE_CONFIRMATION_RULE_CLASS;
  readonly ruleFingerprint: typeof SERVICE_CONFIRMATION_RULE_FINGERPRINT;
}

export interface HostedToolAuthorizationObservation
  extends ServicePrincipalToolAuthorizationObservation {
  readonly subject: string;
  readonly org?: string;
  readonly app?: string;
  readonly environment?: string;
  readonly deploymentId?: string;
}

export type HostedToolAuthorizationObserver = (
  observation: HostedToolAuthorizationObservation,
) => void | Promise<void>;

interface ServicePrincipalToolDenial {
  readonly requestId: string | number | null;
  readonly reason: 'human_confirmation_required';
}

/** Deny service principals from entering a confirmation flow that requires a live human decision. */
export function preflightServicePrincipalToolCall(
  parsed: unknown,
  target: ServedArtifact,
  caller: ProtocolRequestContext['caller'],
): {
  readonly observations: readonly ServicePrincipalToolAuthorizationObservation[];
  readonly denial?: ServicePrincipalToolDenial;
} {
  if (caller?.identityKind !== 'service') return { observations: [] };
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const observations: ServicePrincipalToolAuthorizationObservation[] = [];
  let denial: ServicePrincipalToolDenial | undefined;
  for (const item of items) {
    const method = rpcMethod(item);
    if (method !== 'tools/call') continue;
    const toolName = rpcTargetName(item, method);
    if (toolName === undefined) continue;
    const tool = target.artifact.tools.find((candidate) => candidate.name === toolName);
    if (tool === undefined) continue;
    const confirmationRequired = toolRequiresConfirmation(tool);
    observations.push({
      toolName,
      decision: confirmationRequired ? 'deny' : 'allow',
      reason: confirmationRequired ? 'human_confirmation_required' : 'allowed',
      ruleClass: SERVICE_CONFIRMATION_RULE_CLASS,
      ruleFingerprint: SERVICE_CONFIRMATION_RULE_FINGERPRINT,
    });
    if (confirmationRequired && denial === undefined) {
      denial = {
        requestId: safeRpcId(item).requestId ?? null,
        reason: 'human_confirmation_required',
      };
    }
  }
  return { observations, ...(denial === undefined ? {} : { denial }) };
}

export function sendServicePrincipalToolDenial(
  res: ServerResponse,
  denial: ServicePrincipalToolDenial,
): void {
  res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      id: denial.requestId,
      error: {
        code: TOOL_AUTHORIZATION_DENIED,
        message: 'human confirmation required',
        data: { reason: denial.reason },
      },
    }),
  );
}
