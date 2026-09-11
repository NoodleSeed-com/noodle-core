import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  AccessMode,
  AdmissionGate,
  DataPlaneIdentityAuthorizer,
  IntentCaptureMode,
  IntentEventInput,
  OrgMembershipSource,
  OwnerTokenVerifier,
  RequestEventInput,
  TenantRouteRef,
} from '@noodle-borg/module';
import {
  type ConfirmationNonceLedger,
  JSON_RPC,
  type McpProtocolMode,
  type ProtocolRequestContext,
  type RequestStateManager,
  type ServedArtifact,
} from '@noodle-borg/protocol';
import { applySecurityHeaders, enforceHttps, type TlsPosture } from './front-door.js';
import { type Logger, noopLogger } from './logging.js';
import { guard, logRequest, rpcError, sendJson } from './responses.js';
import { type PublicTenantRouting, resolveRoute } from './routing.js';
import { serveRequest } from './serve-request.js';
import type { HostedToolAuthorizationObserver } from './service-principal-authorization.js';
import { resolveTargetAuthentication, type TargetAuthentication } from './target-authentication.js';
import type { HostedToolDispatchHook } from './tool-dispatch.js';

export type {
  AccessMode,
  AdmissionCategory,
  AdmissionContext,
  AdmissionDecision,
  AdmissionGate,
  DataPlaneAuthorizationResult,
  DataPlaneIdentityAuthorizer,
  OwnerTokenVerifier,
  TenantRouteRef,
} from '@noodle-borg/module';
export type { PublicTenantRouting } from './routing.js';

/** Origins allowed to call the endpoint: an explicit list, a predicate, or undefined (allow any). */
export type OriginPolicy = readonly string[] | ((origin: string) => boolean);

/** Validated, bounded coordinates from one host request. Never identity or policy input. */
export interface InvocationClientLocationHint {
  readonly latitude: number;
  readonly longitude: number;
  readonly city?: string;
  readonly region?: string;
  readonly country?: string;
  readonly timeZone?: string;
}

export interface InvocationClientHint {
  readonly location?: InvocationClientLocationHint;
}

export interface InvocationContextResolutionInput {
  readonly target: ServedArtifact;
  readonly caller?: NonNullable<ProtocolRequestContext['caller']>;
  readonly clientHint?: InvocationClientHint;
}

export type InvocationContextResolver = (
  input: InvocationContextResolutionInput,
) => Promise<NonNullable<ServedArtifact['deps']['context']> | undefined>;

export interface HttpHandlerOptions {
  /** The single MCP endpoint path. Default `/mcp`. */
  readonly endpoint?: string;
  /** Allowed browser origins. A missing Origin remains valid for non-browser MCP clients. */
  readonly allowedOrigins?: OriginPolicy;
  /** Maximum request body size in bytes. Default 1 MiB. */
  readonly maxBodyBytes?: number;
  /** Structured logger for request-lifecycle events (`mcp.request`). Default: a no-op logger. */
  readonly logger?: Logger;
  /** In-app HTTPS posture for TLS-proxy-terminated deployments. */
  readonly tls?: TlsPosture;
  /** Verify an access token for identity-based deployments. */
  readonly verifyOwnerToken?: OwnerTokenVerifier;
  /** Authorize a verified identity for a non-owner identity mode. */
  readonly authorizeDataPlaneIdentity?: DataPlaneIdentityAuthorizer;
  /** Request admission hook after authentication and JSON parsing, before SDK execution. */
  readonly admissionGate?: AdmissionGate;
  /** Enqueue one scalar-only analytics event after the response is written. */
  readonly captureRequestEvent?: (event: RequestEventInput) => void;
  /** Separate, best-effort operator intent stream. Requires `intentCaptureMode: starter-v1`. */
  readonly captureIntentEvent?: (event: IntentEventInput) => void;
  /** Single-target operator switch. Multi-tenant targets carry their resolved mode. */
  readonly intentCaptureMode?: IntentCaptureMode;
  /** Resolve one immutable context snapshot after auth/admission and before request execution. */
  readonly resolveInvocationContext?: InvocationContextResolver;
  /** Hosted tool-call admission hook. Absent/incomplete tenant targets are deliberately not observed. */
  readonly beforeToolDispatch?: HostedToolDispatchHook;
  /** Safe, flat service-principal authorization observations emitted before protocol dispatch. */
  readonly observeToolAuthorization?: HostedToolAuthorizationObserver;
  /** Origin-wide readiness for the complete OAuth client-credentials lifecycle. */
  readonly oauthClientCredentialsReady?: boolean;
  /** Origin-wide protocol rollout gate. Never vary this by app or deployment. Default: `dual`. */
  readonly protocolMode?: McpProtocolMode;
  /** Operator-key-derived modern request-state manager shared across the serving fleet. */
  readonly requestState?: RequestStateManager;
  /** Durable single-use ledger required for modern confirmation retries. */
  readonly confirmationNonceLedger?: ConfirmationNonceLedger;
}

const DEFAULT_ENDPOINT = '/mcp';
const DEFAULT_MAX_BODY = 1 << 20;

/** Build the single-artifact raw-Node security front door. */
export function createMcpHttpHandler(
  target: ServedArtifact,
  options: HttpHandlerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => void {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const logger = options.logger ?? noopLogger;
  const tls = options.tls ?? {};

  return (req, res) => {
    const start = Date.now();
    applySecurityHeaders(res, tls);
    if (enforceHttps(req, res, tls)) {
      logRequest(logger, 'single', req, res, start);
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== endpoint) {
      sendJson(res, 404, rpcError(JSON_RPC.INVALID_REQUEST, 'not found'));
      logRequest(logger, 'single', req, res, start);
      return;
    }
    void guard(
      res,
      serveRequest(
        req,
        res,
        target,
        {
          accessMode: undefined,
          deploymentId: undefined,
          ownerSubject: undefined,
          org: undefined,
          app: undefined,
          environment: undefined,
          orgMembershipSources: undefined,
          authentication: resolveTargetAuthentication({}, options.verifyOwnerToken),
          authorizeDataPlaneIdentity: options.authorizeDataPlaneIdentity,
          admissionGate: options.admissionGate,
          captureRequestEvent: options.captureRequestEvent,
          captureIntentEvent: options.captureIntentEvent,
          intentCaptureMode: options.intentCaptureMode ?? 'off',
          resolveInvocationContext: options.resolveInvocationContext,
          beforeToolDispatch: options.beforeToolDispatch,
          observeToolAuthorization: options.observeToolAuthorization,
          oauthClientCredentialsReady: options.oauthClientCredentialsReady === true,
          protocolMode: options.protocolMode ?? 'dual',
          requestState: options.requestState,
          confirmationNonceLedger: options.confirmationNonceLedger,
          logger,
          trustProxy: tls.trustProxy ?? false,
        },
        'single',
        maxBody,
        options.allowedOrigins,
      ),
    ).then(() => logRequest(logger, 'single', req, res, start));
  };
}

/** A resolved tenant: its served artifact plus how callers authenticate to it. */
export interface ServedTarget {
  readonly served: ServedArtifact;
  readonly deploymentId?: string;
  readonly accessMode?: AccessMode;
  readonly ownerSubject?: string;
  readonly org?: string;
  readonly app?: string;
  readonly environment?: string;
  readonly orgMembershipSources?: readonly OrgMembershipSource[];
  readonly authentication?: TargetAuthentication;
  readonly intentCaptureMode?: IntentCaptureMode;
}

export type ServerLookup = (deploymentId: string) => Promise<ServedTarget | undefined>;
export type TenantLookup = (ref: TenantRouteRef) => Promise<ServedTarget | undefined>;
export type TenantPreflight = (
  ref: TenantRouteRef,
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<boolean>;
export type ExtraRouteLookup = (
  pathname: string,
) => Promise<{ readonly target: ServedTarget; readonly routeId: string } | undefined>;

/** Build the multi-tenant raw-Node security front door. */
export function createMcpRouter(
  lookup: ServerLookup,
  options: HttpHandlerOptions & {
    readonly tenantLookup?: TenantLookup;
    readonly tenantPreflight?: TenantPreflight;
    readonly extraRouteLookup?: ExtraRouteLookup;
    readonly publicTenantRouting?: PublicTenantRouting;
  } = {},
): (req: IncomingMessage, res: ServerResponse) => void {
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const logger = options.logger ?? noopLogger;
  const tls = options.tls ?? {};

  return (req, res) => {
    const start = Date.now();
    applySecurityHeaders(res, tls);
    if (enforceHttps(req, res, tls)) {
      logRequest(logger, '?', req, res, start);
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    let logId = '?';
    void guard(
      res,
      (async () => {
        const resolution = await resolveRoute(req, url.pathname, options.publicTenantRouting);
        if (!resolution.ok) {
          sendJson(res, resolution.status, rpcError(JSON_RPC.INVALID_REQUEST, 'forbidden'));
          return;
        }
        const route = resolution.route;
        logId = route?.logId ?? '?';
        if (
          route?.kind === 'tenant' &&
          options.tenantPreflight !== undefined &&
          !(await options.tenantPreflight(route.ref, req, res))
        ) {
          return;
        }
        const target =
          route?.kind === 'tenant' && options.tenantLookup
            ? await options.tenantLookup(route.ref)
            : route?.kind === 'deployment'
              ? await lookup(route.deploymentId)
              : undefined;
        const extra = route === null ? await options.extraRouteLookup?.(url.pathname) : undefined;
        const resolvedTarget = target ?? extra?.target;
        if (!resolvedTarget) {
          sendJson(res, 404, rpcError(JSON_RPC.INVALID_REQUEST, 'not found'));
          return;
        }
        const routeId =
          route?.kind === 'tenant'
            ? route.logId
            : route?.kind === 'deployment'
              ? route.deploymentId
              : (extra?.routeId ?? '?');
        const tenant = route?.kind === 'tenant' ? route.ref : undefined;
        await serveRequest(
          req,
          res,
          resolvedTarget.served,
          {
            accessMode: resolvedTarget.accessMode,
            deploymentId: resolvedTarget.deploymentId,
            ownerSubject: resolvedTarget.ownerSubject,
            org: resolvedTarget.org,
            orgMembershipSources: resolvedTarget.orgMembershipSources,
            authentication: resolveTargetAuthentication(resolvedTarget, options.verifyOwnerToken),
            authorizeDataPlaneIdentity: options.authorizeDataPlaneIdentity,
            admissionGate: options.admissionGate,
            captureRequestEvent: options.captureRequestEvent,
            captureIntentEvent: options.captureIntentEvent,
            intentCaptureMode: resolvedTarget.intentCaptureMode ?? 'off',
            resolveInvocationContext: options.resolveInvocationContext,
            beforeToolDispatch: options.beforeToolDispatch,
            observeToolAuthorization: options.observeToolAuthorization,
            oauthClientCredentialsReady: options.oauthClientCredentialsReady === true,
            protocolMode: options.protocolMode ?? 'dual',
            requestState: options.requestState,
            confirmationNonceLedger: options.confirmationNonceLedger,
            app: resolvedTarget.app ?? tenant?.app,
            environment: resolvedTarget.environment ?? tenant?.env,
            logger,
            trustProxy: tls.trustProxy ?? false,
            ...(route?.kind === 'tenant' && route.publicResourceUrl !== undefined
              ? { publicResourceUrl: route.publicResourceUrl }
              : {}),
          },
          routeId,
          maxBody,
          options.allowedOrigins,
          tenant,
        );
      })(),
    ).then(() => logRequest(logger, logId, req, res, start));
  };
}
