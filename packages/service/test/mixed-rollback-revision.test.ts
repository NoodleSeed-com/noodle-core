import { describe, expect, it } from 'vitest';
import { type DeployRecord, InMemoryArtifactStore, ServerRegistry } from '../src/index.js';
import { activateInMemory } from '../src/registry-state.js';

const tenant = { org: 'rollback', app: 'support', env: 'prod' };
const auth = { issuer: 'https://rollback.example', audience: 'api://rollback' };
const manifest = JSON.stringify({
  manifestVersion: '2',
  server: { name: 'support', title: 'Support', version: '1.0.0', auth },
  tools: [
    {
      name: 'help',
      description: 'Public help',
      inputSchema: { type: 'object' },
      fulfilment: { steps: [], output: { ok: true } },
    },
  ],
});
const history: DeployRecord = {
  schemaVersion: 2,
  deploymentId: 'history',
  orgSlug: tenant.org,
  appSlug: tenant.app,
  environment: tenant.env,
  deploymentVersion: 1,
  active: false,
  serverName: 'support',
  createdAt: '2026-09-01T00:00:00.000Z',
  createdBySubject: 'owner',
  accessMode: 'mixed',
  serverAuth: auth,
  manifest,
  secrets: { enc: 'none', values: {} },
};
const current = { ...history, deploymentId: 'current', deploymentVersion: 2, active: true };

describe('mixed customer rollback validation', () => {
  it.each([
    { ...auth, issuer: 'https://different.example' },
    { ...auth, audience: 'api://different' },
    { ...auth, audience: '' },
  ])('rejects an existing conflicting or malformed projection %# without mutation', async (serverAuth) => {
    const store = new InMemoryArtifactStore();
    await store.append(current);
    const target = { ...history, serverAuth };
    await store.append(target);
    await expect(
      new ServerRegistry(store).rollback(tenant, history.deploymentId),
    ).resolves.toMatchObject({ ok: false, status: 409 });
    expect(await store.get(history.deploymentId)).toEqual(target);
    expect(await store.getActiveByTenant(tenant)).toEqual(current);
  });

  it.each([
    1, 2,
  ])('repairs only an omitted projection on an unchanged schema-%i historical record', async (schemaVersion) => {
    const store = new InMemoryArtifactStore();
    await store.append(current);
    await store.append({ ...history, schemaVersion, serverAuth: undefined });
    await expect(
      new ServerRegistry(store).rollback(tenant, history.deploymentId),
    ).resolves.toMatchObject({ ok: true });
    expect(await store.getActiveByTenant(tenant)).toMatchObject({
      deploymentId: history.deploymentId,
      schemaVersion,
      ...(schemaVersion === 2 ? { serverAuth: auth } : {}),
    });
  });

  it('rejects replacement of the validated rollback source before activation', async () => {
    class RaceStore extends InMemoryArtifactStore {
      override async activateDeployment(
        ...args: Parameters<InMemoryArtifactStore['activateDeployment']>
      ) {
        await this.append({
          ...history,
          manifest: manifest.replace('api://rollback', 'api://new'),
          serverAuth: { ...auth, audience: 'api://new' },
        });
        return super.activateDeployment(...args);
      }
    }
    const store = new RaceStore();
    await store.append(current);
    await store.append(history);
    const service = new ServerRegistry(store);
    await expect(service.rollback(tenant, history.deploymentId)).resolves.toMatchObject({
      ok: false,
      status: 409,
    });
    expect(await store.getActiveByTenant(tenant)).toEqual(current);
    expect(await store.get(history.deploymentId)).toMatchObject({
      active: false,
      serverAuth: { ...auth, audience: 'api://new' },
    });
    expect((await service.getActiveByTenant(tenant))?.served.artifact.server.auth).toEqual(auth);
    expect(
      (await new ServerRegistry(store).getActiveByTenant(tenant))?.served.artifact.server.auth,
    ).toEqual(auth);
  });

  it('rejects replacement of an automated candidate after compilation', async () => {
    class RaceStore extends InMemoryArtifactStore {
      override async activateDeployment(
        ...args: Parameters<InMemoryArtifactStore['activateDeployment']>
      ) {
        const target = await this.get(args[1]);
        if (target === undefined) throw new Error('missing candidate');
        await this.append({
          ...target,
          manifest: target.manifest.replace('Public help', 'Changed help'),
        });
        return super.activateDeployment(...args);
      }
    }
    const store = new RaceStore();
    await store.append(current);
    const service = new ServerRegistry(store);
    await expect(
      service.deploy(tenant, manifest, {
        accessMode: 'mixed',
        actor: { subject: 'owner', superAdmin: false },
        automationId: 'test-run',
      }),
    ).resolves.toMatchObject({ ok: false, errors: [{ code: 'run_activation_failed' }] });
    expect(await store.getActiveByTenant(tenant)).toEqual(current);
  });

  it('checks the validated revision in the no-store activation path', () => {
    const changed = { ...history, connectors: 'new connector inputs' };
    const records = new Map([
      [current.deploymentId, current],
      [history.deploymentId, changed],
    ]);
    expect(
      activateInMemory(records, tenant, history.deploymentId, {
        expectedAccessMode: history.accessMode,
        expectedSchemaVersion: history.schemaVersion,
        expectedRevision: history,
      }),
    ).toBeUndefined();
    expect(records.get(current.deploymentId)).toEqual(current);
    expect(records.get(history.deploymentId)).toEqual(changed);
  });
});
