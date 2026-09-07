import { describe, expect, it } from 'vitest';
import type { ConfigStore } from '../src/store/config-values.js';

export function describeConfigTransactions(
  name: string,
  fresh: () => Promise<ConfigStore & Required<Pick<ConfigStore, 'transactConfig'>>>,
) {
  describe(name, () => {
    it('keeps outside readers isolated while transaction participants read their own writes', async () => {
      const store = await fresh();
      const scope = { level: 'org', org: 'acme' } as const;
      await store.setConfigValue({ kind: 'variable', scope, name: 'LIMIT', value: '10' });
      let readOutside = () => {};
      const ready = new Promise<void>((resolve) => {
        readOutside = resolve;
      });
      const outside = (async () => {
        await ready;
        return store.resolveConfigValues('variable', scope);
      })();
      await store.transactConfig('acme', async (transaction) => {
        await transaction.setConfigValue({ kind: 'variable', scope, name: 'LIMIT', value: '20' });
        readOutside();
        expect(await outside).toEqual({ LIMIT: '10' });
        expect(await store.resolveConfigValues('variable', scope)).toEqual({ LIMIT: '20' });
      });
      expect(await store.resolveConfigValues('variable', scope)).toEqual({ LIMIT: '20' });
    });

    it('rolls back a caught nested participant failure instead of committing partial state', async () => {
      const store = await fresh();
      const scope = { level: 'org', org: 'acme' } as const;
      await expect(
        store.transactConfig('acme', async () => {
          await store.setConfigValue({ kind: 'variable', scope, name: 'LIMIT', value: '20' });
          await store
            .transactConfig('acme', async () => {
              throw new Error('nested rejection');
            })
            .catch(() => undefined);
        }),
      ).rejects.toThrow('nested rejection');
      expect(await store.resolveConfigValues('variable', scope)).toEqual({});
    });

    it('commits a batch together and rolls back a failed update', async () => {
      const store = await fresh();
      const scope = { level: 'env', org: 'acme', app: 'desk', env: 'prod' } as const;
      await store.setConfigValue({ kind: 'variable', scope, name: 'LIMIT', value: '10' });
      await expect(
        store.transactConfig('acme', async (transaction) => {
          await transaction.setConfigValue({ kind: 'variable', scope, name: 'LIMIT', value: '20' });
          expect(await store.resolveConfigValues('variable', scope)).toEqual({ LIMIT: '20' });
          throw new Error('invalid dependent setting');
        }),
      ).rejects.toThrow('invalid dependent setting');
      expect(await store.resolveConfigValues('variable', scope)).toEqual({ LIMIT: '10' });
      await store.transactConfig('acme', async (transaction) => {
        await transaction.setConfigValue({ kind: 'variable', scope, name: 'LIMIT', value: '30' });
        await transaction.setConfigValue({ kind: 'variable', scope, name: 'DAYS', value: '[1,2]' });
      });
      expect(await store.resolveConfigValues('variable', scope)).toEqual({
        LIMIT: '30',
        DAYS: '[1,2]',
      });
    });

    it('serializes concurrent hierarchy mutations without lost updates', async () => {
      const store = await fresh();
      const scope = { level: 'org', org: 'acme' } as const;
      await Promise.all(
        Array.from({ length: 20 }, () =>
          store.transactConfig('acme', async (transaction) => {
            const values = await transaction.resolveConfigValues('variable', scope);
            await transaction.setConfigValue({
              kind: 'variable',
              scope,
              name: 'COUNT',
              value: String(Number(values.COUNT ?? 0) + 1),
            });
          }),
        ),
      );
      expect(await store.resolveConfigValues('variable', scope)).toEqual({ COUNT: '20' });
    });

    it('rejects cross-organization transaction access and keeps default provenance', async () => {
      const store = await fresh();
      const scope = { level: 'org', org: 'acme' } as const;
      await expect(
        store.transactConfig('acme', async (transaction) => {
          await transaction.setConfigValue({
            kind: 'variable',
            scope: { level: 'org', org: 'other' },
            name: 'KEY',
            value: 'x',
          });
        }),
      ).rejects.toThrow('configuration transaction organization mismatch');
      await store.setConfigValue({
        kind: 'variable',
        scope,
        name: 'DEFAULT',
        value: 'true',
        valueOrigin: 'default',
      });
      expect(await store.listConfigValues('variable', scope)).toEqual([
        expect.objectContaining({ name: 'DEFAULT', valueOrigin: 'default' }),
      ]);
    });
  });
}
