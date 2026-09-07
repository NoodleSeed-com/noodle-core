import type { LocalRunningService, LocalServeServiceOptions } from './local-options.js';
import { serveLocalService } from './serve-local.js';

export type {
  LocalDevtoolsDelegatedCredential,
  LocalDevtoolsDelegatedCredentialSink,
  LocalDevtoolsDelegatedProvider,
} from './local-devtools-delegated-credentials.js';
export {
  type LocalDevtoolsDelegatedExchangeAuthority,
  type LocalDevtoolsDelegatedExchangeBindingProjection,
  type LocalDevtoolsDelegatedExchangeRuntime,
  type LocalDevtoolsDelegatedExchangeSuccess,
  projectLocalDevtoolsDelegatedExchangeBindings,
} from './local-devtools-delegated-exchange.js';
export type {
  LocalRunningService as RunningService,
  LocalServeServiceOptions,
} from './local-options.js';
export { resolveTenantBridgeAuthVariables } from './managed-config-expressions.js';
export { parseNoodleServiceYaml, resolveServiceConfigSource } from './service-config.js';
export {
  CONFIG_NAME_PATTERN,
  type ConfigScope,
  type ConfigStore,
  type ConfigValueMetadata,
  type ManagedConfigKind,
  resolveConfigScope,
  SLUG_PATTERN,
  type TenantAuthConfig,
  type TenantBridgeAuthConfig,
} from './store.js';

/** Boot the same public service through its deliberately narrow CLI-local contract. */
export async function serveService(
  options: LocalServeServiceOptions = {},
): Promise<LocalRunningService> {
  return serveLocalService(options);
}
