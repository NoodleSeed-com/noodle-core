import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InMemoryControlPlaneStore } from '@noodle-borg/control-plane/portable';
import { InMemoryAssetStore } from './assets.js';
import {
  createCustomerVerifierFactory,
  createHostedCustomerVerifierFactory,
  createLocalDevtoolsCustomerVerifierFactory,
} from './customer-verifier.js';
import { createLocalDevtoolsDelegatedCredentialSource } from './local-devtools-delegated-credentials.js';
import type { LocalRunningService, LocalServeServiceOptions } from './local-options.js';
import { ServerRegistry } from './registry.js';
import { isLoopbackHost } from './serve-resource-auth.js';
import { createServiceHandler } from './service.js';
import { closeHttpServer, listenHttpServer } from './service-resource-cleanup.js';
import { InMemoryUserAppLogStore } from './store/user-app-logs.js';
import { InMemoryConfigStore, type SecretEnvelope } from './store.js';

function openLocalCredential(envelope: SecretEnvelope): Promise<string> {
  const token = envelope.enc === 'none' ? envelope.values.token : undefined;
  if (token === undefined) throw new Error('local delegated credential envelope is invalid');
  return Promise.resolve(token);
}

/** Boot the loopback-only in-memory service used by the published CLI author loop. */
export async function serveLocalService(
  options: LocalServeServiceOptions = {},
): Promise<LocalRunningService> {
  const host = options.host ?? '127.0.0.1';
  if (!isLoopbackHost(host)) throw new Error('the CLI local service requires a loopback bind');
  const controlPlaneStore = new InMemoryControlPlaneStore();
  await controlPlaneStore.createOrg({ slug: 'local', displayName: 'Local' });
  const configStore = options.configStore ?? new InMemoryConfigStore();
  const rawCustomerVerifierFactory = createCustomerVerifierFactory({
    allowInsecureLocalhost: options.customerVerifierAllowInsecureLocalhost === true,
    ...(options.customerVerifierFirebaseJwks === undefined
      ? {}
      : { firebaseJwks: options.customerVerifierFirebaseJwks }),
    ...(options.customerVerifierFirebaseJwksUri === undefined
      ? {}
      : { firebaseJwksUri: options.customerVerifierFirebaseJwksUri }),
  });
  const directCustomerAuth =
    options.localDevtoolsDirectFirebaseAuth === true ||
    options.localDevtoolsDirectMicrosoftAuth === true;
  const customerVerifierFactory = directCustomerAuth
    ? createLocalDevtoolsCustomerVerifierFactory(rawCustomerVerifierFactory, {
        allowedProviders: [
          ...(options.localDevtoolsDirectFirebaseAuth === true ? (['firebase'] as const) : []),
          ...(options.localDevtoolsDirectMicrosoftAuth === true ? (['microsoft'] as const) : []),
        ],
        ...(options.localDevtoolsResolveBridgeAuth === undefined
          ? {}
          : { resolveBridgeAuth: options.localDevtoolsResolveBridgeAuth }),
      })
    : createHostedCustomerVerifierFactory(rawCustomerVerifierFactory, undefined);
  const delegatedCredentials = directCustomerAuth
    ? createLocalDevtoolsDelegatedCredentialSource()
    : undefined;
  const registry = new ServerRegistry(undefined, undefined, configStore, {
    customerVerifierFactory,
    ...(delegatedCredentials === undefined
      ? {}
      : {
          delegatedCredentialStore: delegatedCredentials.store,
          sealCustomerCredential: (credential) =>
            Promise.resolve({ enc: 'none' as const, values: { token: credential } }),
          openCustomerCredential: openLocalCredential,
        }),
    ...(options.localDevtoolsDelegatedExchange === undefined
      ? {}
      : { localDevtoolsDelegatedExchange: options.localDevtoolsDelegatedExchange }),
  });
  const handler = createServiceHandler(registry, {
    controlPlaneStore,
    configStore,
    assetStore: new InMemoryAssetStore(),
    userAppLogStore: new InMemoryUserAppLogStore(),
    ...(options.runtime ?? {}),
    ...(options.mcpRequestState === undefined ? {} : { mcpRequestState: options.mcpRequestState }),
    ...(options.mcpConfirmationNonceLedger === undefined
      ? {}
      : { mcpConfirmationNonceLedger: options.mcpConfirmationNonceLedger }),
  });
  const http = createServer(handler);
  try {
    await listenHttpServer(http, options.port ?? 0, host);
    const { port } = http.address() as AddressInfo;
    const urlHost = host.includes(':') ? `[${host}]` : host;
    const url = `http://${urlHost}:${port}`;
    const localDevtoolsDelegatedCredentials = delegatedCredentials?.bind(url);
    return {
      http,
      url,
      port,
      registry,
      ...(localDevtoolsDelegatedCredentials && { localDevtoolsDelegatedCredentials }),
      close: () => closeHttpServer(http),
    };
  } catch (error) {
    if (http.listening) await closeHttpServer(http).catch(() => undefined);
    throw error;
  }
}
