import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  AdmissionGate,
  IntentCaptureMode,
  IntentEventInput,
  RequestEventInput,
  TenantRouteRef,
} from '@noodle-borg/module';
import {
  type ConfirmationNonceLedger,
  createDualEraMcpHandler,
  handleStatelessHttp,
  JSON_RPC,
  type McpProtocolMode,
  type ProtocolObservation,
  type ProtocolRequestContext,
  type RequestStateManager,
  type ServedArtifact,
} from '@noodle-borg/protocol';
import { admissionContexts, requestsInvocationContext } from './admission-context.js';
import type { InvocationContextResolver, OriginPolicy } from './handler.js';
import {
  authorizeIdentityMode,
  authorizeMixedMode,
  authorizePublicServiceMode,
  canonicalResourceUrl,
  type IdentityAuthorizationOptions,
  isIdentityMode,
} from './identity-authorization.js';
import { invocationClientHint } from './invocation-client-hints.js';
import type { Logger } from './logging.js';
import { readBody } from './request-body.js';
import {
  emitDeniedRequestEvent,
  emitIntentEvents,
  emitRequestEvent,
  header,
} from './request-capture.js';
import { admissionRpcError, rpcError, sendJson } from './responses.js';
import {
  type HostedToolAuthorizationObserver,
  preflightServicePrincipalToolCall,
  sendServicePrincipalToolDenial,
} from './service-principal-authorization.js';
import { preflightToolAuthorization, sendToolAuthorizationDenial } from './tool-authorization.js';
import { type HostedToolDispatchHook, withHostedToolDispatch } from './tool-dispatch.js';
import { toWebRequest, writeWebResponse } from './web-bridge.js';
import { widgetDomainProjectionForRequest } from './widget-host.js';

/** Per-request authentication context for one resolved target. */
export interface ServeAuth extends IdentityAuthorizationOptions {
  readonly deploymentId: string | undefined;
  readonly app: string | undefined;
  readonly environment: string | undefined;
  readonly admissionGate: AdmissionGate | undefined;
  readonly captureRequestEvent: ((event: RequestEventInput) => void) | undefined;
  readonly intentCaptureMode: IntentCaptureMode;
  readonly captureIntentEvent: ((event: IntentEventInput) => void) | undefined;
  readonly resolveInvocationContext: InvocationContextResolver | undefined;
  readonly beforeToolDispatch: HostedToolDispatchHook | undefined;
  readonly observeToolAuthorization: HostedToolAuthorizationObserver | undefined;
  readonly oauthClientCredentialsReady: boolean;
  readonly protocolMode: McpProtocolMode;
  readonly requestState: RequestStateManager | undefined;
  readonly confirmationNonceLedger: ConfirmationNonceLedger | undefined;
  readonly logger: Logger;
}

/**
 * The shared, stateless front-door (origin → method → auth → content-type → accept → body) for one resolved
 * tenant. After the guards pass, the parsed JSON-RPC body is handed to the SDK transport, which writes
 * the full response (including `202` for a notification). Path matching is done by the caller.
 */
export async function serveRequest(
  req: IncomingMessage,
  res: ServerResponse,
  target: ServedArtifact,
  auth: ServeAuth,
  routeId: string,
  maxBody: number,
  allowed: OriginPolicy | undefined,
  tenant?: TenantRouteRef,
): Promise<void> {
  const startedAt = Date.now();
  const requestId = randomUUID();
  // Every structured log line for this request carries the analytics correlation id (#1309).
  // Field merge, not `child()`: injected loggers are only guaranteed the four level methods.
  const logger = {
    info: (event: string, fields: Record<string, unknown>): void =>
      auth.logger.info(event, { requestId, ...fields }),
    warn: (event: string, fields: Record<string, unknown>): void =>
      auth.logger.warn(event, { requestId, ...fields }),
  };
  const denied = (errorKind: string, parsedBody?: unknown): void =>
    emitDeniedRequestEvent({
      req,
      auth,
      tenant,
      target,
      ...(parsedBody === undefined ? {} : { parsed: parsedBody }),
      startedAt,
      requestId,
      errorKind,
    });
  const origin = header(req, 'origin');
  if (origin !== undefined && !originAllowed(origin, allowed)) {
    return sendJson(res, 403, rpcError(JSON_RPC.INVALID_REQUEST, 'origin not allowed'));
  }

  if (req.method !== 'POST') {
    // No server-initiated SSE stream this phase: GET/DELETE/other are not allowed.
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, rpcError(JSON_RPC.INVALID_REQUEST, 'method not allowed'));
  }

  // Identity auth gate, before reading the body so an unauthenticated caller never has its payload buffered
  // and the SDK transport is never constructed for it. A missing accessMode is reserved for loopback/local
  // dev targets and remains open.
  let protocolContext: ProtocolRequestContext = {
    ...(auth.oauthClientCredentialsReady ? { oauthClientCredentialsReady: true } : {}),
  };
  let subject: string | undefined;
  if (isIdentityMode(auth.accessMode)) {
    const authResult = await authorizeIdentityMode(req, res, auth);
    if (!authResult.allow) return denied(`auth_denied.${authResult.reason}`);
    if (authResult.caller !== undefined) {
      protocolContext = {
        ...protocolContext,
        caller: authResult.caller,
        ...(authResult.customerIssuer === undefined
          ? {}
          : { customerIssuer: authResult.customerIssuer }),
        ...(authResult.customerRouting === undefined
          ? {}
          : { customerRouting: authResult.customerRouting }),
      };
      subject = authResult.caller.subject;
      res.setHeader('Cache-Control', 'private, no-store');
    } else if (authResult.subject !== undefined) {
      subject = authResult.subject;
    }
  } else if (auth.accessMode === 'mixed') {
    const authResult = await authorizeMixedMode(req, res, auth);
    if (!authResult.allow) return denied(`auth_denied.${authResult.reason}`);
    if (authResult.caller !== undefined) {
      protocolContext = {
        ...protocolContext,
        caller: authResult.caller,
        ...(authResult.customerIssuer === undefined
          ? {}
          : { customerIssuer: authResult.customerIssuer }),
        ...(authResult.customerRouting === undefined
          ? {}
          : { customerRouting: authResult.customerRouting }),
      };
      subject = authResult.caller.subject;
      res.setHeader('Cache-Control', 'private, no-store');
    }
  } else if (auth.accessMode === 'public') {
    const authResult = await authorizePublicServiceMode(req, auth);
    if (!authResult.allow) return;
    if (authResult.caller !== undefined) {
      protocolContext = { ...protocolContext, caller: authResult.caller };
      subject = authResult.caller.subject;
      res.setHeader('Cache-Control', 'private, no-store');
    }
  }

  const body = await readBody(req, maxBody);
  if (!body.ok)
    return sendJson(res, 413, rpcError(JSON_RPC.INVALID_REQUEST, 'request body too large'));

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    return sendJson(res, 400, rpcError(JSON_RPC.PARSE_ERROR, 'invalid JSON'));
  }

  let canonicalMcpUrl: string | undefined;
  try {
    canonicalMcpUrl = canonicalResourceUrl(req, auth);
  } catch {
    canonicalMcpUrl = undefined;
  }
  const widgetDomain = widgetDomainProjectionForRequest(req, parsed, canonicalMcpUrl);
  if (widgetDomain !== undefined) protocolContext = { ...protocolContext, widgetDomain };

  const contexts = admissionContexts(parsed, {
    routeId,
    ...(subject !== undefined ? { subject } : {}),
    ...(tenant !== undefined ? tenant : {}),
    ...(auth.deploymentId !== undefined ? { deploymentId: auth.deploymentId } : {}),
    ...(auth.accessMode !== undefined ? { accessMode: auth.accessMode } : {}),
    ...(req.socket.remoteAddress !== undefined ? { remoteAddress: req.socket.remoteAddress } : {}),
  });
  for (const context of contexts) {
    const decision = auth.admissionGate
      ? await auth.admissionGate(context)
      : ({ allow: true } as const);
    logger.info('mcp.admission', {
      routeId: context.routeId,
      method: context.method,
      category: context.category,
      ...(context.name !== undefined ? { name: context.name } : {}),
      ...(context.org !== undefined ? { org: context.org } : {}),
      ...(context.app !== undefined ? { app: context.app } : {}),
      ...(context.env !== undefined ? { env: context.env } : {}),
      ...(context.serverVersion !== undefined ? { serverVersion: context.serverVersion } : {}),
      ...(context.accessMode !== undefined ? { accessMode: context.accessMode } : {}),
      decision: decision.allow ? 'allow' : 'deny',
      ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
    });
    if (!decision.allow) {
      if (decision.retryAfterSeconds !== undefined) {
        res.setHeader('Retry-After', String(decision.retryAfterSeconds));
      }
      sendJson(res, decision.status ?? 403, admissionRpcError(context, decision));
      return denied(`admission_denied.${boundedReason(decision.reason)}`, parsed);
    }
  }

  const authorization = preflightToolAuthorization(parsed, target, protocolContext.caller);
  for (const observation of authorization.observations) {
    logger.info('mcp.tool_authorization', {
      toolName: observation.toolName,
      decision: observation.decision,
      reason: observation.reason,
      ruleClass: observation.ruleClass,
      ruleFingerprint: observation.ruleFingerprint,
    });
  }
  if (authorization.denial !== undefined) {
    sendToolAuthorizationDenial(req, res, auth, authorization.denial);
    return denied(`auth_denied.${authorization.denial.decision.reason}`, parsed);
  }

  const serviceAuthorization = preflightServicePrincipalToolCall(
    parsed,
    target,
    protocolContext.caller,
  );
  const serviceSubject =
    protocolContext.caller?.identityKind === 'service' ? protocolContext.caller.subject : undefined;
  for (const observation of serviceAuthorization.observations) {
    logger.info('mcp.service_principal_tool_authorization', {
      subject: serviceSubject,
      toolName: observation.toolName,
      decision: observation.decision,
      reason: observation.reason,
      ruleClass: observation.ruleClass,
      ruleFingerprint: observation.ruleFingerprint,
    });
    try {
      if (serviceSubject === undefined) continue;
      await auth.observeToolAuthorization?.({
        ...observation,
        subject: serviceSubject,
        ...(auth.org === undefined ? {} : { org: auth.org }),
        ...(auth.app === undefined ? {} : { app: auth.app }),
        ...(auth.environment === undefined ? {} : { environment: auth.environment }),
        ...(auth.deploymentId === undefined ? {} : { deploymentId: auth.deploymentId }),
      });
    } catch {
      try {
        logger.warn('mcp.tool_authorization.observer_failed', {
          toolName: observation.toolName,
          decision: observation.decision,
        });
      } catch {
        // Authorization observation and its diagnostics never participate in admission.
      }
    }
  }
  if (serviceAuthorization.denial !== undefined) {
    sendServicePrincipalToolDenial(res, serviceAuthorization.denial);
    return denied(`auth_denied.${serviceAuthorization.denial.reason}`, parsed);
  }

  if (auth.resolveInvocationContext !== undefined && requestsInvocationContext(parsed)) {
    const clientHint = invocationClientHint(parsed);
    const invocationContext = await auth.resolveInvocationContext({
      target,
      ...(protocolContext.caller !== undefined ? { caller: protocolContext.caller } : {}),
      ...(clientHint === undefined ? {} : { clientHint }),
    });
    if (invocationContext !== undefined) {
      protocolContext = { ...protocolContext, invocationContext };
    }
  }

  protocolContext = {
    ...protocolContext,
    ...(auth.intentCaptureMode === 'starter-v1' ? { intentCapture: { enabled: true } } : {}),
    ...(auth.deploymentId !== undefined ? { deploymentId: auth.deploymentId } : {}),
    ...(auth.requestState !== undefined ? { requestState: auth.requestState } : {}),
    ...(auth.confirmationNonceLedger !== undefined
      ? { confirmationNonceLedger: auth.confirmationNonceLedger }
      : {}),
  };
  protocolContext = withHostedToolDispatch(req, parsed, protocolContext, auth);

  const observations: ProtocolObservation[] = [];
  if (auth.captureRequestEvent !== undefined || auth.captureIntentEvent !== undefined) {
    protocolContext = {
      ...protocolContext,
      observe: (observation) => {
        observations.push(observation);
      },
    };
  }
  const dispatchedAt = Date.now();
  if (auth.protocolMode === 'legacy-only') {
    await handleStatelessHttp(target, req, res, parsed, protocolContext);
  } else {
    const handler = createDualEraMcpHandler(target, protocolContext);
    try {
      const response = await handler.fetch(toWebRequest(req, body.text), { parsedBody: parsed });
      const frontDoorCacheControl = res.getHeader('cache-control');
      if (frontDoorCacheControl !== undefined) {
        response.headers.set(
          'cache-control',
          Array.isArray(frontDoorCacheControl)
            ? frontDoorCacheControl.join(', ')
            : String(frontDoorCacheControl),
        );
      }
      await writeWebResponse(res, response);
    } finally {
      await handler.close();
    }
  }
  const observed = observations.at(-1);
  emitRequestEvent({
    req,
    res,
    target,
    auth,
    tenant,
    parsed,
    subject,
    observed,
    startedAt,
    requestId,
    timing: { queueMs: dispatchedAt - startedAt, execMs: Date.now() - dispatchedAt },
  });
  emitIntentEvents({ req, target, auth, tenant, parsed, observations, requestId });
}

/** Bound a gate-supplied denial reason into a low-cardinality token for the analytics errorKind. */
function boundedReason(reason: string | undefined): string {
  if (reason === undefined) return 'denied';
  const token = reason
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
  return token.length === 0 ? 'denied' : token;
}

function originAllowed(origin: string, allowed: OriginPolicy | undefined): boolean {
  if (allowed === undefined) return true;
  return typeof allowed === 'function' ? allowed(origin) : allowed.includes(origin);
}
