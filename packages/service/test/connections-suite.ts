import { describe, expect, it } from 'vitest';
import { PortableConnections } from '../src/connections/service.js';
import type { ConnectionStore } from '../src/connections/types.js';
import { oauthFixture } from './connection-oauth-fixture.js';

const key = {
  org: 'one',
  app: 'workflow',
  env: 'prod',
  installationId: 'installation-one',
  connectionId: 'records_account',
};
const target = {
  key,
  label: 'Records account',
  connectionConfigRevision: 'compiled-revision',
  requiredScopes: ['records.read', 'records.write'],
};
const binding = 's'.repeat(43);
const returnUrl = 'https://portal.example.test/o/one/workflow/integrations';
async function fixture(stores: { store: ConnectionStore; otherStore: ConnectionStore }) {
  const provider = await oauthFixture();
  const { store, otherStore } = stores;
  let now = Date.now();
  let allowed = true;
  const options = {
    store,
    credentialEpoch: 'fixture-epoch-0001',
    resolveTarget: async (key: typeof target.key) => ({ ...target, key }),
    providers: async () => provider.provider,
    portalOrigins: ['https://portal.example.test'],
    authorize: async () => allowed,
    guardedFetch: provider.fetch,
    now: () => now,
  };
  const service = new PortableConnections(options);
  return {
    provider,
    service,
    store,
    otherStore,
    options,
    advance: () => {
      now += 65_000;
    },
    deny: () => {
      allowed = false;
    },
  };
}
async function connect(f: Awaited<ReturnType<typeof fixture>>, subject?: string) {
  const before = await f.service.inspect(target);
  const started = await f.service.connect(
    target,
    { expectedRevision: before.revision, returnUrl, sessionBinding: binding },
    'operator',
  );
  const callback = f.provider.authorize(started.authorizationUrl, subject);
  await f.service.callback({ ...callback, sessionBinding: binding }, 'operator');
  return f.service.inspect(target);
}

export function describePortableConnections(
  makeStores: () => Promise<{ store: ConnectionStore; otherStore: ConnectionStore }>,
) {
  describe('portable connection lifecycle', () => {
    it('binds browser consent once and serves an isolated account through the selected connection', async () => {
      const f = await fixture(await makeStores());
      const connected = await connect(f);
      expect(connected.state).toBe('ready');
      const generation = await f.service.readGeneration(target);
      expect(
        await f.service.acquire(target, ['records.read'], generation.generation),
      ).toMatchObject({
        access_token: 'fixture-access-token',
      });
      await expect(
        f.service.acquire({ ...target, key: { ...key, org: 'other' } }, ['records.read']),
      ).rejects.toThrow('connection_unavailable');
      await expect(f.service.acquire(target, ['admin'])).rejects.toThrow('connection_denied');
      expect(f.provider.metrics().tokenCalls).toBe(1);
    });
    it('rejects wrong browser/actor and replay, then consumes denied consent', async () => {
      const f = await fixture(await makeStores());
      const started = await f.service.connect(
        target,
        { expectedRevision: 0, returnUrl, sessionBinding: binding },
        'operator',
      );
      const callback = f.provider.authorize(started.authorizationUrl);
      await expect(
        f.service.callback({ ...callback, sessionBinding: 'x'.repeat(43) }, 'operator'),
      ).rejects.toThrow('connection_denied');
      await expect(
        f.service.callback({ ...callback, sessionBinding: binding }, 'other'),
      ).rejects.toThrow('connection_denied');
      await f.service.callback({ ...callback, sessionBinding: binding }, 'operator');
      await expect(
        f.service.callback({ ...callback, sessionBinding: binding }, 'operator'),
      ).rejects.toThrow();
      const state = await f.service.inspect(target);
      const second = await f.service.connect(
        target,
        { expectedRevision: state.revision, returnUrl, sessionBinding: binding },
        'operator',
      );
      const denied = {
        state: new URL(second.authorizationUrl).searchParams.get('state') ?? '',
        error: 'access_denied',
        sessionBinding: binding,
      };
      await f.service.callback(denied, 'operator');
      await expect(f.service.callback(denied, 'operator')).rejects.toThrow();
      expect(f.provider.metrics().tokenCalls).toBe(1);
    });
    it('serializes refresh across two instances and refuses stale generations after disconnect', async () => {
      const f = await fixture(await makeStores());
      const connected = await connect(f);
      const generation = await f.service.readGeneration(target);
      f.advance();
      const other = new PortableConnections({ ...f.options, store: f.otherStore });
      await Promise.all([
        f.service.acquire(target, ['records.read']),
        other.acquire(target, ['records.read']),
      ]);
      expect(f.provider.metrics().refreshCalls).toBe(1);
      await f.service.disconnect(target, connected.revision, 'operator');
      await expect(
        other.acquire(target, ['records.read'], generation.generation),
      ).rejects.toThrow();
      expect((await other.inspect(target)).state).toBe('revoked');
    });
    it('fails closed after unknown refresh and rejects account replacement without disconnect', async () => {
      const f = await fixture(await makeStores());
      await connect(f);
      await expect(connect(f, 'another-account')).rejects.toThrow('connection_conflict');
      f.advance();
      f.provider.failRefresh();
      await expect(f.service.acquire(target, ['records.read'])).rejects.toThrow(
        'connection_unavailable',
      );
      await expect(f.service.acquire(target, ['records.read'])).rejects.toThrow(
        'connection_unavailable',
      );
      expect(f.provider.metrics().refreshCalls).toBe(1);
      expect((await f.service.inspect(target)).state).toBe('reauth_required');
    });
    it('refuses untrusted redirects and revoked administrator access before provider exchange', async () => {
      const f = await fixture(await makeStores());
      await expect(
        f.service.connect(
          target,
          { expectedRevision: 0, returnUrl: 'https://evil.example/o/one', sessionBinding: binding },
          'operator',
        ),
      ).rejects.toThrow('connection_invalid');
      const started = await f.service.connect(
        target,
        { expectedRevision: 0, returnUrl, sessionBinding: binding },
        'operator',
      );
      f.deny();
      await expect(
        f.service.callback(
          { ...f.provider.authorize(started.authorizationUrl), sessionBinding: binding },
          'operator',
        ),
      ).rejects.toThrow('connection_denied');
      expect(f.provider.metrics().tokenCalls).toBe(0);
    });
    it('invalidates restored credentials and pending consent under a changed deployment epoch', async () => {
      const f = await fixture(await makeStores());
      await connect(f);
      const before = await f.service.inspect(target);
      const pending = await f.service.connect(
        target,
        { expectedRevision: before.revision, returnUrl, sessionBinding: binding },
        'operator',
      );
      const restored = new PortableConnections({
        ...f.options,
        credentialEpoch: 'restored-epoch-002',
      });
      expect((await restored.inspect(target)).state).toBe('reauth_required');
      await expect(restored.acquire(target, ['records.read'])).rejects.toThrow();
      await expect(
        restored.callback(
          { ...f.provider.authorize(pending.authorizationUrl), sessionBinding: binding },
          'operator',
        ),
      ).rejects.toThrow('connection_invalid');
      expect(f.provider.metrics().tokenCalls).toBe(1);
    });
    it('rejects stale application revisions and tampered nonce or expanded scopes', async () => {
      for (const failure of ['revision', 'nonce', 'scope']) {
        const f = await fixture(await makeStores());
        const started = await f.service.connect(
          target,
          { expectedRevision: 0, returnUrl, sessionBinding: binding },
          'operator',
        );
        const url = new URL(started.authorizationUrl);
        if (failure === 'nonce') url.searchParams.set('nonce', 'attacker-value');
        const callback = f.provider.authorize(
          url.href,
          undefined,
          failure === 'scope' ? 'openid records.read records.write admin' : undefined,
        );
        const service =
          failure === 'revision'
            ? new PortableConnections({
                ...f.options,
                resolveTarget: async () => ({ ...target, connectionConfigRevision: 'changed' }),
              })
            : f.service;
        await expect(
          service.callback({ ...callback, sessionBinding: binding }, 'operator'),
        ).rejects.toThrow();
        await expect(f.service.acquire(target, ['records.read'])).rejects.toThrow();
        expect(f.provider.metrics().tokenCalls).toBe(failure === 'revision' ? 0 : 1);
      }
    });
    it('preserves a same-account generation across reauthorization and rolls back failed transactions', async () => {
      const f = await fixture(await makeStores());
      await connect(f);
      const original = await f.service.readGeneration(target);
      await connect(f);
      expect((await f.service.readGeneration(target)).generation).toBe(original.generation);
      await expect(
        f.store.transact(key, async (tx) => {
          const record = await tx.read();
          if (!record) throw new Error();
          await tx.write({ ...record, state: 'revoked' });
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect(
        (await new PortableConnections({ ...f.options, store: f.otherStore }).inspect(target))
          .state,
      ).toBe('ready');
    });
    it('refuses expired consent and unavailable provider registration without exchanging tokens', async () => {
      const f = await fixture(await makeStores());
      const started = await f.service.connect(
        target,
        { expectedRevision: 0, returnUrl, sessionBinding: binding },
        'operator',
      );
      for (let i = 0; i < 10; i++) f.advance();
      await expect(
        f.service.callback(
          { ...f.provider.authorize(started.authorizationUrl), sessionBinding: binding },
          'operator',
        ),
      ).rejects.toThrow('connection_invalid');
      const missing = new PortableConnections({ ...f.options, providers: async () => undefined });
      expect((await missing.inspect(target)).connectable).toBe(false);
      await expect(
        missing.connect(
          target,
          { expectedRevision: 1, returnUrl, sessionBinding: binding },
          'operator',
        ),
      ).rejects.toThrow('connection_unavailable');
      expect(f.provider.metrics().tokenCalls).toBe(0);
    });
  });
}
