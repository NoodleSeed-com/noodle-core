import { randomUUID } from 'node:crypto';
import type { SigningKeyProvider } from '@noodle-borg/auth';
import type { ArtifactConnectionSource } from '@noodle-borg/compiler';
import {
  type CredentialRequest,
  CredentialUnavailableError,
  type DownstreamCredential,
  MapServiceBroker,
} from '@noodle-borg/runtime';
import { SignJWT } from 'jose';
import type { AllowedCredentialBinding } from './credential-binding-index.js';
import { routeBoundCredentialKey } from './credential-route-key.js';
import {
  hasAsciiControlCharacters,
  hasWhitespaceOrAsciiControlCharacters,
} from './google-workload-identity-validation.js';
import { resolveManagedVariablesInString } from './managed-config-expressions.js';

const GOOGLE_STS_URL = 'https://sts.googleapis.com/v1/token';
const GOOGLE_IAM_CREDENTIALS_ORIGIN = 'https://iamcredentials.googleapis.com';
const GOOGLE_CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
const JWT_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:jwt';
const ASSERTION_LIFETIME_SECONDS = 3_600;
const CACHE_REFRESH_SAFETY_MS = 5 * 60 * 1_000;
const EXCHANGE_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1_024;
const PROVIDER_RE =
  /^projects\/[1-9][0-9]{5,30}\/locations\/global\/workloadIdentityPools\/[a-z][a-z0-9-]{3,31}\/providers\/[a-z][a-z0-9-]{3,31}$/;
const SERVICE_ACCOUNT_RE =
  /^[a-z0-9][a-z0-9._-]{0,62}@[a-z0-9][a-z0-9-]{0,62}\.iam\.gserviceaccount\.com$/;

export interface GoogleWorkloadIdentityRecord {
  readonly id: string;
  /** Changes on every operator-visible lifecycle mutation and invalidates cached credentials. */
  readonly revision: string;
  readonly tenantId: string;
  readonly environmentId: string;
  /** Stable OIDC subject mapped to `google.subject` by the customer's provider. */
  readonly subject: string;
  readonly active: boolean;
}

export interface GoogleWorkloadIdentityResolver {
  resolve(input: {
    readonly tenantId: string;
    readonly deploymentId: string;
  }): Promise<GoogleWorkloadIdentityRecord | undefined>;
}

export interface GoogleWorkloadIdentityOptions {
  readonly issuer: string;
  readonly signer: SigningKeyProvider;
  readonly identities: GoogleWorkloadIdentityResolver;
  readonly tenant: string;
  readonly deployment: string;
  /** Test/internal seam. Production always calls Google's fixed service endpoints. */
  readonly fetchImpl?: typeof fetch;
}

export type GoogleWorkloadIdentityRuntimeOptions = Pick<
  GoogleWorkloadIdentityOptions,
  'issuer' | 'signer' | 'identities'
>;

interface GoogleTokenCacheEntry {
  readonly configKey: string;
  readonly token: string;
  readonly expiresAt: number;
}

interface GoogleStsResponse {
  readonly accessToken: string;
  readonly expiresIn: number;
}

/** Exchanges one active Noodle deployment identity for a binding-scoped Google access token. */
export class GoogleWorkloadIdentityBindingBroker {
  readonly #cache = new Map<string, GoogleTokenCacheEntry>();
  readonly #inflight = new Map<string, Promise<DownstreamCredential>>();

  constructor(
    readonly options: GoogleWorkloadIdentityOptions,
    readonly now: () => number,
  ) {}

  async getCredential(
    request: CredentialRequest,
    allowed: AllowedCredentialBinding,
    variables: Readonly<Record<string, string>>,
  ): Promise<DownstreamCredential> {
    if (
      request.tenantId !== this.options.tenant ||
      request.deploymentId !== this.options.deployment ||
      allowed.source.kind !== 'googleWorkloadIdentity'
    ) {
      throw notConfigured();
    }
    const identity = await this.#activeIdentity();
    const source = resolveSource(allowed.source, variables);
    const descriptorKey = routeBoundCredentialKey(
      JSON.stringify([
        this.options.tenant,
        this.options.deployment,
        MapServiceBroker.bindingKey(allowed.descriptor),
      ]),
      request.route,
    );
    const configKey = routeBoundCredentialKey(
      JSON.stringify([
        identity.revision,
        source.provider,
        source.access,
        canonicalScopes(allowed.descriptor.requiredScopes),
      ]),
      request.route,
    );
    const cached = this.#cache.get(descriptorKey);
    if (cached !== undefined) {
      if (cached.configKey === configKey && cached.expiresAt > this.now()) {
        return { token: cached.token };
      }
      this.#cache.delete(descriptorKey);
    }
    const inflightKey = routeBoundCredentialKey(
      JSON.stringify([descriptorKey, configKey]),
      request.route,
    );
    const inflight = this.#inflight.get(inflightKey);
    if (inflight !== undefined) return inflight;
    const promise = this.#exchange(allowed, identity, source)
      .then((result) => {
        const expiresAt = result.expiresAt - CACHE_REFRESH_SAFETY_MS;
        if (expiresAt <= this.now()) throw new Error('Google credential lifetime is too short');
        this.#cache.set(descriptorKey, {
          configKey,
          token: result.token,
          expiresAt,
        });
        return { token: result.token };
      })
      .catch(() => {
        throw exchangeFailed();
      })
      .finally(() => this.#inflight.delete(inflightKey));
    this.#inflight.set(inflightKey, promise);
    return promise;
  }

  async #activeIdentity(): Promise<GoogleWorkloadIdentityRecord> {
    let identity: GoogleWorkloadIdentityRecord | undefined;
    try {
      identity = await this.options.identities.resolve({
        tenantId: this.options.tenant,
        deploymentId: this.options.deployment,
      });
    } catch {
      throw notConfigured();
    }
    if (
      identity === undefined ||
      !identity.active ||
      identity.tenantId !== this.options.tenant ||
      !validIdentifier(identity.id, 128) ||
      !validIdentifier(identity.revision, 128) ||
      !validIdentifier(identity.environmentId, 128) ||
      !validSubject(identity.subject)
    ) {
      throw notConfigured();
    }
    return identity;
  }

  async #exchange(
    allowed: AllowedCredentialBinding,
    identity: GoogleWorkloadIdentityRecord,
    source: ResolvedGoogleSource,
  ): Promise<{ readonly token: string; readonly expiresAt: number }> {
    const providerAudience = `//iam.googleapis.com/${source.provider}`;
    const assertion = await signGoogleSubjectToken({
      issuer: validateIssuer(this.options.issuer),
      audience: providerAudience,
      signer: this.options.signer,
      identity,
      deploymentId: this.options.deployment,
      connectionId: allowed.descriptor.connectionId,
      nowMs: this.now(),
    });
    const requestedScopes =
      source.access.kind === 'direct'
        ? canonicalScopes(allowed.descriptor.requiredScopes)
        : [GOOGLE_CLOUD_PLATFORM_SCOPE];
    const sts = await exchangeGoogleSts({
      fetchImpl: this.options.fetchImpl ?? fetch,
      audience: providerAudience,
      assertion,
      scopes: requestedScopes,
    });
    if (source.access.kind === 'direct') {
      return {
        token: sts.accessToken,
        expiresAt: this.now() + sts.expiresIn * 1_000,
      };
    }
    return impersonateServiceAccount({
      fetchImpl: this.options.fetchImpl ?? fetch,
      federatedToken: sts.accessToken,
      serviceAccount: source.access.serviceAccount,
      scopes: canonicalScopes(allowed.descriptor.requiredScopes),
    });
  }
}

type ResolvedGoogleSource = {
  readonly provider: string;
  readonly access:
    | { readonly kind: 'direct' }
    | {
        readonly kind: 'serviceAccountImpersonation';
        readonly serviceAccount: string;
      };
};

function resolveSource(
  source: Extract<ArtifactConnectionSource, { readonly kind: 'googleWorkloadIdentity' }>,
  variables: Readonly<Record<string, string>>,
): ResolvedGoogleSource {
  let provider: string;
  let serviceAccount: string | undefined;
  try {
    provider = resolveManagedVariablesInString(source.provider, variables);
    serviceAccount =
      source.access.kind === 'serviceAccountImpersonation'
        ? resolveManagedVariablesInString(source.access.serviceAccount, variables)
        : undefined;
  } catch {
    throw notConfigured();
  }
  if (!PROVIDER_RE.test(provider)) throw notConfigured();
  if (serviceAccount !== undefined && !SERVICE_ACCOUNT_RE.test(serviceAccount)) {
    throw notConfigured();
  }
  return {
    provider,
    access:
      serviceAccount === undefined
        ? { kind: 'direct' }
        : { kind: 'serviceAccountImpersonation', serviceAccount },
  };
}

async function signGoogleSubjectToken(input: {
  readonly issuer: string;
  readonly audience: string;
  readonly signer: SigningKeyProvider;
  readonly identity: GoogleWorkloadIdentityRecord;
  readonly deploymentId: string;
  readonly connectionId: string;
  readonly nowMs: number;
}): Promise<string> {
  const key = await input.signer.signingKey();
  if (key.alg !== 'RS256') throw new Error('Google workload identity requires RS256');
  const nowSeconds = Math.floor(input.nowMs / 1_000);
  return new SignJWT({
    tenant_id: input.identity.tenantId,
    environment_id: input.identity.environmentId,
    workload_id: input.identity.id,
    deployment_id: input.deploymentId,
    connection_id: input.connectionId,
  })
    .setProtectedHeader({ alg: key.alg, kid: key.kid, typ: 'JWT' })
    .setIssuer(input.issuer)
    .setSubject(input.identity.subject)
    .setAudience(input.audience)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + ASSERTION_LIFETIME_SECONDS)
    .setJti(randomUUID())
    .sign(key.privateKey);
}

async function exchangeGoogleSts(input: {
  readonly fetchImpl: typeof fetch;
  readonly audience: string;
  readonly assertion: string;
  readonly scopes: readonly string[];
}): Promise<GoogleStsResponse> {
  const response = await input.fetchImpl(GOOGLE_STS_URL, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grantType: TOKEN_EXCHANGE_GRANT,
      audience: input.audience,
      scope: input.scopes.join(' '),
      requestedTokenType: ACCESS_TOKEN_TYPE,
      subjectToken: input.assertion,
      subjectTokenType: JWT_TOKEN_TYPE,
    }),
    signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error('Google STS rejected the token exchange');
  const body = await readBoundedJson(response);
  if (
    !isRecord(body) ||
    typeof body.access_token !== 'string' ||
    body.access_token.length < 1 ||
    body.access_token.length > 16_384 ||
    body.token_type !== 'Bearer' ||
    body.issued_token_type !== ACCESS_TOKEN_TYPE ||
    !Number.isInteger(body.expires_in) ||
    (body.expires_in as number) < 1 ||
    (body.expires_in as number) > 43_200
  ) {
    throw new Error('Google STS returned an invalid response');
  }
  return { accessToken: body.access_token, expiresIn: body.expires_in as number };
}

async function impersonateServiceAccount(input: {
  readonly fetchImpl: typeof fetch;
  readonly federatedToken: string;
  readonly serviceAccount: string;
  readonly scopes: readonly string[];
}): Promise<{ readonly token: string; readonly expiresAt: number }> {
  const encodedAccount = encodeURIComponent(input.serviceAccount);
  const response = await input.fetchImpl(
    `${GOOGLE_IAM_CREDENTIALS_ORIGIN}/v1/projects/-/serviceAccounts/${encodedAccount}:generateAccessToken`,
    {
      method: 'POST',
      redirect: 'manual',
      headers: {
        authorization: `Bearer ${input.federatedToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ scope: input.scopes, lifetime: '3600s' }),
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    },
  );
  if (!response.ok) throw new Error('Google IAM Credentials rejected impersonation');
  const body = await readBoundedJson(response);
  if (
    !isRecord(body) ||
    typeof body.accessToken !== 'string' ||
    body.accessToken.length < 1 ||
    body.accessToken.length > 16_384 ||
    typeof body.expireTime !== 'string'
  ) {
    throw new Error('Google IAM Credentials returned an invalid response');
  }
  const expiresAt = Date.parse(body.expireTime);
  if (!Number.isFinite(expiresAt)) {
    throw new Error('Google IAM Credentials returned an invalid expiration');
  }
  return { token: body.accessToken, expiresAt };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new Error('Google credential response is too large');
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new Error('Google credential response is too large');
  }
  return JSON.parse(text) as unknown;
}

function validateIssuer(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('Google workload issuer must be an HTTPS origin');
  }
  return url.origin;
}

function canonicalScopes(values: readonly string[]): readonly string[] {
  const scopes = [...new Set(values)].sort();
  if (
    scopes.length < 1 ||
    scopes.some(
      (scope) =>
        !scope.startsWith('https://www.googleapis.com/auth/') ||
        scope.length > 512 ||
        hasWhitespaceOrAsciiControlCharacters(scope),
    )
  ) {
    throw new Error('invalid Google OAuth scopes');
  }
  return scopes;
}

function validIdentifier(value: string, maxLength: number): boolean {
  return value.length > 0 && value.length <= maxLength && !hasAsciiControlCharacters(value);
}

function validSubject(value: string): boolean {
  return validIdentifier(value, 127) && Buffer.byteLength(value, 'utf8') <= 127;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function notConfigured(): CredentialUnavailableError {
  return new CredentialUnavailableError('credential_not_configured');
}

function exchangeFailed(): CredentialUnavailableError {
  return new CredentialUnavailableError('credential_exchange_failed', {
    fix: 'Verify the Google workload identity provider, IAM grants, and service availability.',
    next: ['noodle auth doctor --live'],
  });
}
