import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MODULE_API_VERSION, type ModuleHostContext } from '@noodle-borg/module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FilesystemAssetStore } from '../src/filesystem-store.js';
import { createModule } from '../src/module.js';

const SALT = Buffer.alloc(32, 0x42).toString('base64url');
const context: ModuleHostContext = {
  logger: {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  },
  clock: () => new Date('2026-08-24T00:00:00.000Z'),
};

afterEach(() => vi.unstubAllEnvs());

describe('filesystem asset storage module', () => {
  it('validates explicit root and salt before returning a module', () => {
    expect(() => createModule({ root: 'relative/assets', salt: SALT })).toThrow(/absolute path/i);
    expect(() => createModule({ root: join(tmpdir(), 'assets'), salt: 'too-short' })).toThrow(
      /32 bytes.*base64url/i,
    );
  });

  it('returns one API v2 asset-store contribution and constructs it during init', async () => {
    vi.stubEnv('NOODLE_ASSET_ROOT', 'ambient/relative/path');
    vi.stubEnv('NOODLE_ASSET_IDENTITY_SALT', 'ambient-salt');
    const module = createModule({ root: join(tmpdir(), 'explicit-assets'), salt: SALT });

    expect(module).toMatchObject({
      name: '@noodle-borg/asset-storage',
      version: '0.0.0',
      apiVersion: MODULE_API_VERSION,
    });
    const first = await module.init(context);
    const second = await module.init(context);

    expect(Object.keys(first)).toEqual(['assetStore']);
    expect(first.assetStore).toBeInstanceOf(FilesystemAssetStore);
    expect(second.assetStore).toBeInstanceOf(FilesystemAssetStore);
    expect(second.assetStore).not.toBe(first.assetStore);
  });
});
