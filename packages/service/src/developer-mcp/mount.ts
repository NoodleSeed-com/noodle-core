import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { bearerToken, type ControlPlaneIdentity } from '@noodle-borg/control-plane/portable';
import {
  createDeveloperMcpServer,
  DEVELOPER_MCP_PATH,
  type DeveloperMcpContext,
  developerMcpContextSchema,
  environmentNameSchema,
  tenantSlugSchema,
} from '@noodle-borg/developer-mcp';
import type { RequestEventStore } from '@noodle-borg/module';
import { createPlatformDualEraMcpHandler, type McpProtocolMode } from '@noodle-borg/protocol';
import {
  applySecurityHeaders,
  enforceHttps,
  type Logger,
  type OwnerTokenVerifier,
  readJsonBody,
  sendJson,
  type TlsPosture,
  toWebRequest,
  writeWebResponse,
} from '@noodle-borg/transport-http';
import { activeDeveloperGrantForIdentity } from '../auth/developer-grant-guard.js';
import { baseFromRequest, normalizeServiceBase } from '../http-util.js';
import type { DeveloperGrantStore } from '../oauth/developer-grant.js';
import type { ServerRegistry } from '../registry.js';
import type { AuditSink } from '../store/audit.js';
import type { UserAppLogStore } from '../store/user-app-logs.js';
import type { ControlPlaneStore } from '../store.js';
import { ServiceDeveloperControlPlane } from './control-plane-adapter.js';

export { DEVELOPER_MCP_PATH };

const DEVELOPER_MCP_SCOPES = ['cloud:read'] as const;

export interface DeveloperMcpMountOptions {
  readonly registry: ServerRegistry;
  readonly controlPlane: ControlPlaneStore;
  readonly grants?: DeveloperGrantStore;
  readonly verifyOwnerToken?: OwnerTokenVerifier;
  readonly logs?: UserAppLogStore;
  readonly requestEvents?: RequestEventStore;
  readonly audit: AuditSink;
  readonly logger: Logger;
  readonly tls: TlsPosture;
  readonly maxBody: number;
  readonly protocolMode: McpProtocolMode;
  readonly publicBaseUrl?: string;
  readonly publicBaseDomain?: string;
  readonly now?: () => Date;
}

export function developerMcpResource(
  req: IncomingMessage,
  options: DeveloperMcpMountOptions,
): string {
  const base = normalizeServiceBase(options.publicBaseUrl ?? baseFromRequest(req, options.tls));
  return `${base}${DEVELOPER_MCP_PATH}`;
}

export function developerMcpScopes(): readonly string[] {
  return DEVELOPER_MCP_SCOPES;
}

export async function handleDeveloperMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: DeveloperMcpMountOptions,
): Promise<void> {
  const startedAt = Date.now();
  const requestId = boundedHeader(req.headers['x-request-id']) ?? randomUUID();
  applySecurityHeaders(res, options.tls);
  if (enforceHttps(req, res, options.tls)) return;

  const resource = developerMcpResource(req, options);
  if (!originAllowed(req, resource)) {
    sendJson(res, 403, { error: 'forbidden origin' });
    return;
  }

  const token = bearerToken(req);
  if (token === null) {
    sendChallenge(res, resource);
    return;
  }
  if (
    options.verifyOwnerToken === undefined ||
    options.grants === undefined ||
    options.logs === undefined ||
    options.requestEvents === undefined
  ) {
    sendJson(res, 503, { error: 'developer MCP is unavailable' });
    return;
  }
  const logs = options.logs;
  const requestEvents = options.requestEvents;

  const verified = await verifyToken(options.verifyOwnerToken, token, resource);
  if (verified === null) {
    sendChallenge(res, resource);
    return;
  }
  const identity = developerIdentity(verified);
  if (identity === undefined) {
    sendJson(res, 403, { error: 'developer access grant is required' });
    return;
  }
  const grant = await activeDeveloperGrantForIdentity(identity, options.grants, { resource });
  if (grant === undefined) {
    sendJson(res, 403, { error: 'developer access grant is not active' });
    return;
  }
  if (!grant.capabilities.includes('cloud:read')) {
    sendJson(res, 403, { error: 'developer access grant does not allow cloud reads' });
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendJson(res, 405, { error: 'stateless developer MCP accepts POST requests only' });
    await observeRequest(options, requestId, grantContext(identity, grant), 405, startedAt);
    return;
  }

  const body = await readJsonBody(req, options.maxBody);
  if (!body.ok) {
    sendJson(res, body.status, { error: body.error });
    await observeRequest(options, requestId, grantContext(identity, grant), body.status, startedAt);
    return;
  }
  const parsedBody = body.value;
  const context = grantContext(identity, grant);
  let toolOutcome: { readonly decision: 'allow' | 'deny'; readonly errorCode?: string } | undefined;
  const handler = createPlatformDualEraMcpHandler(
    () =>
      createDeveloperMcpServer({
        context,
        controlPlane: new ServiceDeveloperControlPlane({
          registry: options.registry,
          logs,
          requestEvents,
          controlPlane: options.controlPlane,
          audit: options.audit,
          publicBaseUrl: normalizeServiceBase(
            options.publicBaseUrl ?? baseFromRequest(req, options.tls),
          ),
          ...(options.publicBaseDomain === undefined
            ? {}
            : { publicBaseDomain: options.publicBaseDomain }),
          ...(options.now === undefined ? {} : { now: options.now }),
        }),
        ...(options.now === undefined
          ? {}
          : { observedAt: () => options.now?.().toISOString() ?? '' }),
        onToolResult: (outcome) => {
          toolOutcome = {
            decision: outcome.decision,
            ...(outcome.errorCode === undefined ? {} : { errorCode: outcome.errorCode }),
          };
        },
      }),
    { protocolMode: options.protocolMode },
  );

  try {
    const response = await handler.fetch(toWebRequest(req, JSON.stringify(parsedBody)), {
      parsedBody,
    });
    await writeWebResponse(res, response);
  } catch {
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
  } finally {
    await handler.close().catch(() => undefined);
    await observeRequest(
      options,
      requestId,
      context,
      res.statusCode,
      startedAt,
      requestDetails(parsedBody, req),
      toolOutcome,
    );
  }
}

async function verifyToken(
  verifier: OwnerTokenVerifier,
  token: string,
  resource: string,
): Promise<Awaited<ReturnType<OwnerTokenVerifier>>> {
  try {
    return await verifier(token, resource);
  } catch {
    return null;
  }
}

function developerIdentity(
  verified: NonNullable<Awaited<ReturnType<OwnerTokenVerifier>>>,
): ControlPlaneIdentity | undefined {
  const { caller } = verified;
  if (caller.developerGrantId === undefined || caller.oauthClientId === undefined) return undefined;
  return {
    subject: caller.subject,
    email: caller.email ?? '',
    superAdmin: false,
    developerGrantId: caller.developerGrantId,
    oauthClientId: caller.oauthClientId,
  };
}

function grantContext(
  identity: ControlPlaneIdentity,
  grant: NonNullable<Awaited<ReturnType<DeveloperGrantStore['get']>>>,
): DeveloperMcpContext {
  return developerMcpContextSchema.parse({
    subject: identity.subject,
    clientId: grant.clientId,
    grantId: grant.id,
    resource: grant.resource,
    capabilities: [...grant.capabilities],
  });
}

function originAllowed(req: IncomingMessage, resource: string): boolean {
  const origin = req.headers.origin;
  return (
    origin === undefined || (typeof origin === 'string' && origin === new URL(resource).origin)
  );
}

function sendChallenge(res: ServerResponse, resource: string): void {
  const resourceUrl = new URL(resource);
  const metadata = `${resourceUrl.origin}/.well-known/oauth-protected-resource${resourceUrl.pathname}`;
  res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${metadata}"`);
  sendJson(res, 401, { error: 'unauthorized' });
}

function boundedHeader(value: string | readonly string[] | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 200 ? normalized : undefined;
}

function requestDetails(body: unknown, req: IncomingMessage) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return {};
  const record = body as Record<string, unknown>;
  const params =
    typeof record.params === 'object' && record.params !== null && !Array.isArray(record.params)
      ? (record.params as Record<string, unknown>)
      : undefined;
  const args =
    typeof params?.arguments === 'object' &&
    params.arguments !== null &&
    !Array.isArray(params.arguments)
      ? (params.arguments as Record<string, unknown>)
      : undefined;
  const traceId = traceIdFromRequest(req);
  const org = tenantSlugSchema.safeParse(args?.org);
  const env = environmentNameSchema.safeParse(args?.env);
  return {
    ...(record.method === 'tools/call' && typeof params?.name === 'string'
      ? { toolName: params.name }
      : {}),
    ...(env.success ? { environment: env.data } : {}),
    ...(org.success ? { organization: org.data } : {}),
    ...(traceId === undefined ? {} : { traceId }),
  };
}

function traceIdFromRequest(req: IncomingMessage): string | undefined {
  const traceparent = boundedHeader(req.headers.traceparent);
  return traceparent === undefined
    ? undefined
    : /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/i.exec(traceparent)?.[1];
}

async function observeRequest(
  options: DeveloperMcpMountOptions,
  requestId: string,
  context: DeveloperMcpContext,
  status: number,
  startedAt: number,
  details: {
    readonly toolName?: string;
    readonly organization?: string;
    readonly environment?: string;
    readonly traceId?: string;
  } = {},
  outcome?: { readonly decision: 'allow' | 'deny'; readonly errorCode?: string },
): Promise<void> {
  const durationMs = Math.max(0, Date.now() - startedAt);
  const grantHash = createHash('sha256').update(context.grantId).digest('hex').slice(0, 16);
  const decision = outcome?.decision ?? (status < 400 ? 'allow' : 'deny');
  const fields = {
    requestId,
    grantHash,
    status,
    durationMs,
    decision,
    ...(outcome?.errorCode === undefined ? {} : { errorCode: outcome.errorCode }),
    ...details,
  };
  options.logger.info('developer.mcp.request', fields);
  if (details.organization === undefined) return;
  try {
    await options.audit.emit({
      eventType: 'developer.mcp.request',
      org: details.organization,
      decision,
      status,
      ...(outcome?.errorCode === undefined ? {} : { reasonCode: outcome.errorCode }),
      details: fields,
    });
  } catch {
    options.logger.warn('developer.mcp.audit_failed', {
      requestId,
      org: details.organization,
      status,
    });
  }
}
