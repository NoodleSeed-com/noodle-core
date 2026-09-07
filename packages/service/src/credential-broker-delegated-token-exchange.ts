import type { SecretBinding } from '@noodle-borg/connector-defs';
import {
  type CredentialRequest,
  CredentialUnavailableError,
  type DownstreamCredential,
} from '@noodle-borg/runtime';
import { copyCustomerRouteBinding, routeBoundCredentialKey } from './credential-route-key.js';
import {
  type DelegatedExchangeOptions,
  DelegatedTokenExchangeError,
  fetchDelegatedTokenExchange,
  requireExchangeCaller,
  signExchangeAssertion,
} from './delegated-token-exchange.js';
import { localDevtoolsDelegatedExchangeBindingKey } from './local-devtools-delegated-exchange.js';
import { resolveManagedVariablesInString } from './managed-config-expressions.js';
import type { ConfigScope, ConfigStore } from './store.js';

export interface DelegatedTokenExchangeBrokerOptions {
  /** Platform signer/issuer + deployment identity for `delegatedTokenExchange` (ADR 0152). */
  readonly delegatedExchange?: DelegatedExchangeOptions;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

export class DelegatedTokenExchangeBroker {
  readonly #delegatedCache: Map<string, DownstreamCredential & { expiresAt: number }>;
  readonly #delegatedInflight: Map<string, Promise<DownstreamCredential>>;
  readonly #store: ConfigStore;
  readonly #scope: ConfigScope;
  readonly #options: DelegatedTokenExchangeBrokerOptions;

  constructor(
    store: ConfigStore,
    scope: ConfigScope,
    options: DelegatedTokenExchangeBrokerOptions,
    delegatedCache: Map<string, DownstreamCredential & { expiresAt: number }>,
    delegatedInflight: Map<string, Promise<DownstreamCredential>>,
  ) {
    this.#store = store;
    this.#scope = scope;
    this.#options = options;
    this.#delegatedCache = delegatedCache;
    this.#delegatedInflight = delegatedInflight;
  }

  async getCredential(
    binding: SecretBinding,
    request: CredentialRequest,
  ): Promise<DownstreamCredential> {
    const options = this.#options.delegatedExchange;
    const declared = binding.tokenExchange;
    if (options === undefined || declared === undefined) {
      throw new CredentialUnavailableError('credential_not_configured', {
        fix: 'Configure delegatedTokenExchange for this connector and deployment.',
        next: ['noodle auth doctor'],
      });
    }
    const caller = requireExchangeCaller(request);
    const cacheKey = routeBoundCredentialKey(
      [
        'tokenExchange',
        caller.audience,
        caller.customerIssuer,
        caller.subject,
        request.connectorId,
        request.operation,
        declared.scopes?.join(' ') ?? '',
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
    const promise = (async (): Promise<DownstreamCredential> => {
      if (binding.secretRef === undefined) {
        throw new CredentialUnavailableError('credential_not_configured', {
          fix: 'Configure the delegated token exchange client secret reference (`secretRef`).',
          next: ['noodle auth doctor'],
        });
      }
      const secrets = await this.#store.resolveConfigValues('secret', this.#scope);
      const clientSecret = secrets[binding.secretRef];
      if (clientSecret === undefined) {
        if (options.localDevtools === true) {
          throw localSecretUnavailable(binding.secretRef, this.#scope);
        }
        throw new CredentialUnavailableError('credential_not_configured', {
          fix: 'Set the managed secret required by delegated token exchange.',
          next: ['noodle auth doctor'],
        });
      }
      const resolved = await this.#resolveTokenExchangeBinding(declared);
      const audience = resolved.audience ?? resolved.tokenUrl;
      options.onAttempt?.({
        bindingKey: localDevtoolsDelegatedExchangeBindingKey(binding, resolved),
        connectorId: binding.connectorId,
        ...(binding.operation === undefined ? {} : { operation: binding.operation }),
        audience,
      });
      const assertion = await signExchangeAssertion({
        options,
        caller,
        audience,
        nowMs: this.#now(),
        ...(request.route === undefined ? {} : { route: copyCustomerRouteBinding(request.route) }),
      });
      let result: Awaited<ReturnType<typeof fetchDelegatedTokenExchange>>;
      try {
        result = await fetchDelegatedTokenExchange({
          binding: resolved,
          clientSecret,
          assertion,
          fetchImpl: this.#options.fetchImpl ?? fetch,
        });
      } catch (error) {
        throw delegatedExchangeUnavailable(
          error,
          resolved.tokenUrl,
          options.localDevtools === true,
        );
      }
      try {
        options.onSuccess?.({
          bindingKey: localDevtoolsDelegatedExchangeBindingKey(binding, resolved),
        });
      } catch {
        // Local observation is advisory and cannot alter a valid downstream credential.
      }
      if (result.expiresIn !== undefined) {
        this.#delegatedCache.set(cacheKey, {
          token: result.token,
          expiresAt: this.#now() + Math.max(1, result.expiresIn - 300) * 1000,
        });
      }
      return { token: result.token };
    })().finally(() => this.#delegatedInflight.delete(cacheKey));
    this.#delegatedInflight.set(cacheKey, promise);
    return promise;
  }

  async #resolveTokenExchangeBinding(
    declared: NonNullable<SecretBinding['tokenExchange']>,
  ): Promise<NonNullable<SecretBinding['tokenExchange']>> {
    const variables = await this.#store.resolveConfigValues('variable', this.#scope);
    return {
      ...declared,
      tokenUrl: resolveManagedVariablesInString(declared.tokenUrl, variables),
      clientId: resolveManagedVariablesInString(declared.clientId, variables),
      ...(declared.audience !== undefined
        ? { audience: resolveManagedVariablesInString(declared.audience, variables) }
        : {}),
    };
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }
}

function localSecretUnavailable(name: string, scope: ConfigScope): CredentialUnavailableError {
  return new CredentialUnavailableError('credential_not_configured', {
    fix: `Secret reference "${name}" is unresolved for local scope ${configScopeLabel(scope)}.`,
    next: [localSecretRecoveryCommand(name, scope)],
  });
}

function configScopeLabel(scope: ConfigScope): string {
  if (scope.level === 'org') return `org/${scope.org}`;
  if (scope.level === 'app') return `org/${scope.org}/app/${scope.app}`;
  return `org/${scope.org}/app/${scope.app}/env/${scope.env}`;
}

function localSecretRecoveryCommand(name: string, scope: ConfigScope): string {
  const command = [
    'noodle secrets set',
    name,
    '--runtime local',
    `--scope ${scope.level}`,
    `--org ${scope.org}`,
  ];
  if (scope.level !== 'org') command.push(`--app ${scope.app}`);
  if (scope.level === 'env') command.push(`--env ${scope.env}`);
  command.push(`--from-env ${name}`);
  return command.join(' ');
}

function delegatedExchangeUnavailable(
  error: unknown,
  tokenUrl: string,
  localDevtools: boolean,
): CredentialUnavailableError {
  if (!(error instanceof DelegatedTokenExchangeError)) {
    return new CredentialUnavailableError('credential_exchange_failed', {
      fix: 'Verify the customer token endpoint, client credentials, audience, and scopes.',
      next: ['noodle auth doctor --live'],
    });
  }

  let fix: string;
  if (error.kind === 'network') {
    fix = networkRemediation(tokenUrl);
  } else if (error.kind === 'redirect') {
    fix = 'Configure a direct delegated token endpoint that does not redirect.';
  } else if (error.status === 401 || error.status === 403 || error.oauthCode === 'invalid_client') {
    const source =
      error.oauthCode === 'invalid_client'
        ? 'Token endpoint returned OAuth error invalid_client.'
        : `Token endpoint rejected client authentication with HTTP ${error.status}.`;
    fix = `${source} Check the delegated exchange ${localDevtools ? 'development ' : ''}client ID and client secret.`;
  } else if (error.oauthCode === 'invalid_target') {
    fix = `Token endpoint returned OAuth error invalid_target. Check the connector audience and ${localDevtools ? 'development ' : ''}token endpoint policy.`;
  } else if (error.kind === 'oauth' && error.oauthCode !== undefined) {
    const remediation = localDevtools
      ? 'Check the displayed local issuer, JWKS, audience, tenant, deployment, and clock synchronization.'
      : 'Check the configured platform issuer and JWKS, connector audience, and clock synchronization.';
    fix = `Token endpoint returned OAuth error ${error.oauthCode}. ${remediation}`;
  } else if (error.kind === 'response_too_large') {
    fix =
      'Token endpoint response exceeded the 32 KiB limit. Return a documented JSON token response no larger than 32 KiB.';
  } else if (error.kind === 'malformed_response') {
    fix = 'Configure the token endpoint to return the documented JSON token response.';
  } else {
    fix = `Delegated token endpoint returned HTTP ${error.status ?? 'unknown'}. Check the endpoint configuration and documented token response.`;
  }
  return new CredentialUnavailableError('credential_exchange_failed', {
    fix,
    next: ['noodle auth doctor --live'],
  });
}

function networkRemediation(tokenUrl: string): string {
  let origin: string | undefined;
  try {
    origin = new URL(tokenUrl).origin;
  } catch {
    // Invalid resolved URLs remain provider-neutral and never enter diagnostics.
  }
  return origin === undefined
    ? 'Cannot reach the configured delegated token endpoint. Check network reachability, TLS, and DNS.'
    : `Cannot reach delegated token endpoint origin ${origin}. Check network reachability, TLS, and DNS.`;
}
