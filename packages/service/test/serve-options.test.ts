import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryBusinessInformationStore,
  InMemorySourceIngestionStore,
  type SourceReadExecutor,
} from '../src/business-information/portable.js';
import { fenceSourceStore } from '../src/business-information/source-credential-fence.js';
import * as serviceExports from '../src/index.js';
import { InMemoryControlPlaneStore, ServerRegistry, serveService } from '../src/index.js';
import { sourceConfigurationAuthority } from '../src/source-configuration-authority.js';
import { InMemoryConfigStore } from '../src/store/config-values.js';
import { sourceConfigurationFixture } from './source-configuration-fixture.js';

/**
 * Boot-time option validation: retention knobs fail closed on malformed values, mirroring
 * `resolveArchiveRetentionDays`. A negative or fractional `requestEventRetentionDays` would flip
 * the prune cutoff into the future and delete the entire request-event stream on boot.
 */
describe('serveService option validation', () => {
  it('rejects invalid execution custody configuration before binding', async () => {
    await expect(serveService({ port: 0, operationEvidenceEpoch: 'bad epoch' })).rejects.toThrow(
      /operation evidence configuration/i,
    );
    await expect(serveService({ port: 0, operationEvidenceIdentityKey: 'short' })).rejects.toThrow(
      /operation evidence configuration/i,
    );
  });
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

  it('sweeps due external sources on boot without a browser refresh request', async () => {
    const sourceStore = new InMemorySourceIngestionStore({
      identityKey: 'test-source-identity-key-at-least-32-bytes',
    });
    const configStore = new InMemoryConfigStore();
    const fixture = sourceConfigurationFixture(configStore);
    const binding = fixture.declaration;
    // This owner test proves boot scheduling. The full browser harness supplies real deployed sources.
    const active = vi
      .spyOn(ServerRegistry.prototype, 'getActiveByTenant')
      .mockImplementation(fixture.registry.getActiveByTenant);
    const deployed = vi
      .spyOn(ServerRegistry.prototype, 'getDeploymentSource')
      .mockImplementation(fixture.registry.getDeploymentSource);
    const fenced = fenceSourceStore(
      sourceStore,
      sourceConfigurationAuthority(() => fixture.registry),
    );
    await fenced.createBinding(binding);
    const scan = vi.fn<SourceReadExecutor['scan']>().mockResolvedValue({
      records: [{ id: 'sku-1', version: 'one', record: { quantity: 4 } }],
      deletedIds: [],
      checkpoint: 'checkpoint-one',
      complete: true,
    });
    const service = await serveService({
      port: 0,
      configStore,
      businessInformationStore: new InMemoryBusinessInformationStore(),
      businessInformationSourceStore: sourceStore,
      businessInformationSourceExecutor: { scan },
    });
    try {
      await expect
        .poll(async () => (await sourceStore.getBinding(binding))?.lastSuccessfulSyncAt, {
          timeout: 2_000,
        })
        .toBeTypeOf('string');
      expect(scan).toHaveBeenCalledOnce();
      await expect(sourceStore.listExternalRecords(binding)).resolves.toMatchObject({
        records: [{ source: { id: 'sku-1', version: 'one' }, record: { quantity: 4 } }],
      });
    } finally {
      await service.close();
      active.mockRestore();
      deployed.mockRestore();
    }
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

  it('requires durable source identity custody before connecting to Postgres', async () => {
    await expect(
      serveService({
        port: 0,
        databaseUrl: 'postgres://127.0.0.1:1/noodle',
        wrappingMasterKey: {
          kind: 'wrapping',
          keyId: 'test-wrapping-key',
          wrapDek: (dek) => Promise.resolve(dek),
          unwrapDek: (wrapped) => Promise.resolve(wrapped),
        },
      }),
    ).rejects.toThrow(/Postgres business information sources require a stable identity key/);
  });

  it('does not export the retired legacy free-tier seed surface', () => {
    expect(serviceExports).not.toHaveProperty('ensureFreeTierDefault');
    expect(serviceExports).not.toHaveProperty('FREE_TIER_PLAN');
    expect(serviceExports).not.toHaveProperty('FREE_TIER_POLICY_ID');
  });
});
