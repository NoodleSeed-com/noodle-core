import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  AccessMode,
  DataPlaneIdentityAuthorizer,
  OrgMembershipSource,
} from '@noodle-borg/module';
import { JSON_RPC, type ProtocolRequestContext } from '@noodle-borg/protocol';
import { effectiveProto } from './front-door.js';
import { header } from './request-capture.js';
import type { TargetAuthentication } from './target-authentication.js';

export interface IdentityAuthorizationOptions {
  readonly accessMode: AccessMode | undefined;
  readonly ownerSubject: string | undefined;
  readonly org: string | undefined;
  readonly orgMembershipSources: readonly OrgMembershipSource[] | undefined;
  readonly authentication: TargetAuthentication;
  readonly authorizeDataPlaneIdentity: DataPlaneIdentityAuthorizer | undefined;
  /** Whether to trust forwarded-proto when reconstructing the public resource/PRM URLs. */
  readonly trustProxy: boolean;
  /** Public resource URL supplied by a trusted edge for MCP-subdomain routes. */
  readonly publicResourceUrl?: string;
}

/**
 * Bounded identity-denial taxonomy retained by request analytics (#1309). Derived structurally at
 * this seam — the token verifier stays opaque — and never carries token material or claims.
 */
type IdentityDenialReason =
  | 'missing_token'
  | 'verifier_unavailable'
  | 'token_rejected'
  | 'identity_not_customer'
  | 'owner_unconfigured'
  | 'owner_mismatch'
  | 'org_membership_denied';

export type IdentityAuthResult =
  | {
      readonly allow: true;
      readonly caller?: NonNullable<ProtocolRequestContext['caller']>;
      readonly customerIssuer?: string;
      readonly customerRouting?: Readonly<Record<string, string>>;
      readonly subject?: string;
    }
  | { readonly allow: false; readonly reason: IdentityDenialReason };

/**
 * Identity gate (OA-1/OA-3): require a verified token and authorize it against the deployment access mode.
 * `allow: true` means the request may proceed, with caller and subject fields when available. `allow: false`
 * means this function already wrote the denial response. Missing tokens and absent verifiers fail closed.
 */
export async function authorizeIdentityMode(
  req: IncomingMessage,
  res: ServerResponse,
  auth: IdentityAuthorizationOptions,
): Promise<IdentityAuthResult> {
  const challenge = protectedResourceMetadataUrl(req, auth);
  const token = bearerToken(header(req, 'authorization'));
  if (token === null || auth.authentication.verifyToken === undefined) {
    sendUnauthorized(res, challenge);
    return { allow: false, reason: token === null ? 'missing_token' : 'verifier_unavailable' };
  }
  const verification = await auth.authentication.verifyToken(
    token,
    canonicalResourceUrl(req, auth),
  );
  if (verification === null) {
    sendUnauthorized(res, challenge, 'invalid_token');
    return { allow: false, reason: 'token_rejected' };
  }
  const { caller: identity } = verification;
  if (identity.identityKind === 'service') {
    return { allow: true, caller: identity };
  }
  const privateCustomerContext = {
    ...(verification.customerIssuer === undefined
      ? {}
      : { customerIssuer: verification.customerIssuer }),
    ...(verification.customerRouting === undefined
      ? {}
      : { customerRouting: verification.customerRouting }),
  };
  if (auth.accessMode === 'authenticated') {
    return { allow: true, caller: identity, ...privateCustomerContext };
  }
  if (auth.accessMode === 'customers') {
    if (identity.identityKind !== 'customer') {
      sendUnauthorized(res, challenge);
      return { allow: false, reason: 'identity_not_customer' };
    }
    return { allow: true, caller: identity, ...privateCustomerContext };
  }
  if (auth.accessMode === 'owner-only') {
    if (auth.ownerSubject === undefined) {
      sendUnauthorized(res, challenge);
      return { allow: false, reason: 'owner_unconfigured' };
    }
    if (identity.subject !== auth.ownerSubject) {
      sendForbidden(res);
      return { allow: false, reason: 'owner_mismatch' };
    }
    return { allow: true, caller: identity, ...privateCustomerContext };
  }
  if (auth.accessMode === 'org-members') {
    const membership =
      auth.org === undefined || auth.authorizeDataPlaneIdentity === undefined
        ? undefined
        : await auth.authorizeDataPlaneIdentity({
            accessMode: auth.accessMode,
            org: auth.org,
            subject: identity.subject,
            ...(identity.email !== undefined ? { email: identity.email } : {}),
            ...(auth.orgMembershipSources !== undefined
              ? { membershipSources: auth.orgMembershipSources }
              : {}),
          });
    if (membership?.allowed !== true) {
      sendForbidden(res);
      return { allow: false, reason: 'org_membership_denied' };
    }
  }
  return { allow: true, caller: identity, ...privateCustomerContext };
}

/**
 * Public endpoints stay anonymous unless a valid service-principal bearer is supplied. Invalid, human,
 * and customer bearers retain the pre-existing public behavior and are ignored rather than challenged.
 */
export async function authorizePublicServiceMode(
  req: IncomingMessage,
  auth: IdentityAuthorizationOptions,
): Promise<IdentityAuthResult> {
  const token = bearerToken(header(req, 'authorization'));
  if (token === null || auth.authentication.verifyToken === undefined) return { allow: true };
  const verification = await auth.authentication.verifyToken(
    token,
    canonicalResourceUrl(req, auth),
  );
  return verification?.caller.identityKind === 'service'
    ? { allow: true, caller: verification.caller }
    : { allow: true };
}

export async function authorizeMixedMode(
  req: IncomingMessage,
  res: ServerResponse,
  auth: IdentityAuthorizationOptions,
): Promise<IdentityAuthResult> {
  const authorization = header(req, 'authorization');
  if (authorization === undefined) return { allow: true };
  const token = bearerToken(authorization);
  const challenge = protectedResourceMetadataUrl(req, auth);
  if (token === null) {
    sendUnauthorized(res, challenge, 'invalid_token');
    return { allow: false, reason: 'token_rejected' };
  }
  if (auth.authentication.verifyToken === undefined) {
    sendUnauthorized(res, challenge);
    return { allow: false, reason: 'verifier_unavailable' };
  }
  const verification = await auth.authentication.verifyToken(
    token,
    canonicalResourceUrl(req, auth),
  );
  if (verification === null) {
    sendUnauthorized(res, challenge, 'invalid_token');
    return { allow: false, reason: 'token_rejected' };
  }
  if (
    auth.authentication.kind === 'customer' &&
    verification.caller.identityKind !== 'customer' &&
    verification.caller.identityKind !== 'service'
  ) {
    sendUnauthorized(res, challenge, 'invalid_token');
    return { allow: false, reason: 'identity_not_customer' };
  }
  return {
    allow: true,
    caller: verification.caller,
    ...(verification.customerIssuer === undefined
      ? {}
      : { customerIssuer: verification.customerIssuer }),
    ...(verification.customerRouting === undefined
      ? {}
      : { customerRouting: verification.customerRouting }),
  };
}

export function isIdentityMode(mode: AccessMode | undefined): boolean {
  return (
    mode === 'owner-only' ||
    mode === 'org-members' ||
    mode === 'authenticated' ||
    mode === 'customers'
  );
}

/** The credential carried by one `Authorization` header value, or null when it is not a bearer. */
export function bearerToken(headerValue: string | undefined): string | null {
  if (!headerValue) return null;
  const match = /^Bearer\s+(.+)$/i.exec(headerValue);
  return match?.[1] ?? null;
}

/**
 * A `401` with a bearer challenge and a transport-level JSON-RPC error body. For owner-only endpoints,
 * `resourceMetadataUrl` is included so an MCP client can discover the authorization server (RFC 9728 /
 * the MCP authorization spec).
 */
function sendUnauthorized(
  res: ServerResponse,
  resourceMetadataUrl?: string,
  error?: 'invalid_token',
): void {
  const challenge =
    resourceMetadataUrl !== undefined
      ? `Bearer realm="noodle", resource_metadata="${resourceMetadataUrl}"`
      : 'Bearer realm="noodle"';
  res.writeHead(401, {
    'content-type': 'application/json; charset=utf-8',
    'www-authenticate': error === undefined ? challenge : `${challenge}, error="${error}"`,
  });
  res.end(JSON.stringify(rpcError(JSON_RPC.INVALID_REQUEST, 'unauthorized')));
}

/** A `403` with a transport-level JSON-RPC error body (authenticated, but not authorized). */
function sendForbidden(res: ServerResponse): void {
  res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(rpcError(JSON_RPC.INVALID_REQUEST, 'forbidden')));
}

/** The public origin + path for this request, honouring the trusted forwarded-proto when configured. */
function requestUrl(
  req: IncomingMessage,
  trustProxy: boolean,
): { origin: string; pathname: string } {
  const proto = effectiveProto(req, trustProxy);
  const host = header(req, 'host') ?? 'localhost';
  const pathname = new URL(req.url ?? '/', `${proto}://${host}`).pathname;
  return { origin: `${proto}://${host}`, pathname };
}

/** The canonical resource identifier (the tenant MCP URL) a token must be audience-bound to (RFC 8707). */
export function canonicalResourceUrl(
  req: IncomingMessage,
  auth: Pick<IdentityAuthorizationOptions, 'trustProxy' | 'publicResourceUrl'>,
): string {
  if (auth.publicResourceUrl !== undefined) return auth.publicResourceUrl;
  const { origin, pathname } = requestUrl(req, auth.trustProxy);
  return `${origin}${pathname}`;
}

/** The RFC 9728 protected-resource-metadata URL for this request (well-known prefix before the path). */
export function protectedResourceMetadataUrl(
  req: IncomingMessage,
  auth: IdentityAuthorizationOptions,
): string {
  const resource = new URL(canonicalResourceUrl(req, auth));
  return `${resource.origin}/.well-known/oauth-protected-resource${resource.pathname}`;
}

/** A transport-level JSON-RPC error response with no id (per the Streamable HTTP spec). */
function rpcError(
  code: number,
  message: string,
): { jsonrpc: '2.0'; id: null; error: { code: number; message: string } } {
  return { jsonrpc: '2.0', id: null, error: { code, message } };
}
