import { InMemoryDailyCounterStore } from '@noodle-borg/admission-limits/portable';
import {
  CapabilityBudget,
  CapabilityService,
  InMemoryCapabilityPolicyStore,
  type WebCapability,
} from '@noodle-borg/managed-capabilities';
import {
  executeTool,
  executeToolInteractive,
  hasEphemeralEvidence,
  resumeTool,
} from '@noodle-borg/runtime';
import { describe, expect, it, vi } from 'vitest';
import { ServerRegistry } from '../src/registry.js';
import { deploymentWebConnector } from '../src/web-capabilities.js';

const tenant = { org: 'acme', app: 'web', env: 'staging' };
const declaration: WebCapability = {
  name: 'pages',
  class: 'web.extract.v1',
  title: 'Read pages',
  description: 'Read explicit public pages.',
  provider: { kind: 'noodle-managed' },
};
async function setup(capability: WebCapability = declaration) {
  const read = vi.fn(async ({ url }: { url: string }) => ({
    url,
    title: 'Example',
    text: 'Ephemeral source evidence',
    links: [],
    retrievedAt: new Date().toISOString(),
  }));
  const capabilities = new CapabilityService({
    profile: 'development',
    policies: new InMemoryCapabilityPolicyStore(),
    counters: new InMemoryDailyCounterStore(),
    reader: { read },
  });
  const registry = new ServerRegistry(undefined, undefined, undefined, { capabilities });
  const deployed = await registry.deploy(
    tenant,
    JSON.stringify({
      manifestVersion: '2',
      server: { name: 'web', title: 'Web', version: '1.0.0', capabilities: [capability] },
      tools: [
        {
          name: 'wrapped_read',
          description: 'Read through a composed tool.',
          inputSchema: { type: 'object' },
          fulfilment: {
            steps: [
              {
                id: 'page',
                use: 'noodle_web.extract',
                args: { name: 'pages', request: '${input}' },
              },
            ],
            output: { evidence: '${steps.page}' },
          },
        },
      ],
    }),
    { accessMode: 'public' },
  );
  if (!deployed.ok) throw new Error(JSON.stringify(deployed.errors));
  const target = await registry.getActiveByTenant(tenant);
  if (!target) throw new Error('missing target');
  await capabilities.configure(tenant, capability, {
    actor: 'owner',
    expectedRevision: 0,
    mutationId: 'first',
    policy: { enabled: true, dailyCalls: 100 },
  });
  return { capabilities, read, target, registry };
}
describe('Borg web capability integration', () => {
  it('deploys, resolves and executes generated and composed tools through the same governed connector', async () => {
    const f = await setup();
    const capabilityBudget = new CapabilityBudget();
    for (const tool of ['extract_pages', 'wrapped_read']) {
      const result = await executeTool(
        f.target.served.artifact,
        tool,
        { urls: ['https://example.com/'] },
        {
          ...f.target.served.deps,
          capabilityBudget,
          publicAdmission: { network: 'trusted-network' },
        },
      );
      expect(result).toMatchObject({ ok: true });
      expect(JSON.stringify(result)).toContain('Ephemeral source evidence');
      if (result.ok) expect(hasEphemeralEvidence(result.output)).toBe(true);
    }
    expect(f.read).toHaveBeenCalledTimes(2);
  });
  it('preserves a shared turn budget across elicitation and refuses a fresh budget on resume', async () => {
    const f = await setup({ ...declaration, policy: { maxCalls: 1 } });
    const deps = {
      ...f.target.served.deps,
      capabilityBudget: new CapabilityBudget(),
      publicAdmission: { network: 'trusted-network' },
    };
    const input = { urls: ['https://example.com/'] };
    expect(await executeTool(f.target.served.artifact, 'extract_pages', input, deps)).toMatchObject(
      { ok: true },
    );
    const tool = f.target.served.artifact.tools.find((t) => t.name === 'wrapped_read');
    if (tool?.fulfilment.kind !== 'flow') throw new Error('expected composed flow');
    const artifact = {
      ...f.target.served.artifact,
      tools: [
        {
          ...tool,
          fulfilment: {
            ...tool.fulfilment,
            steps: [
              {
                id: 'choice',
                kind: 'elicit' as const,
                message: 'Continue?',
                requestedSchema: { type: 'object' },
              },
              ...tool.fulfilment.steps,
            ],
          },
        },
      ],
    };
    const pending = await executeToolInteractive(artifact, tool.name, input, deps);
    if (pending.status !== 'input_required') throw new Error('expected suspension');
    expect(pending.continuation.capabilityBudget?.calls).toBe(1);
    expect(JSON.stringify(pending.continuation)).not.toContain('Ephemeral source evidence');
    const resumed = await resumeTool(
      artifact,
      pending.continuation,
      { action: 'accept', content: {} },
      { ...deps, capabilityBudget: new CapabilityBudget() },
    );
    expect(resumed).toMatchObject({ status: 'failed', error: { code: 'connector_error' } });
    expect(f.read).toHaveBeenCalledTimes(1);
  });
  it('checks the underlying declaration permission even when invoked by an unprotected wrapper', async () => {
    const f = await setup();
    const connector = deploymentWebConnector(
      {
        ...f.target.served.artifact,
        server: {
          ...f.target.served.artifact.server,
          capabilities: [{ ...declaration, authorization: { requiredScopes: ['pages:read'] } }],
        },
      },
      tenant,
      f.target.deploymentId,
      f.capabilities,
    );
    if (!connector) throw new Error('missing connector');
    await expect(
      connector.invoke({
        operation: 'extract',
        args: { name: 'pages', request: { urls: ['https://example.com/'] } },
        credential: { token: '' },
        execution: { id: 'protected-attempt' },
        capabilityBudget: new CapabilityBudget(),
        publicAdmission: { network: 'trusted-network' },
      }),
    ).rejects.toThrow('capability_policy_denied');
    expect(f.read).not.toHaveBeenCalled();
  });
});
