import { MODULE_API_VERSION, type ServiceModule } from '@noodle-borg/module';
import { validateFilesystemAssetRoot } from './filesystem-layout.js';
import { FilesystemAssetStore } from './filesystem-store.js';

export interface AssetStorageModuleOptions {
  readonly root: string;
  readonly salt: string;
}

/** Build the durable filesystem asset provider from explicit self-host operator configuration. */
export function createModule(options: AssetStorageModuleOptions): ServiceModule {
  const root = validateFilesystemAssetRoot(options.root);
  const salt = validateAssetIdentitySalt(options.salt);
  return {
    name: '@noodle-borg/asset-storage',
    version: '0.0.0',
    apiVersion: MODULE_API_VERSION,
    init: () => ({
      assetStore: new FilesystemAssetStore({ root, keySalt: salt }),
    }),
  };
}

function validateAssetIdentitySalt(salt: string): string {
  if (
    typeof salt !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(salt) ||
    Buffer.from(salt, 'base64url').byteLength !== 32 ||
    Buffer.from(salt, 'base64url').toString('base64url') !== salt
  ) {
    throw new TypeError('filesystem asset identity salt must encode exactly 32 bytes as base64url');
  }
  return salt;
}
