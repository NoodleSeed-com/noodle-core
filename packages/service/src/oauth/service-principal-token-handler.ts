import type { AuditSink } from '@noodle-borg/module';
import type { Request, Response } from 'express';
import type { ServerRegistry } from '../registry.js';
import {
  authenticateServicePrincipalClient,
  ServicePrincipalClientAuthError,
  type VerifiedServiceClient,
} from './service-principal-client-auth.js';
import {
  type ResolvedServicePrincipalResource,
  resolveServicePrincipalResource,
  type ServicePrincipalResourceRouting,
} from './service-principal-resource.js';
import type {
  ActiveServicePrincipalClient,
  ServicePrincipalGrantRecord,
  ServicePrincipalRuntime,
} from './service-principal-store.js';
import type { IssueServicePrincipalAccessTokenInput } from './service-principal-token-issuer.js';

const TEN_MINUTES = 600;

export interface ServicePrincipalTokenIssuer {
  readonly issuer: string;
  nowSeconds(): number;
  issueServicePrincipalAccessToken(input: IssueServicePrincipalAccessTokenInput): Promise<string>;
}

export interface ServicePrincipalTokenHandlerOptions {
  readonly runtime: ServicePrincipalRuntime;
  readonly registry: () => ServerRegistry | undefined;
  readonly routing: ServicePrincipalResourceRouting;
  readonly audit?: AuditSink;
}

/** Handle only the OAuth client_credentials grant; the caller owns grant-type dispatch. */
export async function handleServicePrincipalToken(
  req: Request,
  res: Response,
  issuer: ServicePrincipalTokenIssuer,
  options: ServicePrincipalTokenHandlerOptions,
): Promise<void> {
  noStore(res);
  if (!options.runtime.ready) {
    oauthError(
      res,
      503,
      'temporarily_unavailable',
      'service-principal authentication is unavailable',
    );
    return;
  }

  const nowSeconds = issuer.nowSeconds();
  let client: VerifiedServiceClient;
  try {
    const authorization = authorizationHeaders(req);
    client = await authenticateServicePrincipalClient(
      { body: body(req), ...(authorization === undefined ? {} : { authorization }) },
      options.runtime.store,
      `${issuer.issuer.replace(/\/+$/, '')}/token`,
      nowSeconds,
    );
  } catch (error) {
    if (error instanceof ServicePrincipalClientAuthError) {
      res.setHeader('WWW-Authenticate', 'Basic realm="token"');
      oauthError(res, 401, error.oauthError, error.message);
      return;
    }
    oauthError(res, 401, 'invalid_client', 'invalid client authentication');
    return;
  }

  const resource = oneRequiredString(body(req).resource);
  if (resource === undefined) {
    oauthError(res, 400, 'invalid_request', 'exactly one resource parameter is required');
    return;
  }
  const registry = options.registry();
  if (registry === undefined) {
    oauthError(res, 400, 'invalid_target', 'requested resource is unavailable');
    return;
  }
  let resolved: ResolvedServicePrincipalResource | undefined;
  try {
    resolved = await resolveServicePrincipalResource(resource, registry, options.routing);
  } catch {
    oauthError(res, 400, 'invalid_target', 'requested resource is unavailable');
    return;
  }
  if (resolved === undefined || resolved.tenant.org !== client.org) {
    oauthError(res, 400, 'invalid_target', 'requested resource is unavailable');
    return;
  }

  let activeClient: ActiveServicePrincipalClient | undefined;
  try {
    activeClient = await options.runtime.store.loadActiveClient(
      client.principalId,
      nowSeconds * 1000,
    );
  } catch {
    oauthError(res, 401, 'invalid_client', 'invalid client authentication');
    return;
  }
  const grant = matchingGrant(activeClient?.grants ?? [], resolved.tenant);
  if (grant === undefined) {
    oauthError(res, 400, 'invalid_target', 'requested resource is unavailable');
    return;
  }

  const scopes = requestedScopes(body(req).scope, grant.scopes);
  if (scopes === undefined) {
    oauthError(res, 400, 'invalid_scope', 'requested scope is invalid');
    return;
  }

  try {
    const bindingIsLive = await options.runtime.store.validateAccessBinding({
      principalId: client.principalId,
      grantId: grant.grantId,
      credentialId: client.credentialId,
      org: resolved.tenant.org,
      app: resolved.tenant.app,
      environment: resolved.tenant.env,
      now: nowSeconds * 1000,
    });
    if (!bindingIsLive) {
      oauthError(res, 401, 'invalid_client', 'invalid client authentication');
      return;
    }
    if (client.assertion !== undefined) {
      const consumed = await options.runtime.store.consumeAssertionJti({
        credentialId: client.credentialId,
        jti: client.assertion.jti,
        expiresAt: client.assertion.expiresAt * 1000,
        now: nowSeconds * 1000,
      });
      if (!consumed) {
        oauthError(res, 401, 'invalid_client', 'invalid client authentication');
        return;
      }
    }

    const scope = scopes.join(' ');
    const accessToken = await issuer.issueServicePrincipalAccessToken({
      principalId: client.principalId,
      resource: resolved.resource,
      ...(scope.length === 0 ? {} : { scope }),
      grantId: grant.grantId,
      credentialId: client.credentialId,
      ttlSeconds: TEN_MINUTES,
    });
    await options.audit?.emit({
      eventType: 'service_principal.token.issued',
      org: resolved.tenant.org,
      app: resolved.tenant.app,
      env: resolved.tenant.env,
      ...(resolved.deploymentId === undefined ? {} : { deploymentId: resolved.deploymentId }),
      actorSubject: client.principalId,
      decision: 'allow',
      status: 200,
      details: {
        principalId: client.principalId,
        grantId: grant.grantId,
        credentialId: client.credentialId,
      },
    });
    res.status(200).json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: TEN_MINUTES,
      ...(scope.length === 0 ? {} : { scope }),
    });
  } catch {
    oauthError(res, 401, 'invalid_client', 'invalid client authentication');
  }
}

function body(req: Request): Readonly<Record<string, unknown>> {
  return req.body !== null && typeof req.body === 'object'
    ? (req.body as Record<string, unknown>)
    : {};
}

function authorizationHeaders(req: Request): string | readonly string[] | undefined {
  const values: string[] = [];
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index]?.toLowerCase() === 'authorization') {
      const value = req.rawHeaders[index + 1];
      if (value !== undefined) values.push(value);
    }
  }
  if (values.length === 0) return undefined;
  return values.length === 1 ? values[0] : values;
}

function oneRequiredString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function matchingGrant(
  grants: readonly ServicePrincipalGrantRecord[],
  tenant: { readonly org: string; readonly app: string; readonly env: string },
): ServicePrincipalGrantRecord | undefined {
  return grants.find(
    (grant) =>
      grant.status === 'active' &&
      grant.org === tenant.org &&
      grant.app === tenant.app &&
      grant.environment === tenant.env,
  );
}

function requestedScopes(
  value: unknown,
  ceiling: readonly string[],
): readonly string[] | undefined {
  if (value === undefined) return ceiling;
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const scopes = value.split(' ');
  if (
    scopes.length > 64 ||
    scopes.some(
      (scope) =>
        scope.length < 1 || scope.length > 128 || !/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope),
    ) ||
    new Set(scopes).size !== scopes.length
  ) {
    return undefined;
  }
  const allowed = new Set(ceiling);
  return scopes.every((scope) => allowed.has(scope)) ? [...scopes].sort() : undefined;
}

function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
}

function oauthError(res: Response, status: number, error: string, description: string): void {
  res.status(status).json({ error, error_description: description });
}
