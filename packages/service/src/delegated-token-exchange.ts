import type { SigningKeyProvider } from '@noodle-borg/auth';
import type { DelegatedTokenExchangeBinding } from '@noodle-borg/connector-defs';
import {
  type CredentialRequest,
  CredentialUnavailableError,
  type CustomerRouteBinding,
} from '@noodle-borg/runtime';
import { SignJWT } from 'jose';
import type {
  LocalDevtoolsDelegatedExchangeBindingProjection,
  LocalDevtoolsDelegatedExchangeSuccess,
} from './local-devtools-delegated-exchange.js';

/** Assertion lifetime in seconds — long enough for one exchange round-trip, short enough to bound replay. */
const ASSERTION_TTL_SECONDS = 120;
const MAX_TOKEN_RESPONSE_BYTES = 32 * 1024;
const OAUTH_ERROR_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

export type DelegatedTokenExchangeFailureKind =
  | 'network'
  | 'redirect'
  | 'http'
  | 'oauth'
  | 'malformed_response'
  | 'response_too_large';

/** Safe, internal-only failure metadata from the untrusted token endpoint boundary. */
export class DelegatedTokenExchangeError extends Error {
  readonly kind: DelegatedTokenExchangeFailureKind;
  readonly status?: number;
  readonly oauthCode?: string;

  constructor(
    kind: DelegatedTokenExchangeFailureKind,
    options: { readonly status?: number; readonly oauthCode?: string } = {},
  ) {
    super(`delegated token exchange failed: ${kind}`);
    this.name = 'DelegatedTokenExchangeError';
    this.kind = kind;
    if (
      options.status !== undefined &&
      Number.isInteger(options.status) &&
      options.status >= 100 &&
      options.status <= 599
    ) {
      this.status = options.status;
    }
    if (options.oauthCode !== undefined && OAUTH_ERROR_CODE_PATTERN.test(options.oauthCode)) {
      this.oauthCode = options.oauthCode;
    }
  }
}

/**
 * Service wiring for the generic delegated token exchange (ADR 0152). The issuer/signer pair is the
 * platform OAuth signer whose JWKS the customer's token endpoint verifies assertions against; tenant and
 * deployment identify the calling deployment inside the assertion so the endpoint can pin them.
 */
export interface DelegatedExchangeOptions {
  readonly issuer: string;
  readonly signer: SigningKeyProvider;
  /** `org/app/env` of the deployment the broker serves. */
  readonly tenant: string;
  readonly deployment: string;
  readonly localDevtools?: true;
  readonly onAttempt?: (event: LocalDevtoolsDelegatedExchangeBindingProjection) => void;
  readonly onSuccess?: (event: LocalDevtoolsDelegatedExchangeSuccess) => void;
}

type ExchangeCaller = NonNullable<CredentialRequest['caller']> & {
  readonly audience: string;
  readonly customerIssuer: string;
};

/** The exchange represents a verified end user; anything less fails closed before any HTTP is sent. */
export function requireExchangeCaller(request: CredentialRequest): ExchangeCaller {
  const caller = request.caller;
  if (caller === undefined || caller.identityKind !== 'customer') {
    throw new CredentialUnavailableError('caller_identity_not_customer', {
      fix: 'Authenticate through the configured customer OIDC provider.',
      next: ['noodle auth doctor --live'],
    });
  }
  if (caller.subject === '') {
    throw new CredentialUnavailableError('caller_subject_missing', {
      fix: 'Configure the customer OIDC provider to issue a non-empty subject claim.',
      next: ['noodle auth doctor --live'],
    });
  }
  if (caller.audience === undefined) {
    throw new CredentialUnavailableError('caller_audience_missing', {
      fix: 'Configure and verify the expected audience for customer OIDC tokens.',
      next: ['noodle auth doctor --live'],
    });
  }
  if (request.customerIssuer === undefined || request.customerIssuer.length === 0) {
    throw new CredentialUnavailableError('caller_issuer_missing', {
      fix: 'Reconnect through the configured customer authentication flow so Noodle can bind the verified issuer.',
      next: ['noodle auth doctor --live'],
    });
  }
  return { ...caller, customerIssuer: request.customerIssuer } as ExchangeCaller;
}

/**
 * Sign the RFC 8693 `subject_token`: a short-lived, audience-bound platform assertion of the verified
 * caller. Claims are the normative contract in docs/spec/connectors.md — changing them is a contract
 * change for every customer token endpoint.
 */
export async function signExchangeAssertion(input: {
  readonly options: DelegatedExchangeOptions;
  readonly caller: ExchangeCaller;
  readonly audience: string;
  readonly nowMs: number;
  readonly route?: CustomerRouteBinding;
}): Promise<string> {
  const key = await input.options.signer.signingKey();
  const issuedAt = Math.floor(input.nowMs / 1000);
  const caller = input.caller;
  return new SignJWT({
    ...(caller.email !== undefined ? { email: caller.email } : {}),
    ...(caller.name !== undefined ? { name: caller.name } : {}),
    ...(caller.claims !== undefined ? { claims: caller.claims } : {}),
    tenant: input.options.tenant,
    deployment: input.options.deployment,
    customer_identity: {
      version: 1,
      issuer: caller.customerIssuer,
    },
    ...(input.route === undefined
      ? {}
      : {
          route: {
            key: input.route.key,
            fingerprint: input.route.fingerprint,
          },
        }),
  })
    .setProtectedHeader({ alg: key.alg, kid: key.kid, typ: 'JWT' })
    .setIssuer(input.options.issuer)
    .setSubject(caller.subject)
    .setAudience(input.audience)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + ASSERTION_TTL_SECONDS)
    .setJti(crypto.randomUUID())
    .sign(key.privateKey);
}

/** POST the RFC 8693 exchange to the customer token endpoint and parse the standard token response. */
export async function fetchDelegatedTokenExchange(input: {
  readonly binding: DelegatedTokenExchangeBinding;
  readonly clientSecret: string;
  readonly assertion: string;
  readonly fetchImpl: typeof fetch;
}): Promise<{ readonly token: string; readonly expiresIn?: number }> {
  const { binding } = input;
  const body = new URLSearchParams();
  body.set('grant_type', 'urn:ietf:params:oauth:grant-type:token-exchange');
  body.set('subject_token', input.assertion);
  body.set('subject_token_type', 'urn:ietf:params:oauth:token-type:jwt');
  if (binding.scopes !== undefined && binding.scopes.length > 0) {
    body.set('scope', binding.scopes.join(' '));
  }
  if (binding.audience !== undefined) body.set('audience', binding.audience);
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
  };
  if (binding.authMethod === 'client_secret_post') {
    body.set('client_id', binding.clientId);
    body.set('client_secret', input.clientSecret);
  } else {
    headers.authorization = `Basic ${Buffer.from(`${binding.clientId}:${input.clientSecret}`).toString('base64')}`;
  }
  let response: Response;
  try {
    response = await input.fetchImpl(binding.tokenUrl, {
      method: 'POST',
      redirect: 'manual',
      headers,
      body: body.toString(),
    });
  } catch {
    throw new DelegatedTokenExchangeError('network');
  }
  if (response.status >= 300 && response.status < 400) {
    await cancelResponseBody(response);
    throw new DelegatedTokenExchangeError('redirect', { status: response.status });
  }

  let bytes: Uint8Array;
  try {
    bytes = await readBoundedTokenResponse(response);
  } catch (error) {
    if (error instanceof DelegatedTokenExchangeError) throw error;
    throw new DelegatedTokenExchangeError('network');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    if (!response.ok) {
      throw new DelegatedTokenExchangeError('http', { status: response.status });
    }
    throw new DelegatedTokenExchangeError('malformed_response', { status: response.status });
  }
  const record =
    typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const oauthCode = record.error;
  if (typeof oauthCode === 'string' && OAUTH_ERROR_CODE_PATTERN.test(oauthCode)) {
    throw new DelegatedTokenExchangeError('oauth', {
      status: response.status,
      oauthCode,
    });
  }
  if (!response.ok) {
    throw new DelegatedTokenExchangeError('http', { status: response.status });
  }
  const token = record.access_token;
  if (typeof token !== 'string' || token === '') {
    throw new DelegatedTokenExchangeError('malformed_response', { status: response.status });
  }
  const expiresIn = Number(record.expires_in);
  return {
    token,
    ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresIn } : {}),
  };
}

async function readBoundedTokenResponse(response: Response): Promise<Uint8Array> {
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null &&
    /^\d+$/.test(declaredLength.trim()) &&
    Number(declaredLength) > MAX_TOKEN_RESPONSE_BYTES
  ) {
    await cancelResponseBody(response);
    throw new DelegatedTokenExchangeError('response_too_large', { status: response.status });
  }
  if (response.body === null) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > MAX_TOKEN_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new DelegatedTokenExchangeError('response_too_large', { status: response.status });
    }
    chunks.push(value);
    total += value.byteLength;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation is best-effort and must not replace the curated exchange failure.
  }
}
