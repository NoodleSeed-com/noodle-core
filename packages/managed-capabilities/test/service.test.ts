import { InMemoryDailyCounterStore } from '@noodle-borg/admission-limits/portable';
import { describe, expect, it, vi } from 'vitest';
import { CapabilityBudget } from '../src/budget.js';
import type { WebCapability } from '../src/contracts.js';
import { InMemoryCapabilityPolicyStore } from '../src/policy-store.js';
import { CapabilityService } from '../src/service.js';

const tenant = { org: 'acme', app: 'demo', env: 'staging' };
const declaration: WebCapability = {
  name: 'pages',
  class: 'web.extract.v1',
  title: 'Read pages',
  description: 'Read public pages',
  provider: { kind: 'noodle-managed' },
  policy: { maxUrls: 2 },
};
async function setup() {
  const policies = new InMemoryCapabilityPolicyStore();
  const counters = new InMemoryDailyCounterStore();
  const read = vi.fn(async ({ url }: { url: string }) => ({
    url,
    title: 'Example',
    text: 'Public evidence',
    links: [],
    retrievedAt: new Date().toISOString(),
  }));
  const audit = vi.fn();
  const service = new CapabilityService({
    profile: 'development',
    policies,
    counters,
    reader: { read },
    audit,
  });
  const configure = (enabled = true, dailyCalls = 100) =>
    service.configure(tenant, declaration, {
      expectedRevision: 0,
      mutationId: 'first',
      actor: 'owner',
      policy: { enabled, dailyCalls },
    });
  const invoke = (executionId = 'exec-1', authorized = true) =>
    service.execute(
      declaration,
      { urls: ['https://example.com/'] },
      {
        tenant,
        deploymentId: 'deploy-1',
        executionId,
        anonymous: true,
        network: 'trusted-network',
        authorized,
        budget: new CapabilityBudget(),
      },
    );
  return { service, configure, invoke, read, policies, counters, audit };
}
describe('capability authority', () => {
  it('defaults disabled and does not spend or read before explicit operator configuration', async () => {
    const f = await setup();
    expect((await f.service.inspect(tenant, declaration)).available).toBe(false);
    await expect(f.invoke()).rejects.toThrow('capability_unavailable');
    expect(f.read).not.toHaveBeenCalled();
    await f.configure();
    expect((await f.service.inspect(tenant, declaration)).available).toBe(true);
    expect((await f.invoke()).status).toBe('complete');
  });
  it('does not replay I/O or dispatch denied calls and admits all daily limits atomically', async () => {
    const f = await setup();
    await f.configure(true, 1);
    await expect(f.invoke('denied', false)).rejects.toThrow('capability_policy_denied');
    expect(f.read).not.toHaveBeenCalled();
    await f.invoke();
    await expect(f.invoke()).rejects.toThrow();
    await expect(f.invoke('exec-2')).rejects.toThrow();
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.audit.mock.calls)).not.toContain('Public evidence');
    expect(JSON.stringify(f.audit.mock.calls)).not.toContain('https://');
  });
  it('rejects wider operator bounds and fails closed on counter outage', async () => {
    const f = await setup();
    await expect(
      f.service.configure(tenant, declaration, {
        expectedRevision: 0,
        mutationId: 'wide',
        actor: 'owner',
        policy: { enabled: true, dailyCalls: 10, maxUrls: 3 },
      }),
    ).rejects.toThrow('capability_policy_denied');
    await f.configure();
    vi.spyOn(f.counters, 'consumeAllOnce').mockRejectedValue(new Error('secret storage error'));
    await expect(f.invoke()).rejects.toThrow('capability_unavailable');
    expect(f.read).not.toHaveBeenCalled();
  });
  it('requires durable authority and exact hosted cohort targets', async () => {
    const f = await setup();
    expect(() => new CapabilityService({ ...f.service.options, profile: 'hosted' })).toThrow(
      'capability_durable_authority_required',
    );
    const hosted = new CapabilityService({
      ...f.service.options,
      profile: 'hosted',
      policies: {
        durable: true,
        get: f.policies.get.bind(f.policies),
        replace: f.policies.replace.bind(f.policies),
      },
      counters: {
        ...f.counters,
        durable: true,
        consume: f.counters.consume.bind(f.counters),
        peek: f.counters.peek.bind(f.counters),
        prune: f.counters.prune.bind(f.counters),
        consumeAll: f.counters.consumeAll.bind(f.counters),
        consumeAllOnce: f.counters.consumeAllOnce.bind(f.counters),
      },
      enabledScopes: [tenant],
    });
    expect(hosted.enabled(tenant)).toBe(true);
    expect(hosted.enabled({ ...tenant, env: 'production' })).toBe(false);
  });
});
