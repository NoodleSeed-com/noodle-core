import { describe, expect, it } from 'vitest';
import { ServerRegistry } from '../src/registry.js';
import { InMemoryConfigStore } from '../src/store/config-values.js';

const tenant = { org: 'acme', app: 'desk', env: 'prod' } as const;
function manifest(choices = ['short', 'long'], required = false) {
  return JSON.stringify({
    manifestVersion: '2',
    server: {
      name: 'desk',
      title: 'Desk',
      version: '1',
      variables: [
        {
          name: 'MODE',
          schemaVersion: 1,
          valueSchema: { type: 'string', enum: choices, maxLength: 20 },
          portal: { label: 'Mode' },
          requiredFor: required ? ['book'] : [],
        },
      ],
    },
    tools: [
      {
        name: 'book',
        description: 'Book a consultation.',
        inputSchema: { type: 'object', additionalProperties: false },
        fulfilment: { steps: [], output: { mode: '${env.MODE}' } },
      },
    ],
  });
}

describe('typed configuration deployment admission', () => {
  it('rejects an incompatible candidate without replacing the valid deployment or values', async () => {
    const config = new InMemoryConfigStore();
    const registry = new ServerRegistry(undefined, undefined, config);
    await config.setConfigValue({
      kind: 'variable',
      scope: { level: 'org', org: 'acme' },
      name: 'MODE',
      value: '"long"',
    });
    const first = await registry.deploy(tenant, manifest(), { accessMode: 'public' });
    expect(first.ok).toBe(true);
    expect(await registry.preflightDeploy(tenant, manifest(['short']))).toMatchObject({
      ok: false,
      errors: [{ code: 'configuration_invalid' }],
    });
    expect(
      await registry.deploy(tenant, manifest(['short']), { accessMode: 'public' }),
    ).toMatchObject({
      ok: false,
      errors: [{ code: 'configuration_invalid' }],
    });
    expect((await registry.getActiveByTenant(tenant))?.deploymentId).toBe(
      first.ok ? first.deploymentId : undefined,
    );
    expect(await config.resolveConfigValues('variable', { level: 'env', ...tenant })).toEqual({
      MODE: '"long"',
    });
  });

  it('rejects incompatible rollback and allows explicit operator repair before retry', async () => {
    const config = new InMemoryConfigStore();
    const registry = new ServerRegistry(undefined, undefined, config);
    const old = await registry.deploy(tenant, manifest(['short']), { accessMode: 'public' });
    const current = await registry.deploy(tenant, manifest(), { accessMode: 'public' });
    if (!old.ok || !current.ok) throw new Error('fixture deployment failed');
    const scope = { level: 'env', ...tenant } as const;
    await config.setConfigValue({ kind: 'variable', scope, name: 'MODE', value: '"long"' });
    expect(await registry.rollback(tenant, old.deploymentId)).toMatchObject({
      ok: false,
      status: 409,
    });
    expect((await registry.getActiveByTenant(tenant))?.deploymentId).toBe(current.deploymentId);
    await config.setConfigValue({ kind: 'variable', scope, name: 'MODE', value: '"short"' });
    expect(await registry.rollback(tenant, old.deploymentId)).toMatchObject({ ok: true });
  });

  it('still admits a fresh publisher with an unresolved required business setting', async () => {
    const registry = new ServerRegistry();
    expect(
      await registry.deploy(tenant, manifest(undefined, true), { accessMode: 'public' }),
    ).toMatchObject({ ok: true });
  });

  it('does not disable an existing tool by newly requiring an unset setting', async () => {
    const registry = new ServerRegistry();
    const before = await registry.deploy(tenant, manifest(), { accessMode: 'public' });
    expect(
      await registry.deploy(tenant, manifest(undefined, true), { accessMode: 'public' }),
    ).toMatchObject({
      ok: false,
      errors: [{ code: 'configuration_required' }],
    });
    expect((await registry.getActiveByTenant(tenant))?.deploymentId).toBe(
      before.ok ? before.deploymentId : undefined,
    );
    await registry.configStore.setConfigValue({
      kind: 'variable',
      scope: { level: 'env', ...tenant },
      name: 'MODE',
      value: '"short"',
    });
    expect(
      await registry.deploy(tenant, manifest(undefined, true), { accessMode: 'public' }),
    ).toMatchObject({ ok: true });
  });
});
