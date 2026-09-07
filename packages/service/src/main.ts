#!/usr/bin/env node
/**
 * The Noodle deploy service: a single stateless process that accepts tenant-scoped deploys and serves each
 * active app environment at `/o/{org}/{app}/mcp` or `/o/{org}/{app}/{env}/mcp`. Build the workspace, then run:
 *
 *   node packages/service/dist/main.js          # listens on http://127.0.0.1:8787
 *
 * Deploy a manifest with the `noodle deploy` CLI, or POST one directly.
 */
import { pathToFileURL } from 'node:url';
import type { ManagedAssistantModelResolver } from '@noodle-borg/assistant-gateway/model-runtime';
import { createJwtVerifier, createStaticSigningKeyProvider } from '@noodle-borg/auth';
import { normalizePublicBaseDomain } from '@noodle-borg/module';
import type { WrappingMasterKey } from '@noodle-borg/runtime';
import type { ModuleInput } from '@noodle-borg/service-modules';
import { createLogger, type LogLevel } from '@noodle-borg/transport-http';
import { resolveBuildInfo } from './build-info.js';
import { resolveMcpProtocolMode } from './mcp-protocol-runtime.js';
import { GoogleOAuthAuthenticator } from './oauth/google.js';
import { serveService } from './serve.js';
import type { PostgresPool } from './store/cloudsql-pool.js';
import { ResendEmailSender, resolveWelcomeEmailConfig } from './welcome-email.js';

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

export interface ServiceMainOverrides {
  readonly postgresPool?: PostgresPool;
  readonly wrappingMasterKey?: WrappingMasterKey;
  readonly modules?: readonly ModuleInput[];
  readonly persistenceLabel?: string;
  readonly keyCustodyLabel?: string;
  readonly managedAssistantModelResolver?: ManagedAssistantModelResolver;
}

/** Start the portable service process, optionally with infrastructure supplied by a private host. */
export async function runServiceMain(overrides: ServiceMainOverrides = {}): Promise<void> {
  const port = Number(process.env.PORT ?? 8787);
  const publicBaseUrl = process.env.PUBLIC_BASE_URL;
  const host = process.env.HOST;
  const googleClientId = process.env.NOODLE_GOOGLE_CLIENT_ID;
  // Extra accepted control-plane audiences beyond the primary client id (e.g. the hosted console's Google
  // web OAuth client, ADR 0116). Comma-separated; a token whose `aud` matches the primary OR any of these
  // verifies. Keeps the gcloud-CLI client working while admitting the console.
  const googleAdditionalAudiences = parseList(process.env.NOODLE_GOOGLE_ADDITIONAL_AUDIENCES);
  const googleWorkloadSubjects = parseList(process.env.NOODLE_GOOGLE_WORKLOAD_SUBJECTS);
  const googleHumanAuthCompatibility = parseOptionalBoolean(
    'NOODLE_GOOGLE_HUMAN_AUTH_ENABLED',
    process.env.NOODLE_GOOGLE_HUMAN_AUTH_ENABLED,
  );
  const controlPlaneAllowedEmailDomain =
    process.env.NOODLE_CONTROL_PLANE_ALLOWED_EMAIL_DOMAIN ?? '@noodleseed.com';
  const controlPlaneSignupMode = parseSignupMode(
    process.env.NOODLE_CONTROL_PLANE_SIGNUP_MODE ?? 'restricted',
  );
  const controlPlaneAdmins = parseList(process.env.NOODLE_CONTROL_PLANE_ADMINS);
  const dataDir = process.env.NOODLE_DATA_DIR;
  const databaseUrl = process.env.DATABASE_URL;
  const secretMasterKey = process.env.NOODLE_SECRET_MASTER_KEY;
  const mcpProtocolMode = resolveMcpProtocolMode(process.env.NOODLE_MCP_PROTOCOL_MODE);
  const intentCapturePreviewOrgs = parseList(process.env.NOODLE_INTENT_CAPTURE_PREVIEW_ORGS);
  const envLevel = process.env.NOODLE_LOG_LEVEL;
  const level: LogLevel = LOG_LEVELS.includes(envLevel as LogLevel)
    ? (envLevel as LogLevel)
    : 'info';
  const logger = createLogger({ level, base: { svc: 'noodle' } });
  // Deployed-version visibility (ADR 0080): log the running commit/version on boot so an operator can grep
  // Cloud Logging to confirm which image is live (the same fields are served at GET /v1/service/info).
  const buildInfo = resolveBuildInfo();
  logger.info('service.start', { ...buildInfo });
  const trustProxy =
    process.env.NOODLE_TRUST_PROXY === '1' || process.env.NOODLE_TRUST_PROXY === 'true';
  const customerVerifierAllowInsecureLocalhost =
    process.env.NOODLE_CUSTOMER_IDP_ALLOW_INSECURE_LOCALHOST === '1' ||
    process.env.NOODLE_CUSTOMER_IDP_ALLOW_INSECURE_LOCALHOST === 'true';
  const customerVerifierFirebaseJwksUri = process.env.NOODLE_CUSTOMER_FIREBASE_JWKS_URI;
  const mcpPublicRouting = resolveMcpPublicRouting(process.env);
  // Lazy recompile-on-first-request is the default (ADR 0036, multi-instance correctness). NOODLE_WARM_ALL
  // opts into eager recompile-all-on-boot for a pinned single-instance / on-prem deploy.
  const warmAll = process.env.NOODLE_WARM_ALL === '1' || process.env.NOODLE_WARM_ALL === 'true';
  // Owner-only end-user auth. Two modes:
  //  • Self-hosted authorization server (OA-2, ADR 0042): set NOODLE_OAUTH_ISSUER + at least one complete
  //    upstream-human provider; the service runs the AS (DCR + PKCE) and verifies owner-only tokens
  //    in-process against its own signing key. A standards client (Claude.ai/ChatGPT) can then sign in.
  //  • External issuer (OA-1): set NOODLE_OAUTH_ISSUER + NOODLE_OAUTH_JWKS_URI to validate tokens from an
  //    issuer you operate elsewhere; the runtime is only the resource server.
  // With neither, owner-only endpoints fail closed (no verifier).
  const oauthIssuer = process.env.NOODLE_OAUTH_ISSUER;
  const oauthJwksUri = process.env.NOODLE_OAUTH_JWKS_URI;
  const oauthGoogleClientId = process.env.NOODLE_OAUTH_GOOGLE_CLIENT_ID;
  const oauthGoogleSecret = process.env.NOODLE_OAUTH_GOOGLE_CLIENT_SECRET;
  const oauthGoogleRedirect = process.env.NOODLE_OAUTH_GOOGLE_REDIRECT_URI;
  const oauthSigningKey = process.env.NOODLE_OAUTH_SIGNING_KEY;
  const oauthAllowedEmailDomain = process.env.NOODLE_OAUTH_ALLOWED_EMAIL_DOMAIN;
  const oauthWorkosClientId = process.env.NOODLE_OAUTH_WORKOS_CLIENT_ID;
  const oauthWorkosApiKey = process.env.NOODLE_OAUTH_WORKOS_API_KEY;
  const oauthWorkosRealm = process.env.NOODLE_OAUTH_WORKOS_REALM;
  const oauthConsoleClientId = process.env.NOODLE_OAUTH_CONSOLE_CLIENT_ID;
  const oauthPortalClientId = process.env.NOODLE_OAUTH_PORTAL_CLIENT_ID;
  const oauthRefreshGraceSeconds = parseOptionalBoundedSeconds(
    'NOODLE_OAUTH_REFRESH_GRACE_SECONDS',
    process.env.NOODLE_OAUTH_REFRESH_GRACE_SECONDS,
  );
  const oauthRefreshRecoverySeconds = parseOptionalBoundedSeconds(
    'NOODLE_OAUTH_REFRESH_RECOVERY_SECONDS',
    process.env.NOODLE_OAUTH_REFRESH_RECOVERY_SECONDS,
  );
  const signupAllowedDomains = csv(process.env.NOODLE_SIGNUP_ALLOWED_DOMAINS);
  const signupAllowedSubjects = csv(process.env.NOODLE_SIGNUP_ALLOWED_SUBJECTS);
  const deniedSignupDomains = csv(process.env.NOODLE_SIGNUP_DENIED_DOMAINS);
  const deniedSignupSubjects = csv(process.env.NOODLE_SIGNUP_DENIED_SUBJECTS);
  const welcomeEmailConfig = resolveWelcomeEmailConfig(process.env);
  const welcomeEmailSender =
    welcomeEmailConfig !== undefined ? new ResendEmailSender(welcomeEmailConfig) : undefined;
  const configuredConsoleUrl = process.env.NOODLE_CONSOLE_URL;
  const configuredPortalUrl = process.env.NOODLE_PORTAL_URL;
  const invitationConsoleBaseUrl = configuredConsoleUrl ?? 'https://console.noodleseed.dev';
  const configuredGoogleValues = [oauthGoogleClientId, oauthGoogleSecret, oauthGoogleRedirect];
  if (
    configuredGoogleValues.some((value) => value !== undefined) &&
    configuredGoogleValues.some((value) => !value)
  ) {
    throw new Error(
      'NOODLE_OAUTH_GOOGLE_CLIENT_ID, NOODLE_OAUTH_GOOGLE_CLIENT_SECRET, and NOODLE_OAUTH_GOOGLE_REDIRECT_URI must be configured together',
    );
  }
  const googleHumanConfigured = configuredGoogleValues.every((value) => Boolean(value));
  const configuredWorkosValues = [oauthWorkosClientId, oauthWorkosApiKey, oauthWorkosRealm];
  if (
    configuredWorkosValues.some((value) => value !== undefined) &&
    configuredWorkosValues.some((value) => !value)
  ) {
    throw new Error(
      'NOODLE_OAUTH_WORKOS_CLIENT_ID, NOODLE_OAUTH_WORKOS_API_KEY, and NOODLE_OAUTH_WORKOS_REALM must be configured together',
    );
  }
  const workosConfigured = configuredWorkosValues.every((value) => Boolean(value));
  if ((googleHumanConfigured || workosConfigured) && !oauthIssuer) {
    throw new Error(
      'NOODLE_OAUTH_ISSUER is required when an upstream human OAuth provider is configured',
    );
  }
  const selfHostAuthServer = Boolean(oauthIssuer && (googleHumanConfigured || workosConfigured));
  if (oauthConsoleClientId !== undefined && (!selfHostAuthServer || !configuredConsoleUrl)) {
    throw new Error(
      'NOODLE_OAUTH_CONSOLE_CLIENT_ID requires the self-hosted OAuth server and an explicit NOODLE_CONSOLE_URL',
    );
  }
  if (oauthPortalClientId !== undefined && (!selfHostAuthServer || !configuredPortalUrl)) {
    throw new Error(
      'NOODLE_OAUTH_PORTAL_CLIENT_ID requires the self-hosted OAuth server and an explicit NOODLE_PORTAL_URL',
    );
  }
  // Self-hosted AS config (OA-2): serveService runs the AS and derives the verifier from the signing key.
  const oauth = selfHostAuthServer
    ? {
        issuer: oauthIssuer as string,
        signer: await createStaticSigningKeyProvider(
          oauthSigningKey ? { privateKeyPem: oauthSigningKey } : {},
        ),
        ...(googleHumanConfigured
          ? {
              google: new GoogleOAuthAuthenticator({
                clientId: oauthGoogleClientId as string,
                clientSecret: oauthGoogleSecret as string,
                redirectUri: oauthGoogleRedirect as string,
              }),
            }
          : {}),
        ...(oauthConsoleClientId && configuredConsoleUrl
          ? {
              consoleClient: {
                clientId: oauthConsoleClientId,
                redirectUri: new URL('/api/console/auth/callback', configuredConsoleUrl).href,
              },
            }
          : {}),
        ...(oauthPortalClientId && configuredPortalUrl
          ? {
              portalClient: {
                clientId: oauthPortalClientId,
                redirectUri: new URL('/api/portal/auth/callback', configuredPortalUrl).href,
              },
            }
          : {}),
        ...(oauthAllowedEmailDomain ? { allowedEmailDomain: oauthAllowedEmailDomain } : {}),
        ...(oauthRefreshGraceSeconds !== undefined
          ? { refreshTokenGraceSeconds: oauthRefreshGraceSeconds }
          : {}),
        ...(oauthRefreshRecoverySeconds !== undefined
          ? { refreshTokenRecoverySeconds: oauthRefreshRecoverySeconds }
          : {}),
        // The first-party control-plane token exchange (ADR 0218): all three names or none.
        ...(process.env.NOODLE_OAUTH_CONTROL_PLANE_EXCHANGE_CLIENT_ID &&
        process.env.NOODLE_OAUTH_CONTROL_PLANE_EXCHANGE_CLIENT_SECRET &&
        process.env.NOODLE_OAUTH_CONTROL_PLANE_EXCHANGE_TENANTS
          ? {
              controlPlaneExchange: {
                clientId: process.env.NOODLE_OAUTH_CONTROL_PLANE_EXCHANGE_CLIENT_ID,
                clientSecret: process.env.NOODLE_OAUTH_CONTROL_PLANE_EXCHANGE_CLIENT_SECRET,
                allowedTenants: csv(process.env.NOODLE_OAUTH_CONTROL_PLANE_EXCHANGE_TENANTS) ?? [],
              },
            }
          : {}),
      }
    : undefined;
  // External-issuer verifier (OA-1 only): used when not self-hosting the AS.
  const verifyOwnerToken =
    !selfHostAuthServer && oauthIssuer && oauthJwksUri
      ? createJwtVerifier({ issuer: oauthIssuer, jwksUri: oauthJwksUri })
      : undefined;
  const running = await serveService({
    port,
    logger,
    developerMcp: true,
    mcpProtocolMode,
    ...(intentCapturePreviewOrgs.length > 0 ? { intentCapturePreviewOrgs } : {}),
    ...(host ? { host } : {}),
    ...(publicBaseUrl ? { publicBaseUrl } : {}),
    ...(googleClientId ? { googleClientId } : {}),
    ...(googleClientId && googleAdditionalAudiences.length > 0
      ? { googleAdditionalAudiences }
      : {}),
    ...(googleWorkloadSubjects.length > 0 ? { googleWorkloadSubjects } : {}),
    ...(googleHumanAuthCompatibility !== undefined ? { googleHumanAuthCompatibility } : {}),
    ...(googleClientId ? { controlPlaneAllowedEmailDomain } : {}),
    controlPlaneSignupMode,
    ...(controlPlaneAdmins.length > 0 ? { controlPlaneAdmins } : {}),
    ...(dataDir ? { dataDir } : {}),
    ...(overrides.postgresPool !== undefined
      ? { postgresPool: overrides.postgresPool }
      : databaseUrl
        ? { databaseUrl }
        : {}),
    ...(overrides.wrappingMasterKey !== undefined
      ? { wrappingMasterKey: overrides.wrappingMasterKey }
      : secretMasterKey
        ? { secretMasterKey }
        : {}),
    ...(overrides.modules === undefined ? {} : { modules: overrides.modules }),
    ...(overrides.managedAssistantModelResolver === undefined
      ? {}
      : { managedAssistantModelResolver: overrides.managedAssistantModelResolver }),
    ...(warmAll ? { warmAll: true } : {}),
    ...(trustProxy ? { tls: { trustProxy: true } } : {}),
    // Self-hosted AS: serveService derives authServerIssuer + the in-process verifier from `oauth`.
    // External issuer: pass them explicitly.
    ...(oauth ? { oauth } : oauthIssuer ? { authServerIssuer: oauthIssuer } : {}),
    ...(signupAllowedDomains.length > 0 ? { signupAllowedDomains } : {}),
    ...(signupAllowedSubjects.length > 0 ? { signupAllowedSubjects } : {}),
    ...(deniedSignupDomains.length > 0 ? { deniedSignupDomains } : {}),
    ...(deniedSignupSubjects.length > 0 ? { deniedSignupSubjects } : {}),
    ...(welcomeEmailSender !== undefined ? { welcomeEmailSender } : {}),
    ...(welcomeEmailSender !== undefined
      ? { invitationEmailSender: welcomeEmailSender, invitationConsoleBaseUrl }
      : {}),
    ...(verifyOwnerToken ? { verifyOwnerToken } : {}),
    ...(customerVerifierAllowInsecureLocalhost
      ? { customerVerifierAllowInsecureLocalhost: true }
      : {}),
    ...(customerVerifierFirebaseJwksUri ? { customerVerifierFirebaseJwksUri } : {}),
    ...(mcpPublicRouting !== undefined ? { mcpPublicRouting } : {}),
  });

  console.log(`Noodle deploy service listening at ${running.url}`);
  console.log(
    selfHostAuthServer
      ? googleClientId
        ? 'Control auth: Noodle OAuth token required; temporary Google compatibility is enabled'
        : 'Control auth: Noodle OAuth token required; org membership gates deploys'
      : googleClientId
        ? 'Control auth: Google ID token required; org membership gates deploys'
        : 'Control auth: OPEN (localhost dev only — configure Noodle OAuth before exposing)',
  );
  console.log(`Signup:       ${controlPlaneSignupMode}`);
  const persistence =
    overrides.persistenceLabel ??
    (overrides.postgresPool !== undefined
      ? 'ON (injected Postgres)'
      : databaseUrl
        ? 'ON (Postgres)'
        : dataDir
          ? `ON (data dir ${dataDir})`
          : undefined);
  const recoveryMode = warmAll ? 'eager warm-all' : 'lazy recompile';
  const kekMode =
    overrides.keyCustodyLabel ??
    (overrides.wrappingMasterKey === undefined ? 'static key' : 'wrapping key');
  console.log(
    persistence
      ? `Persistence:  ${persistence} — deploys survive restart (${recoveryMode}), secrets sealed (${kekMode})`
      : 'Persistence:  OFF (in-memory; deploys lost on restart — set DATABASE_URL or NOODLE_DATA_DIR)',
  );
  console.log(
    trustProxy
      ? 'TLS posture:  proxy-terminated (trusting X-Forwarded-Proto; HTTPS enforced + HSTS)'
      : 'TLS posture:  direct/dev (security headers only) — set NOODLE_TRUST_PROXY behind a TLS proxy',
  );
  console.log(
    oauth
      ? `Owner auth:   self-hosted authorization server at ${oauthIssuer} (DCR + PKCE, upstream human login)`
      : verifyOwnerToken
        ? `Owner auth:   owner-only deploys validate tokens from external issuer ${oauthIssuer}`
        : 'Owner auth:   OFF (owner-only deploys fail closed — set NOODLE_OAUTH_ISSUER + an upstream human provider, or NOODLE_OAUTH_JWKS_URI)',
  );
  if (customerVerifierAllowInsecureLocalhost) {
    console.log('Customer auth: local HTTP IdP discovery enabled for loopback development only');
  }
  if (customerVerifierFirebaseJwksUri) {
    console.log('Customer auth: Firebase JWKS override enabled for development/test');
  }
  if (running.recovered) {
    const { recovered, failed } = running.recovered;
    console.log(
      `Recovered:    ${recovered} server(s)${failed.length ? `, ${failed.length} skipped (failed to recompile)` : ''}`,
    );
  }
  console.log(
    `Deploy a manifest:  POST ${running.url}/v1/orgs/<org>/apps/<app>/envs/prod/deploy   body {"manifest":"<yaml>"}`,
  );
  console.log(
    mcpPublicRouting?.publicBaseDomain !== undefined
      ? `Tenant MCP routes are served at  https://<mcp-subdomain>.${mcpPublicRouting.publicBaseDomain}/<app>/mcp`
      : `Tenant MCP routes are served at  ${running.url}/o/<org>/<app>/mcp`,
  );

  // Graceful drain (ADR 0034): on SIGTERM (Cloud Run sends it before stopping an instance) stop accepting
  // new connections, let in-flight requests finish, close the DB pool, then exit. A bounded timer
  // force-exits if the drain hangs so a stuck connection never blocks the rollout.
  let draining = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (draining) return;
    draining = true;
    logger.info('shutdown', { signal });
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    try {
      running.http.closeIdleConnections();
      await running.close();
    } catch (error) {
      logger.error('shutdown.error', { message: (error as Error).message });
    }
    clearTimeout(force);
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

function csv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseSignupMode(value: string): 'restricted' | 'public' {
  if (value === 'restricted' || value === 'public') return value;
  throw new Error('NOODLE_CONTROL_PLANE_SIGNUP_MODE must be "restricted" or "public"');
}

function parseOptionalBoundedSeconds(name: string, value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  if (!/^\d+$/.test(value))
    throw new Error(`${name} must be a non-negative integer number of seconds`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 3600) {
    throw new Error(`${name} must be between 0 and 3600 seconds`);
  }
  return parsed;
}

function parseOptionalBoolean(name: string, value: string | undefined): boolean | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error(`${name} must be true/false or 1/0`);
}

function resolveMcpPublicRouting(env: NodeJS.ProcessEnv):
  | {
      publicBaseDomain: string;
      allowedBaseDomains?: readonly string[];
      edgeToken: string;
    }
  | undefined {
  const rawPublicBaseDomain = env.NOODLE_MCP_PUBLIC_BASE_DOMAIN;
  const rawAllowedDomains = parseList(env.NOODLE_MCP_ALLOWED_BASE_DOMAINS);
  const edgeToken = env.NOODLE_MCP_EDGE_TOKEN;
  if (
    rawPublicBaseDomain === undefined &&
    rawAllowedDomains.length === 0 &&
    edgeToken === undefined
  ) {
    return undefined;
  }
  if (!rawPublicBaseDomain) {
    throw new Error('NOODLE_MCP_PUBLIC_BASE_DOMAIN is required for public MCP subdomain routing');
  }
  if (!edgeToken) {
    throw new Error('NOODLE_MCP_EDGE_TOKEN is required for public MCP subdomain routing');
  }
  const publicBaseDomain = normalizePublicBaseDomain(rawPublicBaseDomain);
  const allowedBaseDomains = uniqueDomains([publicBaseDomain, ...rawAllowedDomains]);
  return {
    publicBaseDomain,
    ...(allowedBaseDomains.length > 0 ? { allowedBaseDomains } : {}),
    edgeToken,
  };
}

function uniqueDomains(values: readonly string[]): readonly string[] {
  const out = new Set<string>();
  for (const value of values) out.add(normalizePublicBaseDomain(value));
  return [...out];
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  runServiceMain().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

function parseList(value: string | undefined): readonly string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}
