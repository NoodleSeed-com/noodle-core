import type { SigningKeyProvider } from '@noodle-borg/auth';
import {
  type DnsLookup,
  type GuardedFetchOptions,
  guardedFetch,
  isPublicUnicast,
  needsGuard,
} from '@noodle-borg/connector-http';
import {
  canonicalizeExternalCredentialScopes,
  EXTERNAL_CREDENTIAL_GRANT_TYPE,
  EXTERNAL_CREDENTIAL_SUBJECT_TOKEN_TYPE,
  type ExternalCredentialExchangeResponse,
  externalCredentialAudienceSchema,
  externalCredentialExchangeResponseSchema,
  externalCredentialIdentifierSchema,
  externalCredentialIssuerSchema,
  externalCredentialWorkloadInputSchema,
  signExternalCredentialWorkloadAssertion,
} from '@noodle-borg/external-credential-provider';
import type { CredentialBindingDescriptor } from '@noodle-borg/runtime';

export const EXTERNAL_CREDENTIAL_EXCHANGE_TIMEOUT_MS = 5_000;
export const EXTERNAL_CREDENTIAL_EXCHANGE_MAX_RESPONSE_BYTES = 64 * 1_024;

export interface ExternalCredentialProviderConfig {
  readonly tenantId: string;
  readonly deploymentId: string;
  readonly connectionId: string;
  /** Must equal the compiler-derived logical connection revision in the artifact descriptor. */
  readonly connectionConfigRevision: string;
  /** Deployment-owned endpoint; it never enters Core or the runtime artifact. */
  readonly endpoint: string;
  /** Exact HTTPS origin permitted for endpoint egress. */
  readonly allowedOrigin: string;
  /** JWT audience expected by this credential provider, distinct from the downstream API audience. */
  readonly assertionAudience: string;
  /** Operator revision for cache invalidation when endpoint policy changes. */
  readonly configRevision: string;
}

export interface ExternalCredentialProviderConfigLookup {
  getProviderConfig(input: {
    readonly tenantId: string;
    readonly deploymentId: string;
    readonly connectionId: string;
  }): Promise<ExternalCredentialProviderConfig | undefined>;
}

export interface ExternalCredentialSubjectPinInput {
  readonly tenantId: string;
  readonly deploymentId: string;
  readonly connectionId: string;
  readonly connectionConfigRevision: string;
  readonly connectionSubject: string;
}

/**
 * Durable hosted implementations must atomically establish or compare the subject for one compiled logical
 * connection. Returning false means a different subject was already pinned.
 */
export interface ExternalCredentialSubjectPinStore {
  pinOrVerify(input: ExternalCredentialSubjectPinInput): Promise<boolean>;
}

/** Local/test-only implementation. Multi-instance hosted runtimes must inject a durable shared CAS store. */
export class InMemoryExternalCredentialSubjectPinStore
  implements ExternalCredentialSubjectPinStore
{
  readonly #subjects = new Map<string, string>();

  async pinOrVerify(input: ExternalCredentialSubjectPinInput): Promise<boolean> {
    const key = subjectPinKey(input);
    const pinned = this.#subjects.get(key);
    if (pinned !== undefined) return pinned === input.connectionSubject;
    this.#subjects.set(key, input.connectionSubject);
    return true;
  }
}

/** Injectable self-hosted/internal adapter; hosted enrollment and durable lifecycle are deliberately absent. */
export class InMemoryExternalCredentialProviderConfigStore
  implements ExternalCredentialProviderConfigLookup
{
  readonly #configs = new Map<string, ExternalCredentialProviderConfig>();

  constructor(configs: readonly ExternalCredentialProviderConfig[] = []) {
    for (const config of configs) this.set(config);
  }

  set(config: ExternalCredentialProviderConfig): void {
    this.#configs.set(providerConfigKey(config), structuredClone(config));
  }

  async getProviderConfig(input: {
    readonly tenantId: string;
    readonly deploymentId: string;
    readonly connectionId: string;
  }): Promise<ExternalCredentialProviderConfig | undefined> {
    const config = this.#configs.get(providerConfigKey(input));
    return config === undefined ? undefined : structuredClone(config);
  }
}

type GuardedFetch = (
  url: URL,
  init: RequestInit,
  options?: GuardedFetchOptions,
) => Promise<Response>;

export interface ExternalCredentialExchangeOptions {
  readonly issuer: string;
  readonly signer: SigningKeyProvider;
  readonly tenant: string;
  readonly deployment: string;
  readonly providers: ExternalCredentialProviderConfigLookup;
  readonly subjectPins: ExternalCredentialSubjectPinStore;
  /** Test/internal seam. Production omits this and uses connector-http guarded egress. */
  readonly guardedFetch?: GuardedFetch;
  readonly dnsLookup?: DnsLookup;
  readonly timeoutSignal?: (timeoutMs: number) => AbortSignal;
}

/** In-process portable authority; the same compiled binding is still enforced by ManagedConfigBroker. */
export interface LocalExternalCredentialProvider {
  getCredential(input: {
    readonly tenantId: string;
    readonly deploymentId: string;
    readonly descriptor: CredentialBindingDescriptor;
    readonly expectedConnectionGeneration?: string;
  }): Promise<ExternalCredentialExchangeResponse>;
}
export interface LocalExternalCredentialExchangeOptions {
  readonly tenant: string;
  readonly deployment: string;
  readonly localProvider: LocalExternalCredentialProvider;
}
export type BoundExternalCredentialExchangeOptions =
  | ExternalCredentialExchangeOptions
  | LocalExternalCredentialExchangeOptions;
export type ExternalCredentialExchangeRuntimeOptions =
  | Pick<ExternalCredentialExchangeOptions, 'issuer' | 'signer' | 'providers' | 'subjectPins'>
  | Pick<LocalExternalCredentialExchangeOptions, 'localProvider'>;

export async function resolveExternalCredentialProviderConfig(
  options: ExternalCredentialExchangeOptions,
  descriptor: CredentialBindingDescriptor,
): Promise<ExternalCredentialProviderConfig | undefined> {
  const config = await options.providers.getProviderConfig({
    tenantId: options.tenant,
    deploymentId: options.deployment,
    connectionId: descriptor.connectionId,
  });
  if (
    config === undefined ||
    config.tenantId !== options.tenant ||
    config.deploymentId !== options.deployment ||
    config.connectionId !== descriptor.connectionId ||
    config.connectionConfigRevision !== descriptor.connectionConfigRevision ||
    !externalCredentialIdentifierSchema.safeParse(config.tenantId).success ||
    !externalCredentialIdentifierSchema.safeParse(config.deploymentId).success ||
    !externalCredentialIdentifierSchema.safeParse(config.connectionId).success ||
    !externalCredentialIdentifierSchema.safeParse(config.connectionConfigRevision).success ||
    !externalCredentialAudienceSchema.safeParse(config.assertionAudience).success ||
    !externalCredentialIdentifierSchema.safeParse(config.configRevision).success
  ) {
    return undefined;
  }
  try {
    validateExternalCredentialProviderEndpoint(config);
  } catch {
    return undefined;
  }
  return config;
}

export async function exchangeExternalCredential(input: {
  readonly options: ExternalCredentialExchangeOptions;
  readonly descriptor: CredentialBindingDescriptor;
  readonly config: ExternalCredentialProviderConfig;
  readonly nowMs: number;
}): Promise<ExternalCredentialExchangeResponse> {
  const endpoint = validateExternalCredentialProviderEndpoint(input.config);
  externalCredentialIssuerSchema.parse(input.options.issuer);
  const scopes = canonicalizeExternalCredentialScopes(input.descriptor.requiredScopes);
  const workload = externalCredentialWorkloadInputSchema.parse({
    tenant: input.options.tenant,
    deployment: input.options.deployment,
    connector_id: input.descriptor.connectorId,
    connector_version: input.descriptor.connectorVersion,
    operation: input.descriptor.operation,
    binding_id: input.descriptor.bindingId,
    connection_id: input.descriptor.connectionId,
    connection_revision: input.descriptor.connectionConfigRevision,
    profile: input.descriptor.profile,
    presentation: input.descriptor.presentation,
    scopes,
    ...(input.descriptor.requiredAudience === undefined
      ? {}
      : { requested_audience: input.descriptor.requiredAudience }),
  });
  const key = await input.options.signer.signingKey();
  const assertion = await signExternalCredentialWorkloadAssertion({
    issuer: input.options.issuer,
    audience: input.config.assertionAudience,
    signingKey: key,
    nowMs: input.nowMs,
    workload,
  });
  const body = new URLSearchParams({
    grant_type: EXTERNAL_CREDENTIAL_GRANT_TYPE,
    subject_token_type: EXTERNAL_CREDENTIAL_SUBJECT_TOKEN_TYPE,
    subject_token: assertion,
  });
  if (scopes.length > 0) {
    body.set('scope', scopes.join(' '));
  }
  if (input.descriptor.requiredAudience !== undefined) {
    body.set('audience', input.descriptor.requiredAudience);
  }
  const response = await (input.options.guardedFetch ?? guardedFetch)(
    endpoint,
    {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal:
        input.options.timeoutSignal?.(EXTERNAL_CREDENTIAL_EXCHANGE_TIMEOUT_MS) ??
        AbortSignal.timeout(EXTERNAL_CREDENTIAL_EXCHANGE_TIMEOUT_MS),
    },
    {
      connectTimeoutMs: EXTERNAL_CREDENTIAL_EXCHANGE_TIMEOUT_MS,
      ...(input.options.dnsLookup === undefined ? {} : { lookup: input.options.dnsLookup }),
    },
  );
  if (response.status < 200 || response.status >= 300) {
    throw new Error('external credential provider rejected the exchange');
  }
  return externalCredentialExchangeResponseSchema.parse(
    await readBoundedJson(response, EXTERNAL_CREDENTIAL_EXCHANGE_MAX_RESPONSE_BYTES),
  );
}

function validateExternalCredentialProviderEndpoint(config: ExternalCredentialProviderConfig): URL {
  if (!isVisibleBoundedUrlText(config.endpoint) || !isVisibleBoundedUrlText(config.allowedOrigin)) {
    throw new Error('external credential provider endpoint is not allowed');
  }
  const endpoint = new URL(config.endpoint);
  const allowed = new URL(config.allowedOrigin);
  if (
    endpoint.protocol !== 'https:' ||
    allowed.protocol !== 'https:' ||
    endpoint.username !== '' ||
    endpoint.password !== '' ||
    allowed.username !== '' ||
    allowed.password !== '' ||
    allowed.pathname !== '/' ||
    allowed.search !== '' ||
    allowed.hash !== '' ||
    endpoint.hash !== '' ||
    endpoint.origin !== allowed.origin
  ) {
    throw new Error('external credential provider endpoint is not allowed');
  }
  if (!needsGuard(endpoint)) {
    const literal = endpoint.hostname.replace(/^\[|\]$/g, '');
    if (!isPublicUnicast(literal)) {
      throw new Error('external credential provider endpoint is not public');
    }
  }
  return endpoint;
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error('external credential provider response is too large');
  }
  if (response.body === null) throw new Error('external credential provider response is empty');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('external credential provider response is too large');
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function providerConfigKey(input: {
  readonly tenantId: string;
  readonly deploymentId: string;
  readonly connectionId: string;
}): string {
  return JSON.stringify([input.tenantId, input.deploymentId, input.connectionId]);
}

function subjectPinKey(input: {
  readonly tenantId: string;
  readonly deploymentId: string;
  readonly connectionId: string;
  readonly connectionConfigRevision: string;
}): string {
  return JSON.stringify([
    input.tenantId,
    input.deploymentId,
    input.connectionId,
    input.connectionConfigRevision,
  ]);
}

function isVisibleBoundedUrlText(value: string): boolean {
  return value.length <= 2_048 && /^[\x21-\x7e]+$/.test(value);
}
