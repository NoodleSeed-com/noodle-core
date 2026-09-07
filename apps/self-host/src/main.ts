#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { createModule as createAssetStorageModule } from '@noodle-borg/asset-storage';
import { type RunningService, type ServeServiceOptions, serveService } from '@noodle-borg/service';
import { createLogger, type Logger } from '@noodle-borg/transport-http';

import { SelfHostAdminGate } from './admin-gate.js';
import { resolveSelfHostConfig } from './config.js';
import { ownerAuthOptions } from './owner-auth.js';

type SelfHostRunningService = Pick<RunningService, 'close'>;
type SigtermHandler = () => Promise<void>;

export interface SelfHostServiceDependencies {
  readonly serve: (options: ServeServiceOptions) => Promise<SelfHostRunningService>;
  readonly logger: Logger;
  readonly onSigterm: (handler: SigtermHandler) => void;
  readonly setExitCode: (code: number) => void;
}

const logger = createLogger({ base: { svc: 'noodle-self-host' } });
const defaultDependencies: SelfHostServiceDependencies = {
  serve: serveService,
  logger,
  onSigterm: (handler) => {
    process.once('SIGTERM', () => void handler().catch(() => undefined));
  },
  setExitCode: (code) => {
    process.exitCode = code;
  },
};

/** Validate operator configuration, compose the portable service, and register graceful shutdown. */
export async function startSelfHostService(
  env: Readonly<Record<string, string | undefined>> = process.env,
  dependencies: SelfHostServiceDependencies = defaultDependencies,
): Promise<SelfHostRunningService> {
  const config = resolveSelfHostConfig(env);
  const lifecycleFields = {
    host: config.host,
    port: config.port,
    persistence: 'postgresql',
    protocolMode: 'dual',
  } as const;
  const running = await dependencies.serve({
    host: config.host,
    port: config.port,
    publicBaseUrl: config.publicBaseUrl,
    assetPublicBaseUrl: config.publicBaseUrl,
    databaseUrl: config.databaseUrl,
    secretMasterKey: config.secretMasterKey,
    warmAll: true,
    mcpProtocolMode: 'dual',
    modules: [
      createAssetStorageModule({
        root: config.assetRoot,
        salt: config.assetIdentitySalt,
      }),
    ],
    deployGate: new SelfHostAdminGate(config.adminToken),
    ...(await ownerAuthOptions(config.ownerAuth)),
    logger: dependencies.logger,
  });

  dependencies.logger.info('self_host.ready', lifecycleFields);
  let closePromise: Promise<void> | undefined;
  dependencies.onSigterm(() => {
    closePromise ??= running.close().then(
      () => dependencies.logger.info('self_host.stopped', lifecycleFields),
      (error: unknown) => {
        dependencies.logger.error('self_host.stop_failed', lifecycleFields);
        dependencies.setExitCode(1);
        throw error;
      },
    );
    return closePromise;
  });
  return running;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  startSelfHostService().catch(() => {
    logger.error('self_host.start_failed');
    process.exitCode = 1;
  });
}
