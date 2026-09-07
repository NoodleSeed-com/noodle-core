import type { Server } from 'node:http';

interface AsyncCloseable {
  close(): Promise<void>;
}

export interface ServiceResourceCleanupInput {
  /** Telemetry runtime; disposing it stops its own timers and drains its buffers. */
  readonly telemetry: { dispose(): Promise<void> };
  readonly welcomeEmailTimer?: NodeJS.Timeout;
  readonly feedbackOperationsTimer?: NodeJS.Timeout;
  readonly businessInformationTimer?: NodeJS.Timeout;
  readonly stopBusinessInformationSweep?: () => void;
  readonly businessInformationSourceTimer?: NodeJS.Timeout;
  readonly alertTimer: NodeJS.Timeout;
  readonly moduleHost?: { dispose(): Promise<void> };
  readonly postgresPool?: AsyncCloseable;
}

/** Close every boot-owned resource, preserving all failures without skipping later cleanup. */
export async function closeServiceResources(input: ServiceResourceCleanupInput): Promise<void> {
  if (input.welcomeEmailTimer !== undefined) clearInterval(input.welcomeEmailTimer);
  if (input.feedbackOperationsTimer !== undefined) clearInterval(input.feedbackOperationsTimer);
  if (input.businessInformationTimer !== undefined) clearInterval(input.businessInformationTimer);
  input.stopBusinessInformationSweep?.();
  if (input.businessInformationSourceTimer !== undefined) {
    clearInterval(input.businessInformationSourceTimer);
  }
  clearInterval(input.alertTimer);

  const errors: unknown[] = [];
  const moduleHost = input.moduleHost;
  if (moduleHost !== undefined) {
    await captureCleanupError(errors, () => moduleHost.dispose());
  }
  await captureCleanupError(errors, () => input.telemetry.dispose());
  const postgresPool = input.postgresPool;
  if (postgresPool !== undefined) {
    await captureCleanupError(errors, () => postgresPool.close());
  }
  if (errors.length > 0) throw new AggregateError(errors, 'service resource cleanup failed');
}

export function listenHttpServer(http: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      http.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      http.off('error', onError);
      resolve();
    };
    http.once('error', onError);
    http.once('listening', onListening);
    http.listen(port, host);
  });
}

export function closeHttpServer(http: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    http.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

async function captureCleanupError(
  errors: unknown[],
  operation: () => Promise<void> | undefined,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    errors.push(error);
  }
}
