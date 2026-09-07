import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  evaluateToolAuthorization,
  type ProtocolRequestContext,
  type ServedArtifact,
  TOOL_AUTHORIZATION_DENIED,
  type ToolAuthorizationDecision,
  type ToolAuthorizationRuleClass,
  toolAuthorizationRuleClass,
  toolAuthorizationRuleFingerprint,
} from '@noodle-borg/protocol';
import {
  type IdentityAuthorizationOptions,
  protectedResourceMetadataUrl,
} from './identity-authorization.js';
import { rpcMethod, rpcTargetName, safeRpcId } from './request-capture.js';

export interface ToolAuthorizationObservation {
  readonly toolName: string;
  readonly decision: 'allow' | 'deny';
  readonly reason: 'allowed' | Exclude<ToolAuthorizationDecision, { allow: true }>['reason'];
  readonly ruleClass: ToolAuthorizationRuleClass;
  readonly ruleFingerprint: string;
}

interface ToolAuthorizationDenial {
  readonly requestId: string | number | null;
  readonly decision: Exclude<ToolAuthorizationDecision, { allow: true }>;
}

export function preflightToolAuthorization(
  parsed: unknown,
  target: ServedArtifact,
  caller: ProtocolRequestContext['caller'],
): {
  readonly observations: readonly ToolAuthorizationObservation[];
  readonly denial?: ToolAuthorizationDenial;
} {
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const observations: ToolAuthorizationObservation[] = [];
  let denial: ToolAuthorizationDenial | undefined;
  for (const item of items) {
    const method = rpcMethod(item);
    if (method !== 'tools/call') continue;
    const toolName = rpcTargetName(item, method);
    if (toolName === undefined) continue;
    const tool = target.artifact.tools.find((candidate) => candidate.name === toolName);
    if (tool === undefined) continue;
    const decision = evaluateToolAuthorization(tool.authorization, caller);
    observations.push({
      toolName,
      decision: decision.allow ? 'allow' : 'deny',
      reason: decision.allow ? 'allowed' : decision.reason,
      ruleClass: toolAuthorizationRuleClass(tool.authorization),
      ruleFingerprint: toolAuthorizationRuleFingerprint(tool.authorization),
    });
    if (!decision.allow && denial === undefined) {
      denial = {
        requestId: safeRpcId(item).requestId ?? null,
        decision,
      };
    }
  }
  return {
    observations,
    ...(denial === undefined ? {} : { denial }),
  };
}

export function sendToolAuthorizationDenial(
  req: IncomingMessage,
  res: ServerResponse,
  auth: IdentityAuthorizationOptions,
  denial: ToolAuthorizationDenial,
): void {
  const metadata = protectedResourceMetadataUrl(req, auth);
  if (denial.decision.reason === 'authentication_required') {
    res.setHeader('WWW-Authenticate', `Bearer realm="noodle", resource_metadata="${metadata}"`);
    sendError(res, 401, denial.requestId, 'unauthorized', denial.decision.reason);
    return;
  }
  if (denial.decision.reason === 'insufficient_scope') {
    res.setHeader(
      'WWW-Authenticate',
      `Bearer error="insufficient_scope", scope="${denial.decision.requiredScopes.join(
        ' ',
      )}", resource_metadata="${metadata}"`,
    );
    sendError(res, 403, denial.requestId, 'insufficient scope', denial.decision.reason);
    return;
  }
  sendError(res, 403, denial.requestId, 'forbidden', denial.decision.reason);
}

function sendError(
  res: ServerResponse,
  status: 401 | 403,
  requestId: string | number | null,
  message: string,
  reason: Exclude<ToolAuthorizationDecision, { allow: true }>['reason'],
): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      id: requestId,
      error: {
        code: TOOL_AUTHORIZATION_DENIED,
        message,
        data: { reason },
      },
    }),
  );
}
