import { describe, expect, it, vi } from 'vitest';
import { createOptionalServiceState } from '../../../scripts/lib/system-release-component-state.mjs';
import { promoteSystemRelease } from '../../../scripts/system-release-promote.mjs';
import { validateExpectedState } from '../../../scripts/system-release-status.mjs';
import { harness, manifest, names } from './system-release-harness.js';

const optionalNames = ['portal', 'calendarAdapter'] as const;
type OptionalComponent = (typeof optionalNames)[number];

function firstComponentHarness(absent: OptionalComponent[], failAt: string) {
  const h = harness({ failAt });
  Object.assign(h.state.service, { businessSourceIdentityKeyRef: '' });
  Object.assign(h.state.website, {
    websiteBusinessApiUrl: '',
    websiteDogfoodPublicId: '',
    siteAssistantLeadTokenRef: 'site-assistant-lead-token:latest',
  });
  const prior = structuredClone(h.state);
  const targets = { portal: 'noodleseed-portal', calendarAdapter: 'calendar-adapter' };
  const inventory = new Set(
    optionalNames.filter((name) => !absent.includes(name)).map((name) => targets[name]),
  );
  const removed: string[] = [];
  const optional = createOptionalServiceState({
    targetFor: (name: OptionalComponent) => targets[name],
    list: (target: string) => (inventory.has(target) ? [{ metadata: { name: target } }] : []),
    describe: (target: string) => {
      const name = optionalNames.find((name) => targets[name] === target);
      if (!name) throw new Error('unknown test target');
      return structuredClone(h.state[name]);
    },
    remove: (target: string) => {
      removed.push(target);
      inventory.delete(target);
    },
  });
  const adapter = {
    ...h.adapter,
    async captureState(phase: string) {
      const observed = await h.adapter.captureState(phase);
      return {
        components: {
          ...observed.components,
          portal: optional.capture('portal', phase),
          calendarAdapter: optional.capture('calendarAdapter', phase),
        },
      };
    },
    async deploy(...args: Parameters<typeof h.adapter.deploy>) {
      const [name, image, stamps, phase] = args;
      if (phase === 'promote') optional.prepareDeployment(name, image, stamps);
      await h.adapter.deploy(...args);
      if (name === 'portal' || name === 'calendarAdapter') inventory.add(targets[name]);
    },
    async removeNewService(name: string) {
      optional.removeNewService(name);
    },
  };
  return { h, prior, targets, inventory, removed, adapter };
}

describe('first deployment of stateless solution surfaces', () => {
  it.each([
    'quarantined',
    'reopened',
  ])('never deletes a newly deployed recovery marker %s during rollback', (recoveryMode) => {
    const list = vi.fn<() => { metadata: { name: string } }[]>(() => []);
    const candidate = {
      image: `registry/calendar-adapter@sha256:${'a'.repeat(64)}`,
      releaseId: 'r1',
      gitSha: 'a'.repeat(40),
      manifestChecksum: `sha256:${'b'.repeat(64)}`,
    };
    const remove = vi.fn();
    const state = createOptionalServiceState({
      list,
      remove,
      describe: () => ({ ...candidate, recoveryMode }),
      targetFor: () => 'calendar-adapter',
    });
    state.capture('calendarAdapter', 'previous');
    state.prepareDeployment('calendarAdapter', candidate.image, candidate);
    list.mockReturnValue([{ metadata: { name: 'calendar-adapter' } }]);
    expect(() => state.removeNewService('calendarAdapter')).toThrow(/recovery/i);
    expect(remove).not.toHaveBeenCalled();
  });
  it('requires successful exact inventory before recording absence and refuses arbitrary removal', () => {
    const list = vi.fn<() => { metadata: { name: string } }[]>(() => []);
    const candidate = {
      image: `registry/portal@sha256:${'a'.repeat(64)}`,
      releaseId: 'r1',
      gitSha: 'a'.repeat(40),
      manifestChecksum: `sha256:${'b'.repeat(64)}`,
    };
    const describe = vi.fn(() => candidate);
    const remove = vi.fn();
    const state = createOptionalServiceState({
      list,
      describe,
      remove,
      targetFor: (name: string) => `noodleseed-${name}`,
    });
    expect(state.capture('portal', 'previous')).toEqual({ absent: true });
    state.prepareDeployment('portal', candidate.image, candidate);
    list.mockReturnValue([{ metadata: { name: 'noodleseed-portal' } }]);
    state.removeNewService('portal');
    expect(remove).toHaveBeenCalledWith('noodleseed-portal');
    expect(() => state.removeNewService('service')).toThrow();
    expect(() => state.removeNewService('calendarAdapter')).toThrow();
    expect(describe).toHaveBeenCalledWith('noodleseed-portal');
  });
  it('never interprets an inventory error or malformed inventory as absence', () => {
    const describe = vi.fn();
    const remove = vi.fn();
    for (const list of [
      () => {
        throw new Error('authentication failed');
      },
      () => ({ error: 'denied' }),
      () => [{ metadata: { name: 'other-service' } }],
    ]) {
      const state = createOptionalServiceState({
        list,
        describe,
        remove,
        targetFor: () => 'noodleseed-portal',
      });
      expect(() => state.capture('portal', 'previous')).toThrow();
      expect(() => state.removeNewService('portal')).toThrow();
    }
    expect(describe).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
  it('describes an existing surface and cannot delete it during rollback', () => {
    const describe = vi.fn(() => ({ image: 'existing' }));
    const state = createOptionalServiceState({
      list: () => [{ metadata: { name: 'noodleseed-portal' } }],
      describe,
      remove: vi.fn(),
      targetFor: () => 'noodleseed-portal',
    });
    expect(state.capture('portal', 'previous')).toEqual({ image: 'existing' });
    expect(() => state.removeNewService('portal')).toThrow();
  });
  it('leaves a concurrent replacement alone and tolerates a surface never created', () => {
    const list = vi.fn<() => { metadata: { name: string } }[]>(() => []);
    const remove = vi.fn();
    const state = createOptionalServiceState({
      list,
      describe: () => ({ image: 'different-release' }),
      remove,
      targetFor: () => 'noodleseed-portal',
    });
    state.capture('portal', 'previous');
    state.removeNewService('portal');
    const candidate = {
      image: `registry/portal@sha256:${'a'.repeat(64)}`,
      releaseId: 'r1',
      gitSha: 'a'.repeat(40),
      manifestChecksum: `sha256:${'b'.repeat(64)}`,
    };
    state.prepareDeployment('portal', candidate.image, candidate);
    list.mockReturnValue([{ metadata: { name: 'noodleseed-portal' } }]);
    expect(() => state.removeNewService('portal')).toThrow('no longer belongs');
    expect(remove).not.toHaveBeenCalled();
  });
  it('permits absence only in verified prior snapshots, never a desired candidate or core service', async () => {
    const prior = await harness().adapter.captureState('previous');
    const absent = { components: { ...prior.components, portal: { absent: true } } };
    expect(() => validateExpectedState(absent)).toThrow();
    expect(() => validateExpectedState(absent, { allowAbsent: true })).not.toThrow();
    expect(() =>
      validateExpectedState(
        { components: { ...prior.components, service: { absent: true } } },
        { allowAbsent: true },
      ),
    ).toThrow();
  });
  it('removes only a newly created Portal on failure before irreversible catalog activation', async () => {
    const h = harness({ failAt: 'smoke:portal' });
    const prior = structuredClone(h.state);
    const originalCapture = h.adapter.captureState;
    let portalAbsent = true;
    const removed: string[] = [];
    const originalDeploy = h.adapter.deploy;
    const adapter = {
      ...h.adapter,
      async captureState(phase: string) {
        const value = await originalCapture(phase);
        return {
          components: {
            ...value.components,
            ...(portalAbsent ? { portal: { absent: true } } : {}),
          },
        };
      },
      async deploy(...args: Parameters<typeof originalDeploy>) {
        await originalDeploy(...args);
        if (args[0] === 'portal') portalAbsent = false;
      },
      async removeNewService(name: string) {
        removed.push(name);
        portalAbsent = true;
      },
    };
    await expect(
      promoteSystemRelease({ manifest: manifest(), publish: [] }, adapter),
    ).rejects.toMatchObject({ rollbackFailures: [] });
    expect(removed).toEqual(['portal']);
    expect(portalAbsent).toBe(true);
    expect(h.state.service).toEqual({
      ...prior.service,
      organizationAgreement: h.adapter.organizationAgreement,
    });
    expect(h.state.console).toEqual(prior.console);
    expect(
      h.deployments.some((entry) => entry.phase === 'rollback' && entry.name === 'portal'),
    ).toBe(false);
  });

  it.each([
    { absent: ['portal'], failAt: 'smoke:service' },
    { absent: ['calendarAdapter'], failAt: 'smoke:service' },
    { absent: ['portal', 'calendarAdapter'], failAt: 'smoke:service' },
    { absent: ['portal'], failAt: 'smoke:portal' },
    { absent: ['calendarAdapter'], failAt: 'smoke:portal' },
    { absent: ['portal', 'calendarAdapter'], failAt: 'smoke:portal' },
  ] satisfies {
    absent: OptionalComponent[];
    failAt: string;
  }[])('restores existing components with $absent absent when $failAt fails', async ({
    absent,
    failAt,
  }) => {
    const { h, prior, targets, inventory, removed, adapter } = firstComponentHarness(
      absent,
      failAt,
    );
    await expect(
      promoteSystemRelease({ manifest: manifest(), publish: [] }, adapter),
    ).rejects.toMatchObject({
      cause: { message: `injected ${failAt}` },
      rollbackFailures: [],
    });
    for (const name of names.filter((name) => !absent.includes(name as OptionalComponent))) {
      expect(h.state[name]).toEqual(
        name === 'service'
          ? { ...prior.service, organizationAgreement: h.adapter.organizationAgreement }
          : prior[name],
      );
    }
    for (const name of absent) expect(inventory.has(targets[name])).toBe(false);
    expect(removed).toEqual(failAt === 'smoke:portal' ? absent.map((name) => targets[name]) : []);
    expect(
      h.deployments.filter((entry) => entry.phase === 'rollback').map((entry) => entry.name),
    ).toEqual(names.filter((name) => !absent.includes(name as OptionalComponent)));
  });

  it.each(
    optionalNames,
  )('preserves a concurrent %s replacement while restoring other components', async (replaced) => {
    const { h, prior, targets, inventory, removed, adapter } = firstComponentHarness(
      [...optionalNames],
      'smoke:portal',
    );
    const capture = adapter.captureState;
    const replacementImage = `registry/replacement@sha256:${'f'.repeat(64)}`;
    adapter.captureState = async (phase) => {
      if (phase === 'before-rollback')
        Object.assign(h.state[replaced], {
          image: replacementImage,
          imageDigest: `sha256:${'f'.repeat(64)}`,
        });
      return capture(phase);
    };
    await expect(
      promoteSystemRelease({ manifest: manifest(), publish: [] }, adapter),
    ).rejects.toMatchObject({
      rollbackFailures: [replaced, `convergence: ${replaced}: expected absence after rollback`],
    });
    expect(h.state[replaced].image).toBe(replacementImage);
    expect([...inventory]).toEqual([targets[replaced]]);
    expect(removed).toEqual([targets[replaced === 'portal' ? 'calendarAdapter' : 'portal']]);
    for (const name of ['service', 'githubBuilder', 'website', 'docs', 'console']) {
      expect(h.state[name]).toEqual(
        name === 'service'
          ? { ...prior.service, organizationAgreement: h.adapter.organizationAgreement }
          : prior[name],
      );
    }
  });
});
