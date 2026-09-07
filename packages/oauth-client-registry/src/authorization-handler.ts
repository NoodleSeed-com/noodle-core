import {
  InvalidRequestError,
  ServerError,
  TooManyRequestsError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { allowedMethods } from '@modelcontextprotocol/sdk/server/auth/middleware/allowedMethods.js';
import type { OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  classifyStoredOAuthRedirectPolicy,
  matchOAuthAuthorizationRedirect,
  type OAuthRedirectMatchResult,
} from '@noodle-borg/auth';
import express, { type RequestHandler } from 'express';
import { type Options as RateLimitOptions, rateLimit } from 'express-rate-limit';
import {
  type OAuthLegacyRedirectRollout,
  stageALegacyRedirectRollout,
} from './legacy-redirect-rollout.js';

const POLICY_ERROR_DESCRIPTION = 'redirect_uri is not permitted for this client';
const LEGACY_OBSERVATION_EVENT = 'oauth.authorization_redirect.legacy_observed';

type ObservedLegacyPolicyClass = 'safe_loopback_legacy' | 'unsafe_legacy' | 'malformed_legacy';

export type AuthorizationRedirectScalarFields = Readonly<Record<string, string | number | boolean>>;

export interface AuthorizationRedirectLogger {
  info(event: string, scalarFields: AuthorizationRedirectScalarFields): void;
}

export interface SafeAuthorizationHandlerOptions {
  readonly provider: OAuthServerProvider;
  readonly logger?: AuthorizationRedirectLogger | undefined;
  readonly rollout?: OAuthLegacyRedirectRollout;
  readonly rateLimit?: Partial<RateLimitOptions> | false;
}

/** Guard authorization redirects with Noodle policy before the SDK can redirect to a client callback. */
export function safeAuthorizationHandler({
  provider,
  logger = NOOP_LOGGER,
  rollout = stageALegacyRedirectRollout,
  rateLimit: rateLimitConfig,
}: SafeAuthorizationHandlerOptions): RequestHandler {
  const router = express.Router();
  router.use(allowedMethods(['GET', 'POST']));
  router.use(express.urlencoded({ extended: false }));
  if (rateLimitConfig !== false) {
    router.use(
      rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 100,
        standardHeaders: true,
        legacyHeaders: false,
        message: new TooManyRequestsError(
          'You have exceeded the rate limit for authorization requests',
        ).toResponseObject(),
        ...rateLimitConfig,
      }),
    );
  }
  router.use(authorizationRedirectGuard(provider, logger, rollout));
  router.use(authorizationHandler({ provider, rateLimit: false }));
  return router;
}

function authorizationRedirectGuard(
  provider: OAuthServerProvider,
  logger: AuthorizationRedirectLogger,
  rollout: OAuthLegacyRedirectRollout,
): RequestHandler {
  return async (req, res, next) => {
    const phaseOne = phaseOneInput(req.method === 'POST' ? req.body : req.query);
    if (phaseOne === undefined) {
      next();
      return;
    }

    let client: OAuthClientInformationFull | undefined;
    try {
      client = await provider.clientsStore.getClient(phaseOne.clientId);
    } catch {
      rejectStoreFailure(res);
      return;
    }
    if (client === undefined) {
      next();
      return;
    }

    const effectiveRedirectUri =
      phaseOne.redirectUri ?? soleRegisteredRedirectUri(client.redirect_uris);
    if (effectiveRedirectUri === undefined) {
      next();
      return;
    }

    const policyClass = classifyStoredOAuthRedirectPolicy(client);
    const match = matchOAuthAuthorizationRedirect({
      client,
      requestedRedirectUri: effectiveRedirectUri,
      allowLegacyLoopbackPortSubstitution: rollout.loopbackPortMode === 'observe',
    });

    if (policyClass === 'unsafe_legacy' || policyClass === 'malformed_legacy') {
      observeLegacy(logger, policyClass, match);
      if (rollout.unsafeLegacyMode === 'observe') {
        next();
        return;
      }
      rejectRedirect(res);
      return;
    }

    if (policyClass === 'safe_loopback_legacy' && match.usedLegacyLoopbackPortSubstitution) {
      observeLegacy(logger, policyClass, match);
    }
    if (!match.allowed) {
      rejectRedirect(res);
      return;
    }
    next();
  };
}

function soleRegisteredRedirectUri(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length !== 1) return undefined;
  const [redirectUri] = value;
  return typeof redirectUri === 'string' && URL.canParse(redirectUri) ? redirectUri : undefined;
}

function phaseOneInput(
  value: unknown,
): { readonly clientId: string; readonly redirectUri?: string } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const input = value as Record<string, unknown>;
  if (typeof input.client_id !== 'string') return undefined;
  if (input.redirect_uri === undefined) return { clientId: input.client_id };
  if (typeof input.redirect_uri !== 'string' || !URL.canParse(input.redirect_uri)) return undefined;
  return { clientId: input.client_id, redirectUri: input.redirect_uri };
}

function observeLegacy(
  logger: AuthorizationRedirectLogger,
  policyClass: ObservedLegacyPolicyClass,
  match: OAuthRedirectMatchResult,
): void {
  try {
    logger.info(LEGACY_OBSERVATION_EVENT, {
      policyClass,
      reason: match.reason,
      allowed: match.allowed,
      usedLegacyLoopbackPortSubstitution: match.usedLegacyLoopbackPortSubstitution,
    });
  } catch {
    // Observation telemetry is non-authoritative and must not change authorization behavior.
  }
}

function rejectRedirect(res: Parameters<RequestHandler>[1]): void {
  res.setHeader('Cache-Control', 'no-store');
  res.status(400).json(new InvalidRequestError(POLICY_ERROR_DESCRIPTION).toResponseObject());
}

function rejectStoreFailure(res: Parameters<RequestHandler>[1]): void {
  res.setHeader('Cache-Control', 'no-store');
  res.status(500).json(new ServerError('Internal Server Error').toResponseObject());
}

const NOOP_LOGGER: AuthorizationRedirectLogger = { info: () => undefined };
