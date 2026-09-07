import { delegatedAuthOperationKeys } from '@noodle-borg/assistant-gateway/portable';
import type { ClientCredentialsBinding, SecretBinding } from '@noodle-borg/connector-defs';
import {
  type CredentialBindingDescriptor,
  type CredentialBroker,
  type CredentialProbeRouteResolver,
  type CredentialRequest,
  CredentialUnavailableError,
  credentialBindingDescriptorFromRequest,
  type DelegatedCredentialProbe,
  type DownstreamCredential,
  MapServiceBroker,
} from '@noodle-borg/runtime';
import {
  fetchCustomClientCredentials,
  fetchOAuth2ClientCredentials,
} from './client-credentials-fetch.js';
import {
  type AllowedCredentialBinding,
  buildCredentialBindingIndex,
} from './credential-binding-index.js';
import {
  exchangeFirebaseTokenForSessionCookie,
  type FirebaseRefreshResult,
  fetchFirebaseRefreshToken,
  fetchMicrosoftRefreshToken,
  type MicrosoftDelegatedBinding,
  type MicrosoftRefreshResult,
  requireFirebaseCaller,
  requireFirebaseProvider,
  requireMicrosoftCaller,
  requireMicrosoftDelegatedBinding,
} from './credential-broker-delegated-refresh.js';
import { DelegatedTokenExchangeBroker } from './credential-broker-delegated-token-exchange.js';
import { probeCredentials } from './credential-probes.js';
import { assertCredentialRequestRoute } from './credential-route-guard.js';
import { routeBoundCredentialKey } from './credential-route-key.js';
import { ExternalCredentialBindingBroker } from './external-credential-binding-broker.js';
import { GoogleWorkloadIdentityBindingBroker } from './google-workload-identity.js';
import { probeGoogleWorkloadIdentityCredentials } from './google-workload-identity-probe.js';
import type { ManagedConfigBrokerOptions } from './managed-config-broker-options.js';
import { resolveManagedVariablesInString } from './managed-config-expressions.js';
import type { ConfigScope, ConfigStore } from './store.js';

export type { ManagedConfigBrokerOptions } from './managed-config-broker-options.js';

export class ManagedConfigBroker implements CredentialBroker {
  readonly #bindings = new Map<string, SecretBinding>();
  readonly #oauthCache = new Map<string, { token: string; expiresAt: number }>();
  readonly #delegatedCache = new Map<string, DownstreamCredential & { expiresAt: number }>();
  readonly #delegatedInflight = new Map<string, Promise<DownstreamCredential>>();
  readonly #delegatedTokenExchangeBroker: DelegatedTokenExchangeBroker;
  readonly #externalExchangeBroker: ExternalCredentialBindingBroker | undefined;
  readonly #googleWorkloadIdentityBroker: GoogleWorkloadIdentityBindingBroker | undefined;
  readonly #store: ConfigStore;
  readonly #scope: ConfigScope;
  readonly #options: ManagedConfigBrokerOptions;
  readonly #allowedBindings: ReadonlyMap<string, AllowedCredentialBinding>;
  readonly #externalExchangeBindings: readonly AllowedCredentialBinding[];
  readonly #googleWorkloadIdentityBindings: readonly AllowedCredentialBinding[];

  constructor(
    bindings: readonly SecretBinding[],
    store: ConfigStore,
    scope: ConfigScope,
    options: ManagedConfigBrokerOptions = {},
  ) {
    this.#store = store;
    this.#scope = scope;
    this.#options = options;
    this.#delegatedTokenExchangeBroker = new DelegatedTokenExchangeBroker(
      store,
      scope,
      options,
      this.#delegatedCache,
      this.#delegatedInflight,
    );
    this.#externalExchangeBroker =
      options.externalCredentialExchange === undefined
        ? undefined
        : new ExternalCredentialBindingBroker(options.externalCredentialExchange, () =>
            this.#now(),
          );
    this.#googleWorkloadIdentityBroker =
      options.googleWorkloadIdentity === undefined
        ? undefined
        : new GoogleWorkloadIdentityBindingBroker(options.googleWorkloadIdentity, () =>
            this.#now(),
          );
    const bindingIndex = buildCredentialBindingIndex(options.artifact);
    this.#allowedBindings = bindingIndex.byKey;
    this.#externalExchangeBindings = bindingIndex.externalExchange;
    this.#googleWorkloadIdentityBindings = bindingIndex.googleWorkloadIdentity;
    for (const binding of bindings) {
      this.#bindings.set(MapServiceBroker.key(binding.connectorId, binding.operation), binding);
    }
  }

  /**
   * Join keys for caller-derived (delegated) bindings, consumed by the assistant's elevation
   * intercept (ADR 0201, amended 2026-08-19). Service-internal and duck-typed at the call site:
   * a broker without this method simply leaves the `${user}`/authorization classification alone.
   */
  assistantDelegatedAuthKeys(): ReadonlySet<string> {
    return delegatedAuthOperationKeys([...this.#bindings.values()]);
  }

  async getCredential(request: CredentialRequest): Promise<DownstreamCredential> {
    const descriptor = credentialBindingDescriptorFromRequest(request);
    if (descriptor !== undefined) return this.#bindingCredential(request, descriptor);
    const opBinding =
      request.operation !== undefined
        ? this.#bindings.get(MapServiceBroker.key(request.connectorId, request.operation))
        : undefined;
    const binding = opBinding ?? this.#bindings.get(MapServiceBroker.key(request.connectorId));
    if (binding === undefined) return { token: '' };
    assertCredentialRequestRoute(request, binding.customerEndpoint);
    if (binding.authKind === 'delegatedOAuth') {
      return this.#delegatedBearerCredential(binding, request);
    }
    if (binding.authKind === 'delegatedSessionCookie') {
      return this.#delegatedSessionCookieCredential(binding, request);
    }
    if (binding.authKind === 'delegatedTokenExchange') {
      return this.#delegatedTokenExchangeBroker.getCredential(binding, request);
    }
    const secrets = await this.#store.resolveConfigValues('secret', this.#scope);
    if (binding.secretRef === undefined)
      throw new Error('managed secret binding missing secretRef');
    const secret = secrets[binding.secretRef];
    if (secret === undefined) throw new Error(`missing managed secret "${binding.secretRef}"`);
    if (binding.authKind === 'clientCredentials' && binding.clientCredentials !== undefined) {
      const token = await this.#clientCredentialsToken(binding, secret, request);
      return { token };
    }
    const token = secret;
    return { token };
  }

  async #bindingCredential(
    request: CredentialRequest,
    descriptor: CredentialBindingDescriptor,
  ): Promise<DownstreamCredential> {
    const allowed = this.#allowedBindings.get(MapServiceBroker.bindingKey(descriptor));
    if (allowed === undefined) {
      throw new CredentialUnavailableError('credential_not_configured');
    }
    assertCredentialRequestRoute(request, allowed.customerEndpoint);
    if (allowed.source.kind === 'externalExchange') {
      if (this.#externalExchangeBroker === undefined) {
        throw new CredentialUnavailableError('credential_not_configured');
      }
      return this.#externalExchangeBroker.getCredential(request, allowed);
    }
    if (allowed.source.kind === 'googleWorkloadIdentity') {
      if (this.#googleWorkloadIdentityBroker === undefined) {
        throw new CredentialUnavailableError('credential_not_configured');
      }
      let variables: Record<string, string>;
      try {
        variables = await this.#store.resolveConfigValues('variable', this.#scope);
      } catch {
        throw new CredentialUnavailableError('credential_not_configured');
      }
      return this.#googleWorkloadIdentityBroker.getCredential(request, allowed, variables);
    }
    if (allowed.source.kind !== 'managedSecret') {
      throw new CredentialUnavailableError('credential_not_configured');
    }
    const secrets = await this.#store.resolveConfigValues('secret', this.#scope);
    const secret = secrets[allowed.source.secret];
    if (secret === undefined) throw new CredentialUnavailableError('credential_not_configured');
    return { token: secret };
  }

  async probeDelegatedCredentials(
    caller: NonNullable<CredentialRequest['caller']>,
    resolveRoute?: CredentialProbeRouteResolver,
    customerIssuer?: string,
  ): Promise<readonly DelegatedCredentialProbe[]> {
    return probeCredentials({
      caller,
      ...(customerIssuer === undefined ? {} : { customerIssuer }),
      ...(resolveRoute === undefined ? {} : { resolveRoute }),
      externalBindings: this.#externalExchangeBindings,
      externalBroker: this.#externalExchangeBroker,
      bindings: this.#bindings.values(),
      getCredential: (request) => this.getCredential(request),
    });
  }

  async probeServiceCredentials(
    resolveRoute?: CredentialProbeRouteResolver,
  ): Promise<readonly DelegatedCredentialProbe[]> {
    return probeGoogleWorkloadIdentityCredentials({
      bindings: this.#googleWorkloadIdentityBindings,
      options: this.#options.googleWorkloadIdentity,
      getCredential: (request) => this.getCredential(request),
      ...(resolveRoute === undefined ? {} : { resolveRoute }),
    });
  }

  async #clientCredentialsToken(
    binding: SecretBinding,
    clientSecret: string,
    request: CredentialRequest,
  ): Promise<string> {
    const cacheKey = routeBoundCredentialKey(
      MapServiceBroker.key(binding.connectorId, binding.operation),
      request.route,
    );
    const cached = this.#oauthCache.get(cacheKey);
    const now = Date.now();
    if (cached !== undefined && cached.expiresAt > now) return cached.token;
    const cc = await this.#resolveClientCredentialsBinding(
      binding.clientCredentials as ClientCredentialsBinding,
    );
    const response =
      cc.profile === 'custom' && cc.custom !== undefined
        ? await fetchCustomClientCredentials(cc, cc.custom, clientSecret)
        : await fetchOAuth2ClientCredentials(cc, clientSecret);
    this.#oauthCache.set(cacheKey, response);
    return response.token;
  }

  async #delegatedBearerCredential(
    binding: SecretBinding,
    request: CredentialRequest,
  ): Promise<DownstreamCredential> {
    if (binding.delegated?.provider === 'microsoft') {
      return this.#delegatedMicrosoftBearerCredential(binding, request);
    }
    const provider = 'firebase';
    requireFirebaseProvider(binding.delegated?.provider);
    const caller = requireFirebaseCaller(request, provider);
    const cacheKey = routeBoundCredentialKey(
      [caller.audience, provider, caller.subject, request.connectorId, request.operation].join(
        '\u0000',
      ),
      request.route,
    );
    const now = this.#now();
    const cached = this.#delegatedCache.get(cacheKey);
    if (cached !== undefined && cached.expiresAt > now) {
      if (cached.kind === 'cookie') throw new Error('cached delegated credential type mismatch');
      return { token: cached.token };
    }
    const inflight = this.#delegatedInflight.get(cacheKey);
    if (inflight !== undefined) return inflight;
    const promise = this.#refreshFirebaseCredential(binding, request, caller.audience, provider)
      .then((result) => {
        const credential = {
          token: result.idToken,
          expiresAt: this.#now() + Math.max(1, result.expiresIn - 300) * 1000,
        };
        this.#delegatedCache.set(cacheKey, credential);
        return { token: credential.token };
      })
      .finally(() => this.#delegatedInflight.delete(cacheKey));
    this.#delegatedInflight.set(cacheKey, promise);
    return promise;
  }

  async #delegatedMicrosoftBearerCredential(
    binding: SecretBinding,
    request: CredentialRequest,
  ): Promise<DownstreamCredential> {
    const delegated = requireMicrosoftDelegatedBinding(binding);
    const caller = requireMicrosoftCaller(request);
    const resolvedDelegated = await this.#resolveMicrosoftDelegatedBinding(delegated);
    const cacheKey = routeBoundCredentialKey(
      [
        caller.audience,
        resolvedDelegated.provider,
        caller.subject,
        request.connectorId,
        request.operation,
        resolvedDelegated.tokenUrl,
        resolvedDelegated.clientId,
        ...(resolvedDelegated.scopes ?? []),
      ].join('\u0000'),
      request.route,
    );
    const now = this.#now();
    const cached = this.#delegatedCache.get(cacheKey);
    if (cached !== undefined && cached.expiresAt > now) {
      if (cached.kind === 'cookie') throw new Error('cached delegated credential type mismatch');
      return { token: cached.token };
    }
    const inflight = this.#delegatedInflight.get(cacheKey);
    if (inflight !== undefined) return inflight;
    const promise = this.#refreshMicrosoftCredential(binding, resolvedDelegated, caller)
      .then((result) => {
        const credential = {
          token: result.accessToken,
          expiresAt: this.#now() + Math.max(1, result.expiresIn - 300) * 1000,
        };
        this.#delegatedCache.set(cacheKey, credential);
        return { token: credential.token };
      })
      .finally(() => this.#delegatedInflight.delete(cacheKey));
    this.#delegatedInflight.set(cacheKey, promise);
    return promise;
  }

  async #delegatedSessionCookieCredential(
    binding: SecretBinding,
    request: CredentialRequest,
  ): Promise<DownstreamCredential> {
    requireFirebaseProvider(binding.delegated?.provider);
    const provider = 'firebase';
    const caller = requireFirebaseCaller(request, provider);
    const sessionUrl = binding.delegated?.sessionUrl;
    if (sessionUrl === undefined) throw new Error('delegated session URL is not configured');
    const tokenField = binding.delegated?.tokenField ?? 'idToken';
    const cacheKey = routeBoundCredentialKey(
      [
        caller.audience,
        provider,
        caller.subject,
        request.connectorId,
        request.operation,
        sessionUrl,
      ].join('\u0000'),
      request.route,
    );
    const now = this.#now();
    const cached = this.#delegatedCache.get(cacheKey);
    if (cached !== undefined && cached.expiresAt > now) return cached;
    const inflight = this.#delegatedInflight.get(cacheKey);
    if (inflight !== undefined) return inflight;
    const promise = this.#refreshFirebaseCredential(binding, request, caller.audience, provider)
      .then((result) =>
        exchangeFirebaseTokenForSessionCookie({
          sessionUrl,
          tokenField,
          idToken: result.idToken,
          fetchImpl: this.#options.fetchImpl ?? fetch,
          now: this.#now(),
        }),
      )
      .then((credential) => {
        if (credential.kind !== 'cookie') {
          throw new Error('delegated session exchange returned a non-cookie credential');
        }
        const expiresAt = credential.expiresAt ?? this.#now() + 300_000;
        this.#delegatedCache.set(cacheKey, { ...credential, expiresAt });
        return credential;
      })
      .finally(() => this.#delegatedInflight.delete(cacheKey));
    this.#delegatedInflight.set(cacheKey, promise);
    return promise;
  }

  async #refreshFirebaseCredential(
    _binding: SecretBinding,
    request: CredentialRequest,
    resource: string,
    provider: string,
  ): Promise<FirebaseRefreshResult> {
    const caller = request.caller;
    if (caller === undefined) throw new Error('delegated credential requires caller');
    const credentialStore = this.#options.delegatedCredentialStore;
    const open = this.#options.openCustomerCredential;
    const seal = this.#options.sealCustomerCredential;
    const auth = this.#options.serverAuth;
    if (
      credentialStore === undefined ||
      open === undefined ||
      auth === undefined ||
      auth.kind !== 'bridge' ||
      auth.provider !== 'firebase' ||
      auth.apiKey === undefined
    ) {
      throw new Error('delegated Firebase credentials are not configured');
    }
    const record = await credentialStore.getDelegatedCredential({
      resource,
      provider,
      subject: caller.subject,
    });
    if (record === undefined) throw new Error('delegated credential not found');
    const refreshToken = await open(record.credential);
    const variables = await this.#store.resolveConfigValues('variable', this.#scope);
    const apiKey = resolveManagedVariablesInString(auth.apiKey, variables);
    let result: FirebaseRefreshResult;
    try {
      result = await fetchFirebaseRefreshToken({
        apiKey,
        refreshToken,
        fetchImpl: this.#options.fetchImpl ?? fetch,
      });
    } catch {
      throw new CredentialUnavailableError('credential_exchange_failed', {
        fix: 'Verify the Firebase Web API key and stored customer credential.',
        next: ['noodle auth doctor --live'],
      });
    }
    if (result.refreshToken !== refreshToken && seal !== undefined) {
      await credentialStore.putDelegatedCredential({
        ...record,
        credential: await seal(result.refreshToken),
        updatedAt: new Date(this.#now()).toISOString(),
      });
    }
    return result;
  }

  async #refreshMicrosoftCredential(
    binding: SecretBinding,
    delegated: MicrosoftDelegatedBinding,
    caller: NonNullable<CredentialRequest['caller']> & { readonly audience: string },
  ): Promise<MicrosoftRefreshResult> {
    const credentialStore = this.#options.delegatedCredentialStore;
    const open = this.#options.openCustomerCredential;
    const seal = this.#options.sealCustomerCredential;
    if (credentialStore === undefined || open === undefined) {
      throw new Error('delegated Microsoft credentials are not configured');
    }
    if (binding.secretRef === undefined) {
      throw new Error('Microsoft delegated OAuth client secret is not configured');
    }
    const secrets = await this.#store.resolveConfigValues('secret', this.#scope);
    const clientSecret = secrets[binding.secretRef];
    if (clientSecret === undefined)
      throw new Error(`missing managed secret "${binding.secretRef}"`);

    const provider = 'microsoft';
    const record = await credentialStore.getDelegatedCredential({
      resource: caller.audience,
      provider,
      subject: caller.subject,
    });
    if (record === undefined) throw new Error('delegated credential not found');
    const refreshToken = await open(record.credential);
    const result = await fetchMicrosoftRefreshToken({
      tokenUrl: delegated.tokenUrl,
      clientId: delegated.clientId,
      clientSecret,
      refreshToken,
      scopes: delegated.scopes,
      authMethod: delegated.authMethod ?? 'client_secret_post',
      fetchImpl: this.#options.fetchImpl ?? fetch,
    });
    if (
      result.refreshToken !== undefined &&
      result.refreshToken !== refreshToken &&
      seal !== undefined
    ) {
      await credentialStore.putDelegatedCredential({
        ...record,
        credential: await seal(result.refreshToken),
        updatedAt: new Date(this.#now()).toISOString(),
      });
    }
    return result;
  }

  async #resolveClientCredentialsBinding(
    cc: ClientCredentialsBinding,
  ): Promise<ClientCredentialsBinding> {
    const variables = await this.#store.resolveConfigValues('variable', this.#scope);
    return {
      ...cc,
      tokenUrl: resolveManagedVariablesInString(cc.tokenUrl, variables),
      clientId: resolveManagedVariablesInString(cc.clientId, variables),
      ...(cc.audience !== undefined
        ? { audience: resolveManagedVariablesInString(cc.audience, variables) }
        : {}),
    };
  }

  async #resolveMicrosoftDelegatedBinding(
    delegated: MicrosoftDelegatedBinding,
  ): Promise<MicrosoftDelegatedBinding> {
    const variables = await this.#store.resolveConfigValues('variable', this.#scope);
    return {
      ...delegated,
      tokenUrl: resolveManagedVariablesInString(delegated.tokenUrl, variables),
      clientId: resolveManagedVariablesInString(delegated.clientId, variables),
    };
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }
}
