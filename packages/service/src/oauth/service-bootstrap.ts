import type { IncomingMessage, ServerResponse } from 'node:http';
import { createJwtVerifier, type SigningKeyProvider } from '@noodle-borg/auth';
import {
  ensurePersonalWorkspace,
  resolveMcpSubdomainTenant,
} from '@noodle-borg/control-plane/portable';
import {
  capabilitiesForDeveloperResource,
  DEVELOPER_ASSISTANT_PATH,
} from '@noodle-borg/developer-mcp';
import type {
  AuditSink,
  PlatformHumanIdentityContribution,
  PlatformPrincipalResolver as PlatformPrincipalResolverPort,
} from '@noodle-borg/module';
import type { SecretBox } from '@noodle-borg/runtime';
import { type Logger, noopLogger, type OwnerTokenVerifier } from '@noodle-borg/transport-http';
import type { Pool } from 'pg';
import { createCustomerVerifierFactory } from '../customer-verifier.js';
import { createHostedCustomerVerifierFactory } from '../customer-verifier-boundaries.js';
import { geminiEnterpriseDefaultResourceForClient } from '../gemini-enterprise-oauth.js';
import { normalizeOAuthResource } from '../http-util.js';
import { allowedMcpBaseDomains } from '../mcp-public-routing.js';
import type { ServerRegistry } from '../registry.js';
import type { ServeServiceOptions } from '../serve-options.js';
import {
  bridgeAuthForResource,
  managedSecretForResource,
  sealCustomerCredential,
} from '../serve-resource-auth.js';
import type { ControlPlaneStore, TenantBridgeAuthConfig } from '../store.js';
import { consoleSignedOutReturnUrl } from './console-url.js';
import type { ControlPlaneExchangeDeps } from './delegated-control-plane-token-handler.js';
import type { DeveloperGrantStore } from './developer-grant.js';
import {
  createDeveloperGrantAuthorizer,
  resolveDeveloperGrantStore,
} from './developer-grant-bootstrap.js';
import { guardPlatformAccessTokenVerifier } from './principal-status.js';
import { guardServicePrincipalAccessTokenVerifier } from './service-principal-guard.js';
import { resolveServicePrincipalResource } from './service-principal-resource.js';
import {
  InMemoryServicePrincipalStore,
  type ServicePrincipalRuntime,
} from './service-principal-store.js';
import type { OAuthStore } from './store.js';
import {
  InMemoryTokenExchangeJtiStore,
  PostgresTokenExchangeJtiStore,
} from './token-exchange-jti-store.js';
import { mintOAuthAccessToken } from './token-issuer.js';

export interface ServiceOAuthBootstrap {
  readonly authServerApp?: (req: IncomingMessage, res: ServerResponse) => void;
  readonly verifyOwnerToken?: OwnerTokenVerifier;
  readonly authServerIssuer?: string;
  readonly oauthStore?: OAuthStore;
  readonly developerGrantStore?: DeveloperGrantStore;
  readonly servicePrincipalRuntime?: ServicePrincipalRuntime;
  readonly oauthClientCredentialsReady: boolean;
  readonly delegatedExchange?: { readonly issuer: string; readonly signer: SigningKeyProvider };
  readonly rawCustomerVerifierFactory: ReturnType<typeof createCustomerVerifierFactory>;
  readonly hostedCustomerVerifierFactory: ReturnType<typeof createHostedCustomerVerifierFactory>;
}

/** Build the co-hosted authorization server and its durable upstream-human dependencies. */
export async function resolveServiceOAuthBootstrap(input: {
  readonly options: ServeServiceOptions;
  readonly pool?: Pool;
  readonly secretBox?: SecretBox;
  readonly controlPlaneStore: ControlPlaneStore;
  readonly platformHumanIdentity?: PlatformHumanIdentityContribution;
  readonly registry: () => ServerRegistry | undefined;
  readonly audit?: AuditSink;
  /** Live assistant client ids of one tenant, for the control-plane exchange's issuer check. */
  readonly listAssistantClientIds?: (tenant: {
    readonly org: string;
    readonly app: string;
    readonly env: string;
  }) => Promise<readonly string[]>;
}): Promise<ServiceOAuthBootstrap> {
  const { options } = input;
  const platformPrincipalResolver: PlatformPrincipalResolverPort | undefined =
    input.platformHumanIdentity?.principalResolver;
  let authServerApp: ((req: IncomingMessage, res: ServerResponse) => void) | undefined;
  let resolvedVerifyOwnerToken: OwnerTokenVerifier | undefined = options.verifyOwnerToken;
  let resolvedAuthServerIssuer: string | undefined = options.authServerIssuer;
  let oauthStore: OAuthStore | undefined;
  let developerGrantStore: DeveloperGrantStore | undefined = options.developerGrantStore;
  let servicePrincipalRuntime = options.servicePrincipalRuntime;
  let oauthClientCredentialsReady = false;
  let delegatedExchange: { issuer: string; signer: SigningKeyProvider } | undefined;
  const allowedMcpDomains = allowedMcpBaseDomains(options);
  const bridgeAuthForExactResource = async (
    resource: string,
  ): Promise<TenantBridgeAuthConfig | undefined> => {
    const registry = input.registry();
    return registry === undefined
      ? undefined
      : bridgeAuthForResource(registry, resource, allowedMcpDomains, input.controlPlaneStore);
  };
  const resolveBridgeAuth = (
    _auth: TenantBridgeAuthConfig,
    resource: string,
  ): Promise<TenantBridgeAuthConfig | undefined> => bridgeAuthForExactResource(resource);
  const rawCustomerVerifierFactory = createCustomerVerifierFactory({
    allowInsecureLocalhost: options.customerVerifierAllowInsecureLocalhost === true,
    ...(options.customerVerifierFirebaseJwks !== undefined
      ? { firebaseJwks: options.customerVerifierFirebaseJwks }
      : {}),
    ...(options.customerVerifierFirebaseJwksUri !== undefined
      ? { firebaseJwksUri: options.customerVerifierFirebaseJwksUri }
      : {}),
  });
  if (options.oauth) {
    servicePrincipalRuntime =
      servicePrincipalRuntime ??
      (await resolveServicePrincipalRuntime(input.pool, options.logger ?? noopLogger));
    oauthClientCredentialsReady = servicePrincipalRuntime.ready === true;
    if (input.pool) {
      const { PostgresOAuthStore } = await import('./store-postgres.js');
      const postgresOAuth = new PostgresOAuthStore(input.pool, {
        ...(input.platformHumanIdentity?.initializeOAuthPersistence === undefined
          ? {}
          : {
              initializeOAuthPersistence: input.platformHumanIdentity.initializeOAuthPersistence,
            }),
        ...(input.platformHumanIdentity?.assertRefreshPrincipal === undefined
          ? {}
          : { assertRefreshPrincipal: input.platformHumanIdentity.assertRefreshPrincipal }),
      });
      await postgresOAuth.ensureSchema();
      oauthStore = postgresOAuth;
    } else {
      const { InMemoryOAuthStore } = await import('./store.js');
      oauthStore = new InMemoryOAuthStore();
    }
    developerGrantStore = await resolveDeveloperGrantStore({
      ...(input.pool === undefined ? {} : { pool: input.pool }),
      ...(options.developerGrantStore === undefined ? {} : { store: options.developerGrantStore }),
    });
    const [{ NoodleOAuthProvider }, { createOAuthApp }] = await Promise.all([
      import('./provider.js'),
      import('./app.js'),
    ]);
    // Normalize once so the token `iss`, the verifier's expected issuer, and the PRM `authorization_servers`
    // entry are byte-identical (a trailing-slash `PUBLIC_BASE_URL` would otherwise desync them).
    const oauthIssuer = options.oauth.issuer.replace(/\/+$/, '');
    const contributedWorkos = input.platformHumanIdentity?.upstreamAuthenticators?.workos;
    const activeWorkos = contributedWorkos;
    if (options.oauth.google === undefined && activeWorkos === undefined) {
      throw new Error('self-hosted OAuth requires at least one upstream human authenticator');
    }
    const { reconcileConfiguredFirstPartyOAuthClients } = await import('./first-party-client.js');
    await reconcileConfiguredFirstPartyOAuthClients(
      oauthStore,
      {
        ...(options.oauth.consoleClient === undefined
          ? {}
          : { console: options.oauth.consoleClient }),
        ...(options.oauth.portalClient === undefined ? {} : { portal: options.oauth.portalClient }),
      },
      normalizeOAuthResource(options.publicBaseUrl ?? oauthIssuer),
    );
    // The same issuer/signer pair backs delegated token-exchange assertions (ADR 0152) so customer
    // token endpoints verify them against the already-published platform JWKS.
    delegatedExchange = { issuer: oauthIssuer, signer: options.oauth.signer };
    const provider = new NoodleOAuthProvider({
      issuer: oauthIssuer,
      store: oauthStore,
      signer: options.oauth.signer,
      oauthClientCredentialsReady,
      tokenExchangeReady: options.oauth.controlPlaneExchange !== undefined,
      ...(options.oauth.google === undefined ? {} : { google: options.oauth.google }),
      ...(activeWorkos === undefined ? {} : { upstreamAuthenticators: { workos: activeWorkos } }),
      ...(activeWorkos === undefined || options.oauth.consoleClient === undefined
        ? {}
        : {
            workosLogoutReturnTo: consoleSignedOutReturnUrl(
              options.oauth.consoleClient.redirectUri,
            ),
          }),
      signupHintClientIds: [
        options.oauth.consoleClient?.clientId,
        options.oauth.portalClient?.clientId,
      ].filter((clientId): clientId is string => clientId !== undefined),
      ...(platformPrincipalResolver === undefined ? {} : { platformPrincipalResolver }),
      customerBridgeAuthForResource: bridgeAuthForExactResource,
      managedSecretForResource: async (resource, name) => {
        const registry = input.registry();
        return registry === undefined
          ? undefined
          : managedSecretForResource(
              registry,
              resource,
              name,
              allowedMcpDomains,
              input.controlPlaneStore,
            );
      },
      verifyCustomerBridgeToken: async (auth, token) => {
        const verification = await rawCustomerVerifierFactory(auth)(token, auth.projectId ?? '');
        return verification === null
          ? null
          : {
              ...verification.caller,
              scopes: verification.caller.scopes ?? [],
              roles: verification.caller.roles ?? [],
            };
      },
      sealCustomerCredential: (credential) => sealCustomerCredential(input.secretBox, credential),
      signupAuthorizer: input.controlPlaneStore,
      signupMode: options.controlPlaneSignupMode ?? 'restricted',
      deniedSignupDomains: options.deniedSignupDomains ?? [],
      deniedSignupSubjects: options.deniedSignupSubjects ?? [],
      ...(platformPrincipalResolver === undefined ||
      (options.controlPlaneSignupMode ?? 'restricted') !== 'public'
        ? {}
        : {
            provisionPlatformPrincipal: async (identity) => {
              await ensurePersonalWorkspace(input.controlPlaneStore, {
                ...identity,
                superAdmin: false,
              });
            },
          }),
      developerGrantAuthorizer: createDeveloperGrantAuthorizer({
        grants: developerGrantStore,
      }),
      logger: options.logger ?? noopLogger,
      defaultResourceForClient: (client) =>
        geminiEnterpriseDefaultResourceForClient(client, oauthIssuer),
      ...(options.oauth.allowedEmailDomain !== undefined
        ? { allowedEmailDomain: options.oauth.allowedEmailDomain }
        : {}),
      ...(options.oauth.refreshTokenGraceSeconds !== undefined
        ? { refreshTokenGraceSeconds: options.oauth.refreshTokenGraceSeconds }
        : {}),
      ...(options.oauth.refreshTokenRecoverySeconds !== undefined
        ? { refreshTokenRecoverySeconds: options.oauth.refreshTokenRecoverySeconds }
        : {}),
      ...(input.platformHumanIdentity?.rolloutStore === undefined
        ? {}
        : { upstreamRolloutStore: input.platformHumanIdentity.rolloutStore }),
      ...(input.platformHumanIdentity?.rollout === undefined
        ? {}
        : { upstreamRollout: input.platformHumanIdentity.rollout }),
    });
    // The first-party control-plane token exchange (ADR 0218): configured explicitly, verified
    // against our own JWKS, capability-ceilinged through the developer-grant machinery, and served
    // only for the pinned first-party tenants' live assistant clients.
    let controlPlaneExchange: ControlPlaneExchangeDeps | undefined;
    const exchangeConfig = options.oauth.controlPlaneExchange;
    if (exchangeConfig !== undefined && developerGrantStore !== undefined) {
      const oauth = options.oauth;
      const grants = developerGrantStore;
      const jtiStore = input.pool
        ? new PostgresTokenExchangeJtiStore(input.pool)
        : new InMemoryTokenExchangeJtiStore();
      if (jtiStore instanceof PostgresTokenExchangeJtiStore) await jtiStore.ensureSchema();
      const resolver = platformPrincipalResolver;
      controlPlaneExchange = {
        issuer: oauthIssuer,
        config: exchangeConfig,
        verifierKey: () => oauth.signer.verifierKey(),
        grants,
        consumeJti: (jti, expiresAtMs) => jtiStore.consume(jti, expiresAtMs, Date.now()),
        // With canonical platform identity configured, only an existing, active principal
        // exchanges; without it (legacy/local composition) subjects are opaque and the
        // control-plane gate's own signup rules remain the authority at request time.
        resolveSubject: async (subject) => {
          if (resolver === undefined) return { ok: true };
          if ((await resolver.resolveExisting(subject)) === undefined) return undefined;
          try {
            await resolver.assertActive(subject);
          } catch {
            return undefined;
          }
          return { ok: true };
        },
        listAssistantClientIds: input.listAssistantClientIds ?? (async () => []),
        ...((options.controlPlaneSignupMode ?? 'restricted') === 'public'
          ? {
              ensureWorkspace: async (identity) => {
                await ensurePersonalWorkspace(input.controlPlaneStore, {
                  ...identity,
                  superAdmin: false,
                });
              },
            }
          : {}),
        resourcePath: DEVELOPER_ASSISTANT_PATH,
        capabilityCeiling: capabilitiesForDeveloperResource(
          `${oauthIssuer}${DEVELOPER_ASSISTANT_PATH}`,
        ),
        issueAccessToken: (tokenInput) =>
          mintOAuthAccessToken({
            signer: oauth.signer,
            issuer: oauthIssuer,
            ttlSeconds: tokenInput.ttlSeconds,
            identity: {
              ownerSubject: tokenInput.subject,
              ownerEmail: tokenInput.email,
              resource: tokenInput.resource,
              scope: tokenInput.scope,
              identityKind: 'platform',
              developerGrantId: tokenInput.developerGrantId,
              oauthClientId: tokenInput.oauthClientId,
            },
          }),
        ...(input.audit === undefined ? {} : { audit: input.audit }),
      };
    }
    authServerApp = createOAuthApp(provider, {
      trustProxy: options.tls?.trustProxy === true,
      logger: options.logger ?? noopLogger,
      ...(controlPlaneExchange === undefined ? {} : { controlPlaneExchange }),
      ...(servicePrincipalRuntime === undefined
        ? {}
        : {
            servicePrincipals: {
              runtime: servicePrincipalRuntime,
              registry: input.registry,
              routing: {
                legacyOrigin: (options.publicBaseUrl ?? oauthIssuer).replace(/\/+$/, ''),
                allowedBaseDomains: allowedMcpDomains,
                resolveTenant: (ref) => resolveMcpSubdomainTenant(input.controlPlaneStore, ref),
              },
              ...(input.audit === undefined ? {} : { audit: input.audit }),
            },
          }),
    }) as (req: IncomingMessage, res: ServerResponse) => void;
    resolvedAuthServerIssuer = resolvedAuthServerIssuer ?? oauthIssuer;
    // Resource-server verification uses the AS signing key directly (co-hosted, same process), so an
    // owner-only endpoint validates tokens without an HTTP JWKS fetch. Multi-instance-safe because the key is
    // shared via env.
    resolvedVerifyOwnerToken =
      resolvedVerifyOwnerToken ??
      createJwtVerifier({
        issuer: oauthIssuer,
        keyResolver: await options.oauth.signer.verifierKey(),
      });
  }

  if (resolvedVerifyOwnerToken !== undefined) {
    const resourceRouting = {
      legacyOrigin: (options.publicBaseUrl ?? resolvedAuthServerIssuer ?? '').replace(/\/+$/, ''),
      allowedBaseDomains: allowedMcpDomains,
      resolveTenant: (ref: Parameters<typeof resolveMcpSubdomainTenant>[1]) =>
        resolveMcpSubdomainTenant(input.controlPlaneStore, ref),
    };
    resolvedVerifyOwnerToken = guardServicePrincipalAccessTokenVerifier(
      resolvedVerifyOwnerToken,
      servicePrincipalRuntime?.ready === true ? servicePrincipalRuntime.store : undefined,
      async (resource) => {
        const registry = input.registry();
        if (registry === undefined) return undefined;
        const resolved = await resolveServicePrincipalResource(resource, registry, resourceRouting);
        return resolved === undefined
          ? undefined
          : {
              org: resolved.tenant.org,
              app: resolved.tenant.app,
              environment: resolved.tenant.env,
            };
      },
    );
  }

  if (resolvedVerifyOwnerToken !== undefined && platformPrincipalResolver !== undefined) {
    resolvedVerifyOwnerToken = guardPlatformAccessTokenVerifier(
      resolvedVerifyOwnerToken,
      platformPrincipalResolver,
    );
  }

  const hostedCustomerVerifierFactory = createHostedCustomerVerifierFactory(
    rawCustomerVerifierFactory,
    resolvedVerifyOwnerToken,
    { resolveBridgeAuth },
  );

  return {
    rawCustomerVerifierFactory,
    hostedCustomerVerifierFactory,
    oauthClientCredentialsReady,
    ...(authServerApp === undefined ? {} : { authServerApp }),
    ...(resolvedVerifyOwnerToken === undefined
      ? {}
      : { verifyOwnerToken: resolvedVerifyOwnerToken }),
    ...(resolvedAuthServerIssuer === undefined
      ? {}
      : { authServerIssuer: resolvedAuthServerIssuer }),
    ...(oauthStore === undefined ? {} : { oauthStore }),
    ...(developerGrantStore === undefined ? {} : { developerGrantStore }),
    ...(servicePrincipalRuntime === undefined ? {} : { servicePrincipalRuntime }),
    ...(delegatedExchange === undefined ? {} : { delegatedExchange }),
  };
}

/** Initialize service-principal persistence without making human OAuth availability depend on it. */
export async function resolveServicePrincipalRuntime(
  pool: Pool | undefined,
  logger: Pick<Logger, 'error'>,
): Promise<ServicePrincipalRuntime> {
  if (pool === undefined) {
    return { ready: true, store: new InMemoryServicePrincipalStore() };
  }
  try {
    const { PostgresServicePrincipalStore } = await import('./service-principal-store-postgres.js');
    const store = new PostgresServicePrincipalStore(pool);
    await store.ensureSchema();
    return { ready: true, store };
  } catch {
    logger.error('oauth.service_principals.unavailable', { reason: 'schema_unavailable' });
    return { ready: false, reason: 'schema_unavailable' };
  }
}
