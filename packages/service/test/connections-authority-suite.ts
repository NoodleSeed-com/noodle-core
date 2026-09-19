import { describe, expect, it, vi } from 'vitest';
import { PortableConnections } from '../src/connections/service.js';
import { ConnectionError, type ConnectionStore } from '../src/connections/types.js';
import { oauthFixture } from './connection-oauth-fixture.js';

export function describeConnectionAuthority(makeStore: () => Promise<ConnectionStore>) {
  const key = {
    org: 'authority',
    app: 'site',
    env: 'prod',
    installationId: 'site',
    connectionId: 'account',
  };
  const target = {
    key,
    label: 'Account',
    connectionConfigRevision: 'revision',
    requiredScopes: ['records.read'],
  };
  const input = {
    expectedRevision: 0,
    returnUrl: 'https://portal.example.test/o/authority/site/integrations',
    sessionBinding: 'b'.repeat(43),
  };
  async function fixture() {
    const store = await makeStore();
    const provider = await oauthFixture();
    let inside = false;
    let allowed = true;
    let denyAfterExchange = false;
    let fences = 0;
    const service = new PortableConnections({
      store,
      credentialEpoch: 'authority-epoch-0001',
      portalOrigins: ['https://portal.example.test'],
      providers: async () => {
        expect(inside).toBe(false);
        return provider.provider;
      },
      resolveTarget: async () => {
        expect(inside).toBe(false);
        return target;
      },
      // Deliberately stale outer admission: the local effect fence must decide authority again.
      authorize: async () => true,
      authorizeLocal: async <T>(
        actualKey: typeof key,
        actor: string,
        operation: () => Promise<T>,
      ) => {
        expect(actualKey).toEqual(key);
        expect(actor).toBe('administrator');
        if (!allowed || (denyAfterExchange && provider.metrics().tokenCalls > 0))
          throw new ConnectionError('connection_denied');
        expect(inside).toBe(false);
        inside = true;
        fences++;
        try {
          return await operation();
        } finally {
          inside = false;
        }
      },
      guardedFetch: async (url, init) => {
        expect(inside).toBe(false);
        return provider.fetch(url, init);
      },
      audit: {
        emit: async () => {
          expect(inside).toBe(false);
        },
      },
    });
    const start = () => service.connect(target, input, 'administrator');
    const finish = async (authorizationUrl: string) =>
      service.callback(
        {
          ...provider.authorize(authorizationUrl),
          sessionBinding: input.sessionBinding,
        },
        'administrator',
      );
    return {
      store,
      provider,
      service,
      start,
      finish,
      deny: () => {
        allowed = false;
      },
      denyAfterExchange: () => {
        denyAfterExchange = true;
      },
      inside: () => inside,
      fences: () => fences,
    };
  }
  describe('connection local-effect authority', () => {
    it('refuses consent creation after permission is withdrawn without storing pending state', async () => {
      const f = await fixture();
      f.deny();
      await expect(f.start()).rejects.toThrow('connection_denied');
      expect(await f.store.transact(key, (tx) => tx.read())).toBeUndefined();
      expect(f.provider.metrics().tokenCalls).toBe(0);
    });
    it('refuses a late callback before consuming consent or contacting the provider', async () => {
      const f = await fixture();
      const started = await f.start();
      f.deny();
      await expect(f.finish(started.authorizationUrl)).rejects.toThrow('connection_denied');
      expect((await f.store.transact(key, (tx) => tx.read()))?.pending).toHaveLength(1);
      expect(f.provider.metrics().tokenCalls).toBe(0);
    });
    it('refuses credential installation when revocation wins after the token exchange', async () => {
      const f = await fixture();
      const started = await f.start();
      f.denyAfterExchange();
      await expect(f.finish(started.authorizationUrl)).rejects.toThrow('connection_denied');
      const stored = await f.store.transact(key, (tx) => tx.read());
      expect(stored?.state).toBe('unconfigured');
      expect(stored?.tokens).toBeUndefined();
      expect(stored?.pending).toEqual([]);
      expect(f.provider.metrics().tokenCalls).toBe(1);
    });
    it('does not disconnect or revoke the provider after the local authority is withdrawn', async () => {
      const f = await fixture();
      await f.finish((await f.start()).authorizationUrl);
      const before = await f.service.inspect(target);
      f.deny();
      await expect(f.service.disconnect(target, before.revision, 'administrator')).rejects.toThrow(
        'connection_denied',
      );
      expect((await f.service.inspect(target)).state).toBe('ready');
      expect(f.provider.metrics().revoked).toBe(0);
    });
    it('fences pending state, consumption, credentials and disconnect while leaving provider I/O outside', async () => {
      const f = await fixture();
      const put = f.store.putState.bind(f.store);
      const remove = f.store.deleteState.bind(f.store);
      const putSpy = vi.spyOn(f.store, 'putState').mockImplementation(async (...args) => {
        expect(f.inside()).toBe(true);
        return put(...args);
      });
      const removeSpy = vi.spyOn(f.store, 'deleteState').mockImplementation(async (...args) => {
        expect(f.inside()).toBe(true);
        return remove(...args);
      });
      try {
        await f.finish((await f.start()).authorizationUrl);
        await f.service.disconnect(
          target,
          (await f.service.inspect(target)).revision,
          'administrator',
        );
        expect(f.fences()).toBe(4);
        expect(f.provider.metrics()).toMatchObject({ tokenCalls: 1, revoked: 1 });
        expect(putSpy).toHaveBeenCalledOnce();
        expect(removeSpy).toHaveBeenCalledOnce();
      } finally {
        putSpy.mockRestore();
        removeSpy.mockRestore();
      }
    });
  });
}
