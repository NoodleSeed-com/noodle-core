import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  closeHttpServer,
  closeServiceResources,
  listenHttpServer,
} from '../src/service-resource-cleanup.js';

describe('service resource cleanup', () => {
  it('continues closing later resources and reports every cleanup failure', async () => {
    const calls: string[] = [];
    const alertTimer = setInterval(() => undefined, 60_000);

    const result = closeServiceResources({
      alertTimer,
      stopBusinessInformationSweep: () => {
        calls.push('retention');
      },
      telemetry: {
        dispose: async () => {
          calls.push('telemetry');
          throw new Error('telemetry failed');
        },
      },
      moduleHost: {
        dispose: async () => {
          calls.push('modules');
        },
      },
      postgresPool: {
        close: async () => {
          calls.push('postgres');
          throw new Error('postgres failed');
        },
      },
    });

    await expect(result).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [
        expect.objectContaining({ message: 'telemetry failed' }),
        expect.objectContaining({ message: 'postgres failed' }),
      ],
    });
    expect(calls).toEqual(['retention', 'modules', 'telemetry', 'postgres']);
  });

  it('rejects a failed listen instead of leaving service startup pending', async () => {
    const blocker = createServer();
    const candidate = createServer();
    await listenHttpServer(blocker, 0, '127.0.0.1');
    const port = (blocker.address() as AddressInfo).port;

    try {
      await expect(listenHttpServer(candidate, port, '127.0.0.1')).rejects.toMatchObject({
        code: 'EADDRINUSE',
      });
    } finally {
      await closeHttpServer(blocker);
    }
  });
});
