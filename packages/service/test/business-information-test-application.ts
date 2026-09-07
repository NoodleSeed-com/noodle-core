import { expect } from 'vitest';
import type {
  BusinessInformationStore,
  InstallationScope,
} from '../src/business-information/contracts.js';
import type { ServerRegistry } from '../src/registry.js';

/** Give owner-layer record fixtures real runtime application authority without provider I/O. */
export async function activateRecordFixture(
  registry: ServerRegistry,
  store: BusinessInformationStore,
  scope: InstallationScope,
): Promise<void> {
  const deployed = await registry.deploy(
    scope,
    JSON.stringify({
      manifestVersion: '1',
      server: { name: 'record_fixture', version: '1.0.0', title: 'Record fixture' },
      tools: [
        {
          name: 'inspect_fixture',
          description: 'Read fixture readiness.',
          inputSchema: { type: 'object' },
          fulfilment: { steps: [], output: { ready: true } },
        },
      ],
    }),
    { accessMode: 'public' },
  );
  expect(deployed, JSON.stringify(deployed)).toMatchObject({ ok: true });
  const generation = await registry.getAppGeneration(scope.org, scope.app);
  if (!generation) throw new Error('fixture application missing');
  expect(await store.bindApplication(scope, generation)).toBe(true);
}
