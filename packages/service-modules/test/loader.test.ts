import { LEGACY_MODULE_API_VERSION, MODULE_API_VERSION } from '@noodle-borg/module';
import { describe, expect, it } from 'vitest';
import { loadModules, type ModuleSpec } from '../src/loader.js';

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const ctx = {
  logger,
  clock: () => new Date('2026-06-13T00:00:00.000Z'),
};

describe('loadModules', () => {
  it('loads an allowed dynamic module and threads module options', async () => {
    const loaded = await loadModules(
      [{ package: '@vendor/audit', options: { level: 'strict' } }],
      ctx,
      {
        allowlist: ['@vendor/audit'],
        importer: async () => ({
          createModule: () => ({
            name: '@vendor/audit',
            version: '1.0.0',
            apiVersion: 1,
            init: (moduleCtx: typeof ctx) => ({
              readiness: () => moduleCtx.options?.level === 'strict',
            }),
          }),
        }),
      },
    );

    expect(loaded).toHaveLength(1);
    await expect(Promise.resolve(loaded[0]?.contributions.readiness?.())).resolves.toBe(true);
  });

  it('supports already-constructed first-party module instances without allowlist import', async () => {
    const loaded = await loadModules(
      [
        {
          name: '@noodle-borg/first-party',
          version: '0.0.0',
          apiVersion: 1,
          init: () => ({}),
        },
      ],
      ctx,
      { allowlist: [] },
    );

    expect(loaded[0]?.module.name).toBe('@noodle-borg/first-party');
  });

  it('fails closed for allowlist rejects, bad exports, and API mismatches', async () => {
    await expect(
      loadModules([{ package: '@vendor/audit' }], ctx, {
        allowlist: [],
        importer: async () => ({}),
      }),
    ).rejects.toThrow(/not allowlisted/i);

    await expect(
      loadModules([{ package: '@vendor/audit' }], ctx, {
        allowlist: ['@vendor/audit'],
        importer: async () => ({}),
      }),
    ).rejects.toThrow(/factory/i);

    await expect(
      loadModules([{ package: '@vendor/audit' }], ctx, {
        allowlist: ['@vendor/audit'],
        importer: async () => ({
          createModule: () => ({
            name: '@vendor/audit',
            version: '1.0.0',
            apiVersion: 999,
            init: () => ({}),
          }),
        }),
      }),
    ).rejects.toThrow(/api version/i);
  });

  it('applies fail-open only to missing packages and init failures', async () => {
    const specs: ModuleSpec[] = [
      { package: '@vendor/missing', onError: 'fail-open' },
      { package: '@vendor/broken', onError: 'fail-open' },
    ];
    const loaded = await loadModules(specs, ctx, {
      allowlist: ['@vendor/missing', '@vendor/broken'],
      importer: async (name) => {
        if (name === '@vendor/missing') throw new Error('Cannot find package');
        return {
          createModule: () => ({
            name,
            version: '1.0.0',
            apiVersion: 1,
            init: () => {
              throw new Error('boom');
            },
          }),
        };
      },
    });

    expect(loaded).toEqual([]);
  });

  it('lets the same code toggle capabilities through different boot configs', async () => {
    const importer = async () => ({
      createModule: () => ({
        name: '@vendor/toggle',
        version: '1.0.0',
        apiVersion: 1,
        init: (moduleCtx: typeof ctx) =>
          moduleCtx.options?.route
            ? { routes: [{ id: 'enabled', match: () => true, handle: () => undefined }] }
            : {},
      }),
    });

    const off = await loadModules([{ package: '@vendor/toggle' }], ctx, {
      allowlist: ['@vendor/toggle'],
      importer,
    });
    const on = await loadModules([{ package: '@vendor/toggle', options: { route: true } }], ctx, {
      allowlist: ['@vendor/toggle'],
      importer,
    });

    expect(off[0]?.contributions.routes).toBeUndefined();
    expect(on[0]?.contributions.routes?.[0]?.id).toBe('enabled');
  });

  it('adapts a v1 module to the current contribution bag without inventing v2 providers', async () => {
    const loaded = await loadModules(
      [
        {
          name: '@vendor/legacy',
          version: '1.0.0',
          apiVersion: LEGACY_MODULE_API_VERSION,
          init: () =>
            ({
              readiness: () => true,
              assetStore: { shouldNeverReachV2Host: true },
            }) as never,
        },
      ],
      ctx,
    );

    expect(loaded[0]?.module.apiVersion).toBe(LEGACY_MODULE_API_VERSION);
    expect(loaded[0]?.contributions).toEqual({ readiness: expect.any(Function) });
    expect(loaded[0]?.contributions.assetStore).toBeUndefined();
    expect(loaded[0]?.contributions.deploymentActivation).toBeUndefined();
  });

  it('rejects a v2 module when the host explicitly supports only v1', async () => {
    await expect(
      loadModules(
        [
          {
            name: '@vendor/current',
            version: '2.0.0',
            apiVersion: MODULE_API_VERSION,
            init: () => ({}),
          },
        ],
        ctx,
        { hostApiVersion: LEGACY_MODULE_API_VERSION },
      ),
    ).rejects.toThrow(/requires module API v2.*host supports v1/i);
  });
});
