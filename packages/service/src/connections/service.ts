import { createHash, randomUUID } from 'node:crypto';
import type { ExternalCredentialExchangeResponse } from '@noodle-borg/external-credential-provider';
import * as oauth from 'oauth4webapi';
import type { AuditSink } from '../store/audit.js';
import {
  authorizationUrl,
  type ConnectionFetch,
  type ConnectionProvider,
  exchangeCode,
  providerDigest,
  refreshTokens,
  revokeToken,
} from './oauth.js';
import {
  type ConnectionCallback,
  ConnectionError,
  type ConnectionKey,
  type ConnectionStore,
  type ConnectionTarget,
  type ConnectionView,
  type StoredConnection,
} from './types.js';

export interface PortableConnectionsOptions {
  readonly store: ConnectionStore;
  readonly audit?: AuditSink;
  readonly providers: (key: ConnectionKey) => Promise<ConnectionProvider | undefined>;
  readonly resolveTarget: (key: ConnectionKey) => Promise<ConnectionTarget | undefined>;
  readonly authorize: (key: ConnectionKey, actor: string) => Promise<boolean>;
  readonly portalOrigins: readonly string[];
  /** Stable across normal restart; rotate during restore before enabling traffic. Not a tenant setting. */
  readonly credentialEpoch: string;
  readonly now?: () => number;
  readonly guardedFetch?: ConnectionFetch;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const bindingPattern = /^[A-Za-z0-9_-]{32,128}$/;

/** Portable account authority; no business entities, provider names or execution proxy live here. */
export class PortableConnections {
  constructor(readonly options: PortableConnectionsOptions) {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(options.credentialEpoch))
      throw new ConnectionError('connection_invalid');
    for (const origin of options.portalOrigins) {
      const url = new URL(origin);
      if (
        url.origin !== origin ||
        (url.protocol !== 'https:' &&
          !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
      )
        throw new ConnectionError('connection_invalid');
    }
  }
  #now() {
    return this.options.now?.() ?? Date.now();
  }
  async #provider(target: ConnectionTarget): Promise<ConnectionProvider> {
    const provider = await this.options.providers(target.key);
    if (!provider || !target.requiredScopes.every((scope) => provider.scopes.includes(scope)))
      throw new ConnectionError('connection_unavailable');
    providerDigest(provider);
    return provider;
  }
  async #authorize(key: ConnectionKey, actor: string): Promise<void> {
    if (!(await this.options.authorize(key, actor))) throw new ConnectionError('connection_denied');
  }
  #matches(
    record: StoredConnection,
    target: ConnectionTarget,
    provider: ConnectionProvider,
  ): boolean {
    return (
      record.credentialEpoch === this.options.credentialEpoch &&
      record.connectionConfigRevision === target.connectionConfigRevision &&
      record.providerId === provider.id &&
      record.providerDigest === providerDigest(provider)
    );
  }
  async inspect(target: ConnectionTarget): Promise<ConnectionView> {
    const provider = await this.options.providers(target.key);
    const stored = await this.options.store.transact(target.key, (transaction) =>
      transaction.read(),
    );
    const usable =
      provider !== undefined &&
      target.requiredScopes.every((scope) => provider.scopes.includes(scope));
    return {
      id: target.key.connectionId,
      label: target.label,
      revision: stored?.revision ?? 0,
      state:
        stored === undefined
          ? 'unconfigured'
          : usable && this.#matches(stored, target, provider)
            ? stored.state
            : 'reauth_required',
      connectable: usable,
    };
  }
  async readGeneration(target: ConnectionTarget): Promise<{
    generation: string;
    revision: number;
    state: StoredConnection['state'];
    credentialEpoch: string;
  }> {
    const provider = await this.#provider(target);
    const value = await this.options.store.transact(target.key, (transaction) =>
      transaction.read(),
    );
    if (!value || !this.#matches(value, target, provider))
      throw new ConnectionError('connection_unavailable');
    return {
      generation: value.generation,
      revision: value.revision,
      state: value.state,
      credentialEpoch: value.credentialEpoch,
    };
  }
  /** Serializes a dependent read/commit with revocation; callback receives no account identifiers or tokens. */
  async withAccountIdentity<T>(
    target: ConnectionTarget,
    work: (identity: { generation: string; account: string }) => Promise<T>,
  ): Promise<T> {
    const provider = await this.#provider(target);
    return this.options.store.transact(target.key, async (transaction) => {
      const value = await transaction.read();
      if (value?.state !== 'ready' || !value.subject || !this.#matches(value, target, provider))
        throw new ConnectionError('connection_unavailable');
      return work({
        generation: value.generation,
        account: hash(
          JSON.stringify([
            target.key.org,
            target.key.app,
            target.key.env,
            target.key.installationId,
            target.key.connectionId,
            value.providerId,
            provider.server.issuer,
            provider.clientId,
            value.subject,
          ]),
        ),
      });
    });
  }
  async connect(
    target: ConnectionTarget,
    input: { expectedRevision: number; returnUrl: string; sessionBinding: string },
    actor: string,
  ): Promise<{ authorizationUrl: string }> {
    await this.#authorize(target.key, actor);
    const destination = new URL(input.returnUrl);
    if (
      !bindingPattern.test(input.sessionBinding) ||
      !this.options.portalOrigins.includes(destination.origin) ||
      !destination.pathname.startsWith(`/o/${encodeURIComponent(target.key.org)}/`) ||
      destination.username ||
      destination.password ||
      destination.hash ||
      destination.search
    )
      throw new ConnectionError('connection_invalid');
    const provider = await this.#provider(target);
    const state = oauth.generateRandomState();
    const verifier = oauth.generateRandomCodeVerifier();
    const nonce = oauth.generateRandomNonce();
    const expiresAt = this.#now() + 10 * 60 * 1000;
    const url = await authorizationUrl(provider, state, verifier, nonce);
    await this.options.store.transact(target.key, async (transaction) => {
      const current = await transaction.read();
      if ((current?.revision ?? 0) !== input.expectedRevision)
        throw new ConnectionError('connection_conflict');
      if (
        current?.subject !== undefined &&
        current.credentialEpoch === this.options.credentialEpoch &&
        current.providerDigest !== providerDigest(provider)
      )
        throw new ConnectionError('connection_conflict');
      const base: StoredConnection =
        current && this.#matches(current, target, provider)
          ? current
          : {
              revision: current?.revision ?? 0,
              generation: randomUUID(),
              credentialEpoch: this.options.credentialEpoch,
              providerId: provider.id,
              providerDigest: providerDigest(provider),
              connectionConfigRevision: target.connectionConfigRevision,
              state: 'unconfigured',
              ...(current?.subject !== undefined &&
              current.credentialEpoch === this.options.credentialEpoch
                ? { subject: current.subject }
                : {}),
              pending: [],
            };
      const live = base.pending.filter((pending) => pending.expiresAt > this.#now());
      if (live.length >= 4) throw new ConnectionError('connection_conflict');
      const pending = {
        target,
        stateHash: hash(state),
        sessionHash: hash(input.sessionBinding),
        subject: actor,
        providerId: provider.id,
        providerDigest: providerDigest(provider),
        credentialEpoch: this.options.credentialEpoch,
        generation: base.generation,
        verifier,
        nonce,
        returnUrl: destination.href,
        expiresAt,
        revision: base.revision + 1,
      };
      await transaction.write({
        ...base,
        revision: base.revision + 1,
        pending: [...live, pending],
      });
    });
    await this.options.store.putState(hash(state), target.key, expiresAt);
    return { authorizationUrl: url };
  }
  async callback(input: ConnectionCallback, actor: string): Promise<{ returnUrl: string }> {
    if (
      !bindingPattern.test(input.state) ||
      !bindingPattern.test(input.sessionBinding) ||
      (input.code === undefined) === (input.error === undefined)
    )
      throw new ConnectionError('connection_invalid');
    const stateHash = hash(input.state);
    const key = await this.options.store.getState(stateHash, this.#now());
    if (!key) throw new ConnectionError('connection_invalid');
    await this.#authorize(key, actor);
    const consumed = await this.options.store.transact(key, async (transaction) => {
      const current = await transaction.read();
      const pending = current?.pending.find((entry) => entry.stateHash === stateHash);
      if (
        !current ||
        !pending ||
        pending.expiresAt <= this.#now() ||
        pending.credentialEpoch !== this.options.credentialEpoch
      )
        throw new ConnectionError('connection_invalid');
      if (pending.subject !== actor || pending.sessionHash !== hash(input.sessionBinding))
        throw new ConnectionError('connection_denied');
      await transaction.write({
        ...current,
        revision: current.revision + 1,
        pending: current.pending.filter((entry) => entry.stateHash !== stateHash),
      });
      return { current, pending };
    });
    await this.options.store.deleteState(stateHash);
    if (input.error !== undefined) return { returnUrl: consumed.pending.returnUrl };
    const target = await this.options.resolveTarget(key);
    if (
      !target ||
      target.connectionConfigRevision !== consumed.pending.target.connectionConfigRevision
    )
      throw new ConnectionError('connection_conflict');
    const provider = await this.#provider(target);
    if (providerDigest(provider) !== consumed.pending.providerDigest)
      throw new ConnectionError('connection_conflict');
    let tokens: Awaited<ReturnType<typeof exchangeCode>>;
    try {
      tokens = await exchangeCode(
        provider,
        consumed.pending,
        input.code ?? '',
        input.state,
        this.#now(),
        this.options.guardedFetch,
        consumed.current.tokens,
        input.iss,
      );
    } catch {
      throw new ConnectionError('connection_unavailable');
    }
    await this.#authorize(key, actor);
    const latestTarget = await this.options.resolveTarget(key);
    if (
      latestTarget?.connectionConfigRevision !== target.connectionConfigRevision ||
      providerDigest(await this.#provider(latestTarget)) !== providerDigest(provider)
    )
      throw new ConnectionError('connection_conflict');
    await this.options.store.transact(key, async (transaction) => {
      const current = await transaction.read();
      if (
        !current ||
        current.generation !== consumed.pending.generation ||
        !this.#matches(current, target, provider) ||
        (current.subject !== undefined && current.subject !== tokens.subject)
      )
        throw new ConnectionError('connection_conflict');
      await transaction.write({
        ...current,
        revision: current.revision + 1,
        state: 'ready',
        subject: tokens.subject,
        tokens,
      });
    });
    await this.options.audit?.emit({
      eventType: 'config.connection.connected',
      org: key.org,
      app: key.app,
      env: key.env,
      actorSubject: actor,
      details: { connectionId: key.connectionId },
    });
    return { returnUrl: consumed.pending.returnUrl };
  }
  async disconnect(
    target: ConnectionTarget,
    expectedRevision: number,
    actor: string,
  ): Promise<ConnectionView> {
    await this.#authorize(target.key, actor);
    const provider = await this.options.providers(target.key);
    const refresh = await this.options.store.transact(target.key, async (transaction) => {
      const current = await transaction.read();
      if (!current || current.revision !== expectedRevision)
        throw new ConnectionError('connection_conflict');
      const { tokens, subject: _subject, ...rest } = current;
      await transaction.write({
        ...rest,
        revision: current.revision + 1,
        generation: randomUUID(),
        state: 'revoked',
        pending: [],
      });
      return tokens?.refreshToken;
    });
    if (provider && refresh)
      try {
        await revokeToken(provider, refresh, this.options.guardedFetch);
      } catch {
        /* Local revocation is authoritative even when provider grant revocation is unavailable. */
      }
    return this.inspect(target);
  }
  async acquire(
    target: ConnectionTarget,
    scopes: readonly string[],
    expectedGeneration?: string,
  ): Promise<ExternalCredentialExchangeResponse> {
    const provider = await this.#provider(target);
    if (!scopes.every((scope) => target.requiredScopes.includes(scope)))
      throw new ConnectionError('connection_denied');
    const result = await this.options.store.transact(target.key, async (transaction) => {
      const current = await transaction.read();
      if (
        !current ||
        !this.#matches(current, target, provider) ||
        current.state !== 'ready' ||
        !current.tokens ||
        (expectedGeneration !== undefined && current.generation !== expectedGeneration)
      )
        throw new ConnectionError('connection_unavailable');
      let tokens = current.tokens;
      if (tokens.expiresAt <= this.#now() + 5_000) {
        try {
          tokens = await refreshTokens(provider, tokens, this.#now(), this.options.guardedFetch);
        } catch {
          const { tokens: _tokens, ...rest } = current;
          await transaction.write({ ...rest, state: 'reauth_required' });
          return undefined;
        }
        await transaction.write({ ...current, tokens });
      }
      if (!scopes.every((scope) => tokens.scopes.includes(scope)))
        throw new ConnectionError('connection_denied');
      return {
        access_token: tokens.accessToken,
        token_type: 'Bearer' as const,
        expires_in: Math.min(3600, Math.floor((tokens.expiresAt - this.#now()) / 1000)),
        connection_subject: hash(tokens.subject),
        connection_revision: current.generation,
      };
    });
    if (!result) {
      await this.options.audit?.emit({
        eventType: 'config.connection.reauth_required',
        org: target.key.org,
        app: target.key.app,
        env: target.key.env,
        details: { connectionId: target.key.connectionId },
      });
      throw new ConnectionError('connection_unavailable');
    }
    return result;
  }
}
