import {
  type CredentialRequest,
  CredentialUnavailableError,
  type DownstreamCredential,
  MapServiceBroker,
} from '@noodle-borg/runtime';
import type { AllowedCredentialBinding } from './credential-binding-index.js';
import { routeBoundCredentialKey } from './credential-route-key.js';
import {
  type ExternalCredentialExchangeOptions,
  exchangeExternalCredential,
  resolveExternalCredentialProviderConfig,
} from './external-credential-exchange.js';

interface ExternalCredentialCacheEntry {
  readonly exchangeConfigKey: string;
  readonly subject: string;
  readonly revision: string;
  readonly token: string;
  readonly expiresAt: number;
}

const EXTERNAL_CREDENTIAL_TOKEN_CACHE_SAFETY_MS = 5_000;

/** Binding-scoped external exchange cache backed by a shared logical-connection subject pin. */
export class ExternalCredentialBindingBroker {
  readonly #cache = new Map<string, ExternalCredentialCacheEntry>();
  readonly #inflight = new Map<string, Promise<DownstreamCredential>>();

  constructor(
    readonly options: ExternalCredentialExchangeOptions,
    readonly now: () => number,
  ) {}

  async getCredential(
    request: CredentialRequest,
    allowed: AllowedCredentialBinding,
  ): Promise<DownstreamCredential> {
    if (
      request.tenantId !== this.options.tenant ||
      request.deploymentId !== this.options.deployment
    ) {
      throw new CredentialUnavailableError('credential_not_configured');
    }
    const pinOrVerify = resolveSubjectPinCallable(this.options.subjectPins);
    if (pinOrVerify === undefined) {
      throw new CredentialUnavailableError('credential_not_configured');
    }
    let config: Awaited<ReturnType<typeof resolveExternalCredentialProviderConfig>>;
    try {
      config = await resolveExternalCredentialProviderConfig(this.options, allowed.descriptor);
    } catch {
      throw new CredentialUnavailableError('credential_not_configured');
    }
    if (config === undefined) {
      throw new CredentialUnavailableError('credential_not_configured');
    }
    const descriptorKey = routeBoundCredentialKey(
      JSON.stringify([
        this.options.tenant,
        this.options.deployment,
        MapServiceBroker.bindingKey(allowed.descriptor),
      ]),
      request.route,
    );
    const exchangeConfigKey = JSON.stringify([
      config.configRevision,
      config.endpoint,
      config.allowedOrigin,
      config.assertionAudience,
    ]);
    const cached = this.#cache.get(descriptorKey);
    if (cached !== undefined) {
      if (cached.exchangeConfigKey === exchangeConfigKey && cached.expiresAt > this.now()) {
        return { token: cached.token };
      }
      this.#cache.delete(descriptorKey);
    }
    const exchangeKey = routeBoundCredentialKey(
      JSON.stringify([descriptorKey, exchangeConfigKey]),
      request.route,
    );
    const inflight = this.#inflight.get(exchangeKey);
    if (inflight !== undefined) return inflight;
    const promise = (async (): Promise<DownstreamCredential> => {
      let exchanged: Awaited<ReturnType<typeof exchangeExternalCredential>>;
      try {
        exchanged = await exchangeExternalCredential({
          options: this.options,
          descriptor: allowed.descriptor,
          config,
          nowMs: this.now(),
        });
        const expiresAt =
          this.now() + exchanged.expires_in * 1_000 - EXTERNAL_CREDENTIAL_TOKEN_CACHE_SAFETY_MS;
        const subjectMatches = await pinOrVerify({
          tenantId: this.options.tenant,
          deploymentId: this.options.deployment,
          connectionId: allowed.descriptor.connectionId,
          connectionConfigRevision: allowed.descriptor.connectionConfigRevision,
          connectionSubject: exchanged.connection_subject,
        });
        if (!subjectMatches) throw new Error('external credential connection subject mismatch');
        if (expiresAt <= this.now()) {
          throw new Error('external credential expired before subject pin completed');
        }
        this.#cache.set(descriptorKey, {
          exchangeConfigKey,
          subject: exchanged.connection_subject,
          revision: exchanged.connection_revision,
          token: exchanged.access_token,
          expiresAt,
        });
      } catch {
        throw new CredentialUnavailableError('credential_exchange_failed', {
          fix: 'Verify the deployment credential provider configuration and availability.',
          next: ['noodle auth doctor --live'],
        });
      }
      return { token: exchanged.access_token };
    })().finally(() => this.#inflight.delete(exchangeKey));
    this.#inflight.set(exchangeKey, promise);
    return promise;
  }
}

function resolveSubjectPinCallable(
  value: unknown,
): ExternalCredentialExchangeOptions['subjectPins']['pinOrVerify'] | undefined {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null)
    return undefined;
  try {
    const candidate = value as { readonly pinOrVerify?: unknown };
    const pinOrVerify = candidate.pinOrVerify;
    return typeof pinOrVerify === 'function'
      ? (pinOrVerify.bind(value) as ExternalCredentialExchangeOptions['subjectPins']['pinOrVerify'])
      : undefined;
  } catch {
    return undefined;
  }
}
