import { createHash, timingSafeEqual } from 'node:crypto';
import { type JWTVerifyGetKey, jwtVerify } from 'jose';

/**
 * The inbound half of the delegated token exchange (RFC 8693), serving exactly one first-party
 * caller: the hosted assistant's control-plane connector. We implement the same target-endpoint
 * contract we ask every customer token endpoint to implement (docs/spec/connectors.md, ADR 0152) —
 * verify the platform-signed assertion, identify the user by `(customer_identity.issuer, sub)`,
 * honour the 120s lifetime and single-use `jti`, and return a standard token response.
 *
 * The same issuer and signing key mint control-plane access tokens and exchange assertions, so
 * **audience separation is the entire security boundary**: this exchange accepts only the dedicated
 * exchange URN below and structurally refuses every resource audience (all of which are URLs) —
 * including our own access tokens presented as subject tokens. The minted token is capability-scoped
 * through the developer-grant machinery, so rollback/config-write can never be stored on it and
 * every control-plane route re-checks live org membership per request.
 *
 * This module is the Express-free decision core; the hosted service wraps it in a thin HTTP adapter
 * and supplies every policy port below (ADR 0218).
 */

export const CONTROL_PLANE_EXCHANGE_AUDIENCE = 'urn:noodleseed:control-plane:delegated-exchange';
export const CONTROL_PLANE_EXCHANGE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const SUBJECT_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:jwt';
const ASSERTION_MAX_LIFETIME_SECONDS = 125; // 120s contract + clock tolerance
const TOKEN_TTL_SECONDS = 600;
const ASSISTANT_CLIENT_ISSUER_PREFIX = 'urn:noodleseed:assistant-client:';

/** Durable single-use claims for inbound exchange assertion `jti`s; false = replayed. */
export interface TokenExchangeJtiStore {
  consume(jti: string, expiresAtMs: number, nowMs: number): Promise<boolean>;
}

/** Local/test-only; production deployments need durable shared atomic replay storage. */
export class InMemoryTokenExchangeJtiStore implements TokenExchangeJtiStore {
  readonly #seen = new Map<string, number>();

  async consume(jti: string, expiresAtMs: number, nowMs: number): Promise<boolean> {
    for (const [key, expiry] of this.#seen) {
      if (expiry <= nowMs) this.#seen.delete(key);
    }
    if (this.#seen.has(jti)) return false;
    this.#seen.set(jti, expiresAtMs);
    return true;
  }
}

export interface ControlPlaneExchangeConfig {
  /** The dedicated confidential client; deliberately not registered in the OAuth store. */
  readonly clientId: string;
  readonly clientSecret: string;
  /** Exact `org/app/env` tenants whose assertions this exchange serves (the first-party assistant). */
  readonly allowedTenants: readonly string[];
}

export interface ControlPlaneExchangeTenantRef {
  readonly org: string;
  readonly app: string;
  readonly env: string;
}

/** Structural audit port; the hosted service passes its tenant-scoped audit sink. */
export interface ControlPlaneExchangeAuditEvent {
  readonly eventType: string;
  readonly org: string;
  readonly app: string;
  readonly env: string;
  readonly decision: 'allow' | 'deny';
  readonly status: number;
  readonly reasonCode?: string;
  readonly actorSubject?: string;
  readonly details?: Readonly<Record<string, string>>;
}

export interface ControlPlaneExchangeDeps {
  readonly issuer: string;
  readonly config: ControlPlaneExchangeConfig;
  readonly verifierKey: () => Promise<JWTVerifyGetKey>;
  /** Capability-scoped developer-grant creation/reuse (method-typed so narrower stores satisfy it). */
  readonly grants: {
    getOrCreateActive(input: {
      readonly clientId: string;
      readonly subject: string;
      readonly resource: string;
      readonly capabilities: readonly string[];
    }): Promise<{ readonly id: string }>;
  };
  /** Durable single-use claim; false = replayed. */
  readonly consumeJti: (jti: string, expiresAtMs: number) => Promise<boolean>;
  /** Resolve an EXISTING platform principal; never creates one. Undefined = refuse. */
  readonly resolveSubject: (subject: string) => Promise<{ readonly ok: true } | undefined>;
  /** Live (non-revoked) assistant client ids of one tenant; the elevation issuer must name one. */
  readonly listAssistantClientIds: (
    tenant: ControlPlaneExchangeTenantRef,
  ) => Promise<readonly string[]>;
  /** Public-signup-mode workspace provisioning at mint; wired only when signup mode is public. */
  readonly ensureWorkspace?: (identity: {
    readonly subject: string;
    readonly email: string;
  }) => Promise<void>;
  /** The scope ceiling and the developer resource the grant/token bind to. */
  readonly resourcePath: string;
  readonly capabilityCeiling: readonly string[];
  readonly issueAccessToken: (input: {
    readonly subject: string;
    readonly email: string;
    readonly resource: string;
    readonly scope: string;
    readonly developerGrantId: string;
    readonly oauthClientId: string;
    readonly ttlSeconds: number;
  }) => Promise<string>;
  readonly audit?: {
    emit(event: ControlPlaneExchangeAuditEvent): Promise<unknown> | unknown;
  };
}

export interface ControlPlaneExchangeRequest {
  /** The parsed `application/x-www-form-urlencoded` body. */
  readonly form: Readonly<Record<string, unknown>>;
  readonly authorizationHeader?: string;
}

export interface ControlPlaneExchangeDecision {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
  /** Present exactly when the adapter must set `WWW-Authenticate`. */
  readonly wwwAuthenticate?: string;
}

export async function decideControlPlaneTokenExchange(
  request: ControlPlaneExchangeRequest,
  deps: ControlPlaneExchangeDeps,
): Promise<ControlPlaneExchangeDecision> {
  const refuse = async (
    status: number,
    error: string,
    description: string,
    reasonCode: string,
    tenant?: ControlPlaneExchangeTenantRef,
  ): Promise<ControlPlaneExchangeDecision> => {
    // Audit is tenant-scoped; refusals before a verified tenant claim have no tenant to charge.
    if (tenant !== undefined) {
      await deps.audit?.emit({
        eventType: 'control_plane.token_exchange.refused',
        org: tenant.org,
        app: tenant.app,
        env: tenant.env,
        decision: 'deny',
        status,
        reasonCode,
      });
    }
    return {
      status,
      body: { error, error_description: description },
      ...(status === 401 ? { wwwAuthenticate: 'Basic realm="token"' } : {}),
    };
  };

  const form = request.form;
  if (!authenticateExchangeClient(request, deps.config)) {
    return refuse(401, 'invalid_client', 'invalid client authentication', 'client_auth');
  }
  const subjectToken = oneString(form.subject_token);
  if (subjectToken === undefined || form.subject_token_type !== SUBJECT_TOKEN_TYPE) {
    return refuse(
      400,
      'invalid_request',
      'subject_token and subject_token_type=jwt are required',
      'malformed_request',
    );
  }
  // The audience form parameter, when present, must name the exchange URN exactly. Anything else —
  // above all a resource URL — is a category error this exchange exists to refuse.
  const audienceParam = form.audience;
  if (audienceParam !== undefined && audienceParam !== CONTROL_PLANE_EXCHANGE_AUDIENCE) {
    return refuse(400, 'invalid_target', 'unsupported exchange audience', 'audience');
  }

  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(subjectToken, await deps.verifierKey(), {
      issuer: deps.issuer,
      // Pinned to the URN: our own access tokens (resource-URL audiences) can never verify here.
      audience: CONTROL_PLANE_EXCHANGE_AUDIENCE,
      algorithms: ['RS256'],
      clockTolerance: 5,
    });
    payload = verified.payload as Record<string, unknown>;
  } catch {
    return refuse(400, 'invalid_grant', 'subject token is not a valid assertion', 'assertion');
  }
  const issuedAt = typeof payload.iat === 'number' ? payload.iat : undefined;
  const expiresAt = typeof payload.exp === 'number' ? payload.exp : undefined;
  if (
    issuedAt === undefined ||
    expiresAt === undefined ||
    expiresAt - issuedAt > ASSERTION_MAX_LIFETIME_SECONDS
  ) {
    return refuse(400, 'invalid_grant', 'assertion lifetime is invalid', 'assertion_lifetime');
  }
  const subject =
    typeof payload.sub === 'string' && payload.sub.length > 0 ? payload.sub : undefined;
  const email =
    typeof payload.email === 'string' && payload.email.length > 0 ? payload.email : undefined;
  const jti = typeof payload.jti === 'string' && payload.jti.length > 0 ? payload.jti : undefined;
  const tenant = typeof payload.tenant === 'string' ? payload.tenant : undefined;
  const customerIdentity = payload.customer_identity as
    | { readonly version?: unknown; readonly issuer?: unknown }
    | undefined;
  if (subject === undefined || jti === undefined || tenant === undefined) {
    return refuse(400, 'invalid_grant', 'assertion claims are incomplete', 'assertion_claims');
  }
  // The control-plane gate refuses email-less identities; requiring it here fails earlier and clearer.
  if (email === undefined) {
    return refuse(400, 'invalid_grant', 'assertion carries no email', 'assertion_email');
  }
  // A route binding names a customer-endpoint exchange; its presence here means a misrouted
  // connector, never this first-party exchange.
  if (payload.route !== undefined) {
    return refuse(400, 'invalid_grant', 'assertion carries a route binding', 'assertion_route');
  }
  if (!deps.config.allowedTenants.includes(tenant)) {
    return refuse(400, 'invalid_grant', 'assertion tenant is not served here', 'tenant');
  }
  if (
    customerIdentity?.version !== 1 ||
    typeof customerIdentity.issuer !== 'string' ||
    !customerIdentity.issuer.startsWith(ASSISTANT_CLIENT_ISSUER_PREFIX)
  ) {
    return refuse(400, 'invalid_grant', 'assertion identity issuer is not supported', 'issuer');
  }
  const assistantClientId = customerIdentity.issuer.slice(ASSISTANT_CLIENT_ISSUER_PREFIX.length);
  const [org = '', app = '', env = ''] = tenant.split('/');
  const tenantRef = { org, app, env };
  const liveClients = await deps.listAssistantClientIds(tenantRef);
  if (!liveClients.includes(assistantClientId)) {
    // Revoking the assistant client is the kill switch for this whole path.
    return refuse(
      400,
      'invalid_grant',
      'assertion identity issuer is not live',
      'issuer_liveness',
      tenantRef,
    );
  }
  if (!(await deps.consumeJti(jti, expiresAt * 1000))) {
    return refuse(400, 'invalid_grant', 'assertion was already used', 'jti_replay', tenantRef);
  }
  if ((await deps.resolveSubject(subject)) === undefined) {
    return refuse(
      400,
      'invalid_grant',
      'subject has no active platform principal',
      'subject',
      tenantRef,
    );
  }
  const scopes = requestedScopes(form.scope, deps.capabilityCeiling);
  if (scopes === undefined) {
    return refuse(400, 'invalid_scope', 'requested scope is invalid', 'scope', tenantRef);
  }

  await deps.ensureWorkspace?.({ subject, email });
  const resource = `${deps.issuer}${deps.resourcePath}`;
  const grant = await deps.grants.getOrCreateActive({
    clientId: deps.config.clientId,
    subject,
    resource,
    capabilities: scopes,
  });
  const scope = scopes.join(' ');
  const accessToken = await deps.issueAccessToken({
    subject,
    email,
    resource,
    scope,
    developerGrantId: grant.id,
    oauthClientId: deps.config.clientId,
    ttlSeconds: TOKEN_TTL_SECONDS,
  });
  await deps.audit?.emit({
    eventType: 'control_plane.token_exchange.issued',
    org,
    app,
    env,
    decision: 'allow',
    status: 200,
    actorSubject: subject,
    details: { grantId: grant.id, clientId: deps.config.clientId, scope },
  });
  return {
    status: 200,
    body: {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: TOKEN_TTL_SECONDS,
      scope,
    },
  };
}

/** Basic (default) or client_secret_post, compared timing-safe over digests. */
function authenticateExchangeClient(
  request: ControlPlaneExchangeRequest,
  config: ControlPlaneExchangeConfig,
): boolean {
  const header = request.authorizationHeader;
  let id: string | undefined;
  let secret: string | undefined;
  if (typeof header === 'string' && header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
    const split = decoded.indexOf(':');
    if (split > 0) {
      id = decodeURIComponent(decoded.slice(0, split));
      secret = decodeURIComponent(decoded.slice(split + 1));
    }
  } else {
    id = oneString(request.form.client_id);
    secret = oneString(request.form.client_secret);
  }
  if (id === undefined || secret === undefined) return false;
  return digestEquals(id, config.clientId) && digestEquals(secret, config.clientSecret);
}

function digestEquals(actual: string, expected: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(actual).digest(),
    createHash('sha256').update(expected).digest(),
  );
}

function oneString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function requestedScopes(
  value: unknown,
  ceiling: readonly string[],
): readonly string[] | undefined {
  if (value === undefined) return [...ceiling].sort();
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const scopes = value.split(' ');
  if (
    scopes.length > 16 ||
    scopes.some((scope) => scope.length < 1 || scope.length > 128) ||
    new Set(scopes).size !== scopes.length
  ) {
    return undefined;
  }
  const allowed = new Set(ceiling);
  return scopes.every((scope) => allowed.has(scope)) ? [...scopes].sort() : undefined;
}
