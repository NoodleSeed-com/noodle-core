import crypto from 'node:crypto';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import {
  InvalidClientMetadataError,
  OAuthError,
  ServerError,
  TooManyRequestsError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { allowedMethods } from '@modelcontextprotocol/sdk/server/auth/middleware/allowedMethods.js';
import {
  type OAuthClientInformationFull,
  OAuthClientInformationFullSchema,
  OAuthClientMetadataSchema,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  type NormalizedOAuthRedirectClientMetadata,
  normalizeOAuthClientMetadata,
  OAuthRedirectPolicyError,
  type OAuthRedirectPolicyErrorReason,
} from '@noodle-borg/auth';
import cors from 'cors';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import { type Options as RateLimitOptions, rateLimit } from 'express-rate-limit';

const DEFAULT_CLIENT_SECRET_EXPIRY_SECONDS = 30 * 24 * 60 * 60;

export type RegisteredOAuthClient = OAuthClientInformationFull &
  Omit<NormalizedOAuthRedirectClientMetadata, 'redirect_uris'> & {
    readonly redirect_uris: string[];
  };

export interface SafeClientRegistrationHandlerOptions {
  readonly clientsStore: OAuthRegisteredClientsStore;
  readonly clientSecretExpirySeconds?: number;
  readonly rateLimit?: Partial<RateLimitOptions> | false;
}

/**
 * Preserve the MCP SDK's DCR transport while retaining Noodle's normalized redirect-policy metadata.
 */
export function safeClientRegistrationHandler({
  clientsStore,
  clientSecretExpirySeconds = DEFAULT_CLIENT_SECRET_EXPIRY_SECONDS,
  rateLimit: rateLimitConfig,
}: SafeClientRegistrationHandlerOptions): RequestHandler {
  if (!clientsStore.registerClient) {
    throw new Error('Client registration store does not support registering clients');
  }

  const registerClient = clientsStore.registerClient.bind(clientsStore);
  const router = express.Router();
  router.use(cors());
  router.use(allowedMethods(['POST']));
  router.use(express.json());
  router.use(invalidJsonHandler);

  if (rateLimitConfig !== false) {
    router.use(
      rateLimit({
        windowMs: 60 * 60 * 1000,
        max: 20,
        standardHeaders: true,
        legacyHeaders: false,
        message: new TooManyRequestsError(
          'You have exceeded the rate limit for client registration requests',
        ).toResponseObject(),
        ...rateLimitConfig,
      }),
    );
  }

  router.post('/', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const parseResult = OAuthClientMetadataSchema.safeParse(req.body);
      if (!parseResult.success) {
        throw new InvalidClientMetadataError(parseResult.error.message);
      }

      const submitted = requestObject(req.body);
      const normalized = normalizeOAuthClientMetadata({
        application_type: submitted.application_type,
        redirect_uris: parseResult.data.redirect_uris,
        token_endpoint_auth_method: submitted.token_endpoint_auth_method,
        noodle_redirect_policy_version: submitted.noodle_redirect_policy_version,
      });
      const persistedPolicy = { ...normalized, redirect_uris: [...normalized.redirect_uris] };
      const issuedAt = Math.floor(Date.now() / 1000);
      const hasSecret = normalized.token_endpoint_auth_method === 'client_secret_post';
      const credentials = hasSecret
        ? {
            client_secret: crypto.randomBytes(32).toString('hex'),
            client_secret_expires_at:
              clientSecretExpirySeconds > 0 ? issuedAt + clientSecretExpirySeconds : 0,
          }
        : {};
      const client: RegisteredOAuthClient = {
        ...parseResult.data,
        ...persistedPolicy,
        ...credentials,
        client_id: crypto.randomUUID(),
        client_id_issued_at: issuedAt,
      };
      const stored = await registerClient(
        client as Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
      );
      res.status(201).json(validatedStoredClient(stored, persistedPolicy));
    } catch (error) {
      const oauthError = registrationError(error);
      const status = oauthError instanceof ServerError ? 500 : 400;
      res.status(status).json(oauthError.toResponseObject());
    }
  });

  return router;
}

const invalidJsonHandler: ErrorRequestHandler = (error, _req, res, next) => {
  if (!isInvalidJson(error)) {
    next(error);
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res
    .status(400)
    .json(new InvalidClientMetadataError('client metadata must be valid JSON').toResponseObject());
};

function isInvalidJson(error: unknown): boolean {
  if (!(error instanceof SyntaxError)) return false;
  const parseError = error as { readonly status?: unknown; readonly type?: unknown };
  return parseError.status === 400 && parseError.type === 'entity.parse.failed';
}

function requestObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function validatedStoredClient(
  value: unknown,
  normalized: NormalizedOAuthRedirectClientMetadata,
): RegisteredOAuthClient {
  const sdkRecord = OAuthClientInformationFullSchema.safeParse(value);
  const stored = requestObject(value);
  if (
    !sdkRecord.success ||
    stored.application_type !== normalized.application_type ||
    stored.token_endpoint_auth_method !== normalized.token_endpoint_auth_method ||
    stored.noodle_redirect_policy_version !== normalized.noodle_redirect_policy_version ||
    !sameRedirectUris(stored.redirect_uris, normalized.redirect_uris)
  ) {
    throw new ServerError('Internal Server Error');
  }
  return value as RegisteredOAuthClient;
}

function sameRedirectUris(actual: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function registrationError(error: unknown): OAuthError {
  if (error instanceof OAuthRedirectPolicyError) {
    return new InvalidClientMetadataError(policyErrorDescription(error.reason));
  }
  if (error instanceof OAuthError) return error;
  return new ServerError('Internal Server Error');
}

function policyErrorDescription(reason: OAuthRedirectPolicyErrorReason): string {
  switch (reason) {
    case 'invalid_application_type':
      return 'application_type must be web or native';
    case 'invalid_redirect_uris':
      return 'redirect_uris must be a non-empty list of URI strings';
    case 'unsafe_redirect_uri':
      return 'redirect_uris must use HTTPS or a permitted loopback HTTP redirect without credentials or fragments';
    case 'unsupported_token_endpoint_auth_method':
      return 'token_endpoint_auth_method must be none or client_secret_post';
  }
}
