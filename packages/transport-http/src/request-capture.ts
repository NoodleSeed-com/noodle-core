import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AccessMode, IntentEventInput, RequestEventInput } from '@noodle-borg/module';
import type { ProtocolObservation, ServedArtifact } from '@noodle-borg/protocol';
import {
  boundedClientName,
  boundedClientVersion,
  clientFamily,
  SessionClientMemo,
  sessionClientKey,
} from './client-identity.js';

/**
 * Analytics request-event composition for the transport (ADR 0121), extracted from `handler.ts`
 * along its natural seam: everything here is the "compose one scalar-only event per served request"
 * concern, plus the small safe JSON-RPC extraction helpers it shares with the admission path.
 */

/** The slice of the per-request auth context the capture path needs (structurally: `ServeAuth`). */
interface CaptureAuth {
  readonly captureRequestEvent: ((event: RequestEventInput) => void) | undefined;
  readonly captureIntentEvent: ((event: IntentEventInput) => void) | undefined;
  readonly org: string | undefined;
  readonly app: string | undefined;
  readonly environment: string | undefined;
  readonly accessMode: AccessMode | undefined;
  readonly deploymentId: string | undefined;
}

/** The tenant route slice the capture path needs (structurally: `TenantRouteRef`). */
interface CaptureTenant {
  readonly org: string;
  readonly app: string;
  readonly env: string;
  readonly serverVersion?: string;
}

/**
 * Best-effort per-process memo from a legacy analytics session id to its `initialize` clientInfo, so
 * legacy tool calls keep client attribution when the client supplies `Mcp-Session-Id` (#1309).
 */
let sessionClientMemo = new SessionClientMemo();

/** Test seam: drop all memoized session client identities. */
export function resetSessionClientMemo(): void {
  sessionClientMemo = new SessionClientMemo();
}

/** JSON-RPC methods that are protocol discovery/chatter, excluded from usage metrics (ADR 0121). */
const DISCOVERY_METHODS = new Set([
  'initialize',
  'server/discover',
  'tools/list',
  'skills/list',
  'resources/list',
  'resources/templates/list',
  'prompts/list',
  'ping',
  'notifications/initialized',
]);

/**
 * Compose and fire one analytics {@link RequestEventInput} for a served request (ADR 0121). Tenant
 * identity comes from the route/auth, the two-tier outcome from the protocol observation when present
 * (falling back to the HTTP status), and client identity from the `initialize` params. Strictly
 * best-effort: no capture hook, no tenant org, or a throwing hook all no-op.
 */
export function emitRequestEvent(input: {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly target: ServedArtifact;
  readonly auth: CaptureAuth;
  readonly tenant: CaptureTenant | undefined;
  readonly parsed: unknown;
  readonly subject: string | undefined;
  readonly observed: ProtocolObservation | undefined;
  readonly startedAt: number;
  readonly requestId: string;
  /** Front-door wait vs protocol execution split measured by the caller (#1309). */
  readonly timing?: { readonly queueMs?: number; readonly execMs?: number };
}): void {
  const { req, res, target, auth, tenant, parsed, subject, observed, startedAt, requestId } = input;
  const capture = auth.captureRequestEvent;
  if (capture === undefined) return;
  const org = tenant?.org ?? auth.org;
  if (org === undefined) return; // single/local dev target: nothing to attribute

  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  const method = observed?.method ?? rpcMethod(first);
  const init = method === 'initialize' ? initializeInfo(first) : undefined;
  const modern = modernRequestInfo(first);
  const protocolEra = modern === undefined ? 'legacy' : 'modern';
  const sessionId = modern === undefined ? header(req, 'mcp-session-id') : undefined;
  const sdkProtocolVersion =
    modern?.protocolVersion ?? header(req, 'mcp-protocol-version') ?? init?.protocolVersion;
  const failed = res.statusCode >= 400;
  const toolName =
    observed?.toolName ?? (method === 'tools/call' ? rpcTargetName(first, method) : undefined);
  const errorKind = observed?.errorKind ?? (failed ? `http_${res.statusCode}` : undefined);

  // Client identity: the request's own clientInfo wins; a legacy request that supplies a session id
  // falls back to the identity memoized from that session's `initialize` (#1309). Values are bounded.
  let clientName = boundedClientName(modern?.clientName ?? init?.clientName);
  let clientVersion = boundedClientVersion(modern?.clientVersion ?? init?.clientVersion);
  if (sessionId !== undefined) {
    const key = sessionClientKey(
      org,
      tenant?.app ?? auth.app,
      tenant?.env ?? auth.environment,
      sessionId,
    );
    if (method === 'initialize' && clientName !== undefined) {
      sessionClientMemo.remember(key, {
        clientName,
        ...(clientVersion === undefined ? {} : { clientVersion }),
      });
    } else if (clientName === undefined) {
      const recalled = sessionClientMemo.recall(key);
      clientName = recalled?.clientName;
      clientVersion ??= recalled?.clientVersion;
    }
  }
  const family = clientFamily(clientName, header(req, 'user-agent'));

  const event: RequestEventInput = {
    org,
    ...(tenant !== undefined ? { app: tenant.app, env: tenant.env } : {}),
    ...(auth.deploymentId !== undefined ? { deploymentId: auth.deploymentId } : {}),
    serverVersion: target.artifact.server.version,
    ...(sdkProtocolVersion !== undefined ? { sdkProtocolVersion } : {}),
    protocolEra,
    requestId,
    ...(sessionId !== undefined ? { sessionId } : {}),
    sessionSource: sessionId !== undefined ? 'mcp' : 'none',
    ...(clientName !== undefined ? { clientName } : {}),
    ...(clientVersion !== undefined ? { clientVersion } : {}),
    clientFamily: family,
    ...(auth.accessMode !== undefined ? { accessMode: auth.accessMode } : {}),
    surface: 'mcp',
    subjectKind: subject !== undefined ? 'authenticated' : 'anonymous',
    method,
    kind: DISCOVERY_METHODS.has(method) ? 'discovery' : 'usage',
    ...(toolName !== undefined ? { toolName } : {}),
    ...(observed?.resourceName !== undefined ? { resourceName: observed.resourceName } : {}),
    ...(observed?.promptName !== undefined ? { promptName: observed.promptName } : {}),
    outcome: observed?.outcome ?? (failed ? 'mcp_error' : 'ok'),
    ...(errorKind !== undefined ? { errorKind } : {}),
    durationMs: Date.now() - startedAt,
    ...(input.timing?.queueMs !== undefined ? { queueMs: input.timing.queueMs } : {}),
    ...(input.timing?.execMs !== undefined ? { execMs: input.timing.execMs } : {}),
    ...(observed?.outputTokensEst !== undefined
      ? { outputTokensEst: observed.outputTokensEst }
      : {}),
    ...connectorDetails(observed),
  };
  try {
    capture(event);
  } catch {
    // Analytics is strictly best-effort; a capture bug must never surface to the caller.
  }
}

/** Project the observation's safe connector attribution into the scalar-only `details` bag. */
function connectorDetails(
  observed: ProtocolObservation | undefined,
): Pick<RequestEventInput, 'details'> {
  const connector = observed?.connector;
  if (connector === undefined) return {};
  return {
    details: {
      connectorId: connector.connectorId,
      connectorVersion: connector.connectorVersion,
      connectorOperation: connector.operation,
      ...(connector.category !== undefined ? { connectorCategory: connector.category } : {}),
      ...(connector.statusClass !== undefined
        ? { connectorStatusClass: connector.statusClass }
        : {}),
      ...(connector.attempts !== undefined ? { connectorAttempts: connector.attempts } : {}),
      ...(connector.retryable !== undefined ? { connectorRetryable: connector.retryable } : {}),
    },
  };
}

/**
 * Reason a front-door denial (identity auth, admission, tool authorization) was sent before any
 * protocol handler ran. Bounded reason tokens compose the analytics `errorKind` (#1309).
 */
export function emitDeniedRequestEvent(input: {
  readonly req: IncomingMessage;
  readonly auth: CaptureAuth;
  readonly tenant: CaptureTenant | undefined;
  readonly target: ServedArtifact;
  /** `undefined` when the denial happened before the body was read (identity auth). */
  readonly parsed?: unknown;
  readonly startedAt: number;
  readonly requestId: string;
  readonly errorKind: string;
}): void {
  const { req, auth, tenant, target, parsed, startedAt, requestId, errorKind } = input;
  const capture = auth.captureRequestEvent;
  if (capture === undefined) return;
  const org = tenant?.org ?? auth.org;
  if (org === undefined) return;

  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  const method = first === undefined ? 'unknown' : rpcMethod(first);
  const toolName = method === 'tools/call' ? rpcTargetName(first, method) : undefined;
  const modern = modernRequestInfo(first);
  const sdkProtocolVersion = modern?.protocolVersion ?? header(req, 'mcp-protocol-version');
  const event: RequestEventInput = {
    org,
    ...(tenant !== undefined ? { app: tenant.app, env: tenant.env } : {}),
    ...(auth.deploymentId !== undefined ? { deploymentId: auth.deploymentId } : {}),
    serverVersion: target.artifact.server.version,
    ...(sdkProtocolVersion !== undefined ? { sdkProtocolVersion } : {}),
    ...(first !== undefined ? { protocolEra: modern === undefined ? 'legacy' : 'modern' } : {}),
    requestId,
    sessionSource: 'none',
    clientFamily: clientFamily(undefined, header(req, 'user-agent')),
    ...(auth.accessMode !== undefined ? { accessMode: auth.accessMode } : {}),
    surface: 'mcp',
    subjectKind: 'anonymous',
    method,
    kind: 'usage',
    ...(toolName !== undefined ? { toolName } : {}),
    outcome: 'mcp_error',
    errorKind,
    durationMs: Date.now() - startedAt,
  };
  try {
    capture(event);
  } catch {
    // Analytics is strictly best-effort.
  }
}

/** Emit validated intent observations into their separate operator stream. */
export function emitIntentEvents(input: {
  readonly req: IncomingMessage;
  readonly target: ServedArtifact;
  readonly auth: CaptureAuth;
  readonly tenant: CaptureTenant | undefined;
  readonly parsed: unknown;
  readonly observations: readonly ProtocolObservation[];
  readonly requestId: string;
}): void {
  const { req, target, auth, tenant, parsed, observations, requestId } = input;
  const capture = auth.captureIntentEvent;
  const org = tenant?.org ?? auth.org;
  const app = tenant?.app ?? auth.app;
  const env = tenant?.env ?? auth.environment;
  if (capture === undefined || org === undefined || app === undefined || env === undefined) return;

  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  const init = initializeInfo(first);
  const modern = modernRequestInfo(first);
  const sdkProtocolVersion =
    modern?.protocolVersion ?? header(req, 'mcp-protocol-version') ?? init.protocolVersion;
  for (const observation of observations) {
    if (observation.intent === undefined || observation.toolName === undefined) continue;
    const event: IntentEventInput = {
      org,
      app,
      env,
      ...(auth.deploymentId === undefined ? {} : { deploymentId: auth.deploymentId }),
      serverVersion: target.artifact.server.version,
      ...(sdkProtocolVersion === undefined ? {} : { sdkProtocolVersion }),
      protocolEra: modern === undefined ? 'legacy' : 'modern',
      requestId,
      ...(modern?.clientName !== undefined
        ? { clientName: modern.clientName }
        : init.clientName !== undefined
          ? { clientName: init.clientName }
          : {}),
      ...(modern?.clientVersion !== undefined
        ? { clientVersion: modern.clientVersion }
        : init.clientVersion !== undefined
          ? { clientVersion: init.clientVersion }
          : {}),
      toolName: observation.toolName,
      outcome: observation.outcome,
      ...(observation.errorKind === undefined ? {} : { errorKind: observation.errorKind }),
      ...observation.intent,
      source: 'tool_schema',
    };
    try {
      capture(event);
    } catch {
      // Intent analytics is strictly best-effort.
    }
  }
}

function modernRequestInfo(value: unknown):
  | {
      readonly protocolVersion: string;
      readonly clientName?: string;
      readonly clientVersion?: string;
    }
  | undefined {
  if (!isRecord(value) || !isRecord(value.params) || !isRecord(value.params._meta)) {
    return undefined;
  }
  const meta = value.params._meta;
  const protocolVersion = meta['io.modelcontextprotocol/protocolVersion'];
  if (typeof protocolVersion !== 'string') return undefined;
  const clientInfo = meta['io.modelcontextprotocol/clientInfo'];
  return {
    protocolVersion,
    ...(isRecord(clientInfo) && typeof clientInfo.name === 'string'
      ? { clientName: clientInfo.name }
      : {}),
    ...(isRecord(clientInfo) && typeof clientInfo.version === 'string'
      ? { clientVersion: clientInfo.version }
      : {}),
  };
}

/** Safely pull `clientInfo` + `protocolVersion` out of an `initialize` request's params. */
function initializeInfo(value: unknown): {
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly protocolVersion?: string;
} {
  if (typeof value !== 'object' || value === null) return {};
  const params = (value as { readonly params?: unknown }).params;
  if (typeof params !== 'object' || params === null) return {};
  const { clientInfo, protocolVersion } = params as {
    readonly clientInfo?: unknown;
    readonly protocolVersion?: unknown;
  };
  const info =
    typeof clientInfo === 'object' && clientInfo !== null
      ? (clientInfo as { readonly name?: unknown; readonly version?: unknown })
      : undefined;
  return {
    ...(typeof info?.name === 'string' ? { clientName: info.name } : {}),
    ...(typeof info?.version === 'string' ? { clientVersion: info.version } : {}),
    ...(typeof protocolVersion === 'string' ? { protocolVersion } : {}),
  };
}

/** Safe JSON-RPC field extraction, shared by the admission and capture paths. */
export function rpcMethod(value: unknown): string {
  if (typeof value !== 'object' || value === null) return 'unknown';
  const method = (value as { readonly method?: unknown }).method;
  return typeof method === 'string' ? method : 'unknown';
}

export function rpcTargetName(value: unknown, method: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const params = (value as { readonly params?: unknown }).params;
  if (typeof params !== 'object' || params === null) return undefined;
  const name = (params as { readonly name?: unknown; readonly uri?: unknown }).name;
  if (typeof name === 'string') return name;
  const uri = (params as { readonly uri?: unknown }).uri;
  return typeof uri === 'string' && (method.startsWith('resources/') || method === 'skills/get')
    ? uri
    : undefined;
}

export function safeRpcId(value: unknown): { readonly requestId?: string | number | null } {
  if (typeof value !== 'object' || value === null) return {};
  if (!Object.hasOwn(value, 'id')) return {};
  const id = (value as { readonly id?: unknown }).id;
  if (typeof id === 'string' || typeof id === 'number' || id === null) return { requestId: id };
  return {};
}

/** First value of a (possibly repeated) request header. */
export function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
