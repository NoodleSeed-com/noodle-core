import { describe, expect, it, vi } from 'vitest';
import { createOptionalServiceState } from '../../../scripts/lib/system-release-component-state.mjs';
import { promoteSystemRelease } from '../../../scripts/system-release-promote.mjs';
import { validateExpectedState } from '../../../scripts/system-release-status.mjs';
import { harness, manifest } from './system-release-harness.js';

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
});
