import { revocationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/revoke.js';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import * as registry from '@noodle-borg/oauth-client-registry';
import express, { type Express, type Request, type Response } from 'express';
import { rateLimit as createRateLimit } from 'express-rate-limit';
import { renderOAuthErrorPage } from './branding.js';
import {
  CONTROL_PLANE_EXCHANGE_GRANT_TYPE,
  type ControlPlaneExchangeDeps,
  handleDelegatedControlPlaneTokenExchange,
} from './delegated-control-plane-token-handler.js';
import type { NoodleOAuthProvider } from './provider.js';
import {
  handleServicePrincipalToken,
  type ServicePrincipalTokenHandlerOptions,
} from './service-principal-token-handler.js';

/**
 * Build the minimal Express sub-app for the self-hosted authorization server (OA-2,
 * [ADR 0042](../../../../docs/decisions/0042-self-hosted-oauth-authorization-server.md)). It composes the MCP
 * SDK's **individual** handlers — `authorize`, `token`, `register` (DCR) — rather than the whole
 * `mcpAuthRouter`, because that router's protected-resource metadata is single-resource and we keep OA-1's
 * dynamic per-tenant PRM in the raw `node:http` front-door. Authorization-server metadata (RFC 8414) + JWKS +
 * upstream-human callbacks + the consent endpoint are added here. The app is a `(req, res)` listener the
 * front-door delegates to for {@link isAuthServerPath} paths.
 */
export interface OAuthAppOptions extends Pick<registry.SafeAuthorizationHandlerOptions, 'logger'> {
  readonly trustProxy?: boolean;
  readonly servicePrincipals?: ServicePrincipalTokenHandlerOptions;
  /** The first-party control-plane token exchange (ADR 0218); absent = the grant type is refused. */
  readonly controlPlaneExchange?: ControlPlaneExchangeDeps;
}

export function createOAuthApp(
  provider: NoodleOAuthProvider,
  options: OAuthAppOptions = {},
): Express {
  const app = express();
  app.disable('x-powered-by');
  if (options.trustProxy) app.set('trust proxy', true);

  const rateLimit = {
    keyGenerator: (req: Request) => rateLimitKey(req, options.trustProxy === true),
    validate: {
      forwardedHeader: false,
      keyGeneratorIpFallback: false,
      xForwardedForHeader: false,
    },
  };

  app.use(
    ['/device_authorization', '/device', '/oauth/device/callback'],
    createRateLimit({
      windowMs: 60_000,
      limit: 30,
      standardHeaders: true,
      legacyHeaders: false,
      ...rateLimit,
    }),
    createRateLimit({
      windowMs: 60_000,
      limit: 600,
      standardHeaders: false,
      legacyHeaders: false,
      keyGenerator: transportRateLimitKey,
      validate: rateLimit.validate,
    }),
  );
  const deviceTokenRateLimit = createRateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    ...rateLimit,
  });
  const deviceTokenTransportRateLimit = createRateLimit({
    windowMs: 60_000,
    limit: 600,
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator: transportRateLimitKey,
    validate: rateLimit.validate,
  });
  const clientCredentialsRateLimit = createRateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    ...rateLimit,
  });
  const clientCredentialsTransportRateLimit = createRateLimit({
    windowMs: 60_000,
    limit: 600,
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator: transportRateLimitKey,
    validate: rateLimit.validate,
  });

  const authorizationIssuer = provider.metadata().issuer;
  if (typeof authorizationIssuer !== 'string') {
    throw new Error('authorization server metadata is missing its issuer');
  }
  app.use('/authorize', addAuthorizationErrorIssuer(authorizationIssuer));
  app.use(
    '/authorize',
    registry.safeAuthorizationHandler({ provider, rateLimit, logger: options.logger }),
  );
  app.post(
    '/device_authorization',
    express.urlencoded({ extended: false }),
    (req: Request, res: Response) => {
      void provider.deviceAuthorizationFlow
        .handleAuthorization(req, res)
        .catch(() => failJson(res));
    },
  );
  app.get('/device', (req: Request, res: Response) => {
    provider.deviceAuthorizationFlow.handleVerificationPage(req, res);
  });
  app.post('/device', express.urlencoded({ extended: false }), (req: Request, res: Response) => {
    void provider.deviceAuthorizationFlow.handleVerification(req, res).catch(() => failPlain(res));
  });
  app.get('/oauth/device/callback', (req: Request, res: Response) => {
    void provider.deviceAuthorizationFlow.handleCallback(req, res).catch(() => failPlain(res));
  });
  app.use(express.urlencoded({ extended: false }));
  app.use('/token', allowCors);
  app.use('/token', (req: Request, res: Response, next: () => void) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const servicePrincipals = options.servicePrincipals;
    if (body.grant_type !== 'client_credentials' || servicePrincipals === undefined) {
      next();
      return;
    }
    clientCredentialsTransportRateLimit(req, res, () => {
      clientCredentialsRateLimit(req, res, () => {
        void handleServicePrincipalToken(req, res, provider, servicePrincipals).catch(() =>
          failJson(res),
        );
      });
    });
  });
  app.use('/token', (req: Request, res: Response, next: () => void) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const controlPlaneExchange = options.controlPlaneExchange;
    if (
      body.grant_type !== CONTROL_PLANE_EXCHANGE_GRANT_TYPE ||
      controlPlaneExchange === undefined
    ) {
      next();
      return;
    }
    clientCredentialsTransportRateLimit(req, res, () => {
      clientCredentialsRateLimit(req, res, () => {
        void handleDelegatedControlPlaneTokenExchange(req, res, controlPlaneExchange).catch(() =>
          failJson(res),
        );
      });
    });
  });
  app.use('/token', (req: Request, res: Response, next: () => void) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.grant_type !== 'urn:ietf:params:oauth:grant-type:device_code') {
      next();
      return;
    }
    deviceTokenTransportRateLimit(req, res, () => {
      deviceTokenRateLimit(req, res, () => {
        void provider.deviceAuthorizationFlow.handleToken(req, res).catch(() => failJson(res));
      });
    });
  });
  app.use('/token', tokenHandler({ provider, rateLimit }));
  app.use('/revoke', revocationHandler({ provider, rateLimit }));
  app.use(
    '/register',
    registry.safeClientRegistrationHandler({ clientsStore: provider.clientsStore, rateLimit }),
  );

  // RFC 8414 AS metadata + JWKS — fetched cross-origin by web MCP clients, so allow any origin.
  app.get('/.well-known/oauth-authorization-server', allowCors, (_req: Request, res: Response) => {
    res.json(provider.metadata());
  });
  // Google WIF OIDC providers require discovery at this exact path. The workload subject tokens use
  // the same issuer and RS256 key set as the authorization server, but are minted only inside the broker.
  app.get('/.well-known/openid-configuration', allowCors, (_req: Request, res: Response) => {
    const metadata = provider.metadata();
    res.json({
      ...metadata,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
    });
  });
  app.get('/.well-known/jwks.json', allowCors, (_req: Request, res: Response) => {
    void provider
      .jwks()
      .then((jwks) => res.json(jwks))
      .catch(() => res.status(500).json({ error: 'server_error' }));
  });

  // Upstream federation callbacks + the mandatory consent decision (confused-deputy mitigation).
  app.get('/oauth/google/callback', (req: Request, res: Response) => {
    void provider.handleGoogleCallback(req, res).catch(() => failPlain(res));
  });
  app.get('/oauth/workos/callback', (req: Request, res: Response) => {
    void provider.handleWorkOSCallback(req, res).catch(() => failPlain(res));
  });
  app.get('/oauth/workos/logout', (req: Request, res: Response) => {
    void provider.handleWorkOSLogout(req, res).catch(() => failPlain(res));
  });
  app.post('/oauth/upstream/continue', (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    void provider.handleUpstreamProviderChoice(req, res).catch(() => failPlain(res));
  });
  app.post(
    '/oauth/consent',
    express.urlencoded({ extended: false }),
    (req: Request, res: Response) => {
      void provider.handleConsent(req, res).catch(() => failPlain(res));
    },
  );
  app.post(
    '/oauth/developer-grant',
    express.urlencoded({ extended: false }),
    (req: Request, res: Response) => {
      void provider.handleDeveloperGrant(req, res).catch(() => failPlain(res));
    },
  );
  app.post(
    '/oauth/customer/firebase/callback',
    express.urlencoded({ extended: false }),
    (req: Request, res: Response) => {
      void provider.handleFirebaseCustomerCallback(req, res).catch(() => failPlain(res));
    },
  );
  app.get('/oauth/customer/firebase/authorize', (req: Request, res: Response) => {
    void provider.handleFirebaseCustomerAuthorize(req, res).catch(() => failPlain(res));
  });
  app.get('/oauth/customer/firebase/callback', (req: Request, res: Response) => {
    void provider.handleFirebaseCustomerCallback(req, res).catch(() => failPlain(res));
  });
  app.get('/oauth/customer/microsoft/callback', (req: Request, res: Response) => {
    void provider.handleMicrosoftCustomerCallback(req, res).catch(() => failPlain(res));
  });

  return app;
}

function allowCors(_req: Request, res: Response, next: () => void): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
}

/**
 * The v1 SDK owns authorization request validation but predates RFC 9207. Decorate only its redirects
 * containing an OAuth error; provider-owned success, denial, and callback redirects already use the shared
 * authorization-response helper, while upstream identity-provider redirects must remain untouched.
 */
function addAuthorizationErrorIssuer(
  issuer: string,
): (_req: Request, res: Response, next: () => void) => void {
  return (_req, res, next) => {
    const location = res.location;
    res.location = function locationWithIssuer(url: string): Response {
      let target = url;
      try {
        const parsed = new URL(url);
        if (parsed.searchParams.has('error')) {
          parsed.searchParams.set('iss', issuer);
          target = parsed.href;
        }
      } catch {
        // Express retains ownership of invalid-location handling.
      }
      return location.call(this, target);
    };
    next();
  };
}

function failPlain(res: Response): void {
  if (!res.headersSent) res.status(500).type('text/html').send(renderOAuthErrorPage());
}

function failJson(res: Response): void {
  if (!res.headersSent) res.status(500).json({ error: 'server_error' });
}

function rateLimitKey(req: Request, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = firstForwardedFor(req.headers.forwarded);
    if (forwarded) return forwarded;
    const xForwardedFor = firstHeaderValue(req.headers['x-forwarded-for']);
    if (xForwardedFor) return xForwardedFor.split(',')[0]?.trim() ?? xForwardedFor;
  }
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

function transportRateLimitKey(req: Request): string {
  return req.socket.remoteAddress ?? 'unknown';
}

function firstForwardedFor(value: string | string[] | undefined): string | undefined {
  const raw = firstHeaderValue(value);
  if (!raw) return undefined;
  const first = raw.split(',')[0] ?? raw;
  const found = /(?:^|;)\s*for=(?:"?)([^;"]+)/i.exec(first);
  return found?.[1]?.trim();
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
