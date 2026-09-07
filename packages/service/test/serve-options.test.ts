import { describe, expect, it } from 'vitest';
import { InMemoryBusinessInformationStore } from '../src/business-information/portable.js';
import * as serviceExports from '../src/index.js';
import { InMemoryControlPlaneStore, serveService } from '../src/index.js';

/**
 * Boot-time option validation: retention knobs fail closed on malformed values, mirroring
 * `resolveArchiveRetentionDays`. A negative or fractional `requestEventRetentionDays` would flip
 * the prune cutoff into the future and delete the entire request-event stream on boot.
 */
describe('serveService option validation', () => {
  it('never enables direct Firebase bridge verification on a non-loopback bind', async () => {
    await expect(
      serveService({
        host: '0.0.0.0',
        port: 0,
        localDevtoolsDirectFirebaseAuth: true,
      }),
    ).rejects.toThrow(/local Devtools Firebase.*loopback/i);
  });

  it('never enables direct Microsoft bridge verification on a non-loopback bind', async () => {
    await expect(
      serveService({
        host: '0.0.0.0',
        port: 0,
        localDevtoolsDirectMicrosoftAuth: true,
      }),
    ).rejects.toThrow(/local Devtools Microsoft.*loopback/i);
  });

  it.each([
    0,
    -1,
    2.5,
    Number.NaN,
  ])('rejects requestEventRetentionDays=%s at boot', async (days) => {
    await expect(serveService({ port: 0, requestEventRetentionDays: days })).rejects.toThrow(
      /requestEventRetentionDays/,
    );
  });

  it('boots and closes cleanly with a valid retention override', async () => {
    const service = await serveService({ port: 0, requestEventRetentionDays: 7 });
    await service.close();
  });

  it('does not interpret private hosted-asset environment in the public service', async () => {
    const previousAdapter = process.env.NOODLE_ASSET_ADAPTER;
    process.env.NOODLE_ASSET_ADAPTER = 'r2';
    try {
      const service = await serveService({ port: 0 });
      await service.close();
    } finally {
      if (previousAdapter === undefined) delete process.env.NOODLE_ASSET_ADAPTER;
      else process.env.NOODLE_ASSET_ADAPTER = previousAdapter;
    }
  });

  it('rejects a split Postgres artifact and control-plane configuration before connecting', async () => {
    await expect(
      serveService({
        port: 0,
        databaseUrl: 'postgres://127.0.0.1:1/noodle',
        secretMasterKey: Buffer.alloc(32, 1).toString('base64'),
        controlPlaneStore: new InMemoryControlPlaneStore(),
      }),
    ).rejects.toThrow(/Postgres persistence must own the control-plane store/);
  });

  it('rejects a split Postgres business-information configuration before connecting', async () => {
    await expect(
      serveService({
        port: 0,
        databaseUrl: 'postgres://127.0.0.1:1/noodle',
        secretMasterKey: Buffer.alloc(32, 1).toString('base64'),
        businessInformationStore: new InMemoryBusinessInformationStore(),
      }),
    ).rejects.toThrow(/Postgres persistence must own the business information store/);
  });

  it('does not export the retired legacy free-tier seed surface', () => {
    expect(serviceExports).not.toHaveProperty('ensureFreeTierDefault');
    expect(serviceExports).not.toHaveProperty('FREE_TIER_PLAN');
    expect(serviceExports).not.toHaveProperty('FREE_TIER_POLICY_ID');
  });
});
