import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseCloudRunDescription } from '../../../scripts/system-release-runtime-config.mjs';
import { createPromotionCommandFixture } from '../../../scripts/test-support/system-release/system-release-command-fixture.js';

const fixtures: ReturnType<typeof createPromotionCommandFixture>[] = [];
function fixture(options: Parameters<typeof createPromotionCommandFixture>[0] = {}) {
  const result = createPromotionCommandFixture(options, parseYaml);
  fixtures.push(result);
  return result;
}
afterEach(() => {
  for (const value of fixtures.splice(0)) value.dispose();
});
const mutationKinds = [
  'deploy',
  'remove-service',
  'retire-revision',
  'catalog-activation',
  'npm-publish',
];

describe('complete protected release command', () => {
  it('executes a current-schema first upgrade from five legacy services through exact publication', () => {
    const f = fixture();
    expect(f.manifest.schemaVersion).toBe(7);
    const result = f.run();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(Object.keys(f.state().components)).toHaveLength(7);
    for (const [name, component] of Object.entries(f.state().components)) {
      const logicalName =
        name === 'builder'
          ? 'githubBuilder'
          : name === 'calendar-adapter'
            ? 'calendarAdapter'
            : name;
      const path =
        name === 'builder'
          ? ['spec', 'template', 'spec', 'template', 'spec', 'containers']
          : ['spec', 'template', 'spec', 'containers'];
      expect(parseCloudRunDescription(component, path)).toMatchObject({
        releaseId: f.manifest.releaseId,
        gitSha: f.manifest.gitSha,
        manifestChecksum: f.manifest.manifestChecksum,
        imageDigest: f.manifest.images[logicalName],
      });
    }
    expect(f.effects()).toContainEqual({ kind: 'smoke', name: 'portal-readiness-smoke.mjs' });
    expect(f.effects()).toContainEqual({ kind: 'public-readiness', name: 'portal.example.com' });
    expect(f.effects().filter((event) => event.kind === 'catalog-activation')).toEqual([]);
    expect(f.effects().filter((event) => event.kind === 'retire-revision')).toEqual([]);
    expect(f.state().catalog).toBe(1);
    expect(f.effects().filter((event) => event.kind === 'npm-publish')).toHaveLength(3);
    for (const [name, record] of Object.entries(f.manifest.packages))
      expect(f.state().npm[name]).toEqual({ version: record.version, integrity: record.integrity });
  });

  it.each([
    'image-preflight',
    'missing-docker-auth',
  ])('fails %s before the first hosted or npm mutation', (failure) => {
    const f = fixture({ fail: failure === 'image-preflight' ? failure : undefined });
    const result = f.run({ registryAuth: failure !== 'missing-docker-auth' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('release image metadata unavailable');
    expect(f.effects().filter((event) => mutationKinds.includes(event.kind))).toEqual([]);
  });

  it.each([
    'reader-floor',
    'portal-create',
    'readiness:calendar-adapter',
    'portal-smoke',
    'hosted-convergence',
    'billing-preparation',
  ])('restores actual legacy state after %s fails before activation', (fail) => {
    const f = fixture({
      fail,
      scenario: fail === 'billing-preparation' ? 'compatible-readers' : undefined,
    });
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('before billing activation');
    expect(result.stderr).not.toContain('rollback failures');
    expect(Object.keys(f.state().components).sort()).toEqual(Object.keys(f.initial).sort());
    for (const [name, original] of Object.entries(f.initial)) {
      const path =
        name === 'builder'
          ? ['spec', 'template', 'spec', 'template', 'spec', 'containers']
          : ['spec', 'template', 'spec', 'containers'];
      const before = parseCloudRunDescription(original, path);
      const after = parseCloudRunDescription(f.state().components[name], path);
      // Rollback intentionally advances the analytics fence; it preserves other tracked authority.
      delete before.productAnalyticsEpoch;
      delete after.productAnalyticsEpoch;
      if (name === 'service') before.productAnalyticsEnabled = 'false';
      expect(after).toEqual(before);
    }
    expect(f.effects().filter((event) => event.kind === 'npm-publish')).toEqual([]);
  });

  it('activates the later compatible-reader release using normalized inventory and publishes afterwards', () => {
    const f = fixture({ scenario: 'compatible-readers' });
    const result = f.run();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(f.state().catalog).toBe(2);
    const events = f.effects();
    expect(events.filter((event) => event.kind === 'catalog-activation')).toHaveLength(1);
    expect(
      events.filter((event) => event.kind === 'retire-revision').map((event) => event.name),
    ).toEqual(['service-historical']);
    expect(events.findIndex((event) => event.kind === 'catalog-activation')).toBeLessThan(
      events.findIndex((event) => event.kind === 'npm-publish'),
    );
  });

  it.each([
    'activation-token',
    'activation-rejected',
    'activation-malformed',
    'activation-ambiguous',
  ])('retries %s forward from persisted state without rollback or duplicate activation', (fail) => {
    const f = fixture({ scenario: 'compatible-readers', fail });
    const first = f.run();
    expect(first.status).toBe(1);
    expect(first.stderr).toContain('retry forward without rollback');
    expect(
      f
        .effects()
        .some(
          (event) =>
            event.kind === 'remove-service' || (event.kind === 'deploy' && event.release === 'r41'),
        ),
    ).toBe(false);
    expect(f.effects().filter((event) => event.kind === 'npm-publish')).toEqual([]);
    const preparedInventories = f
      .effects()
      .filter((event) => event.kind === 'revision-inventory').length;
    const second = f.run();
    expect(second.stderr).toBe('');
    expect(second.status).toBe(0);
    expect(f.effects().filter((event) => event.kind === 'catalog-activation')).toHaveLength(1);
    expect(f.state().catalog).toBe(2);
    expect(
      f.effects().filter((event) => event.kind === 'revision-inventory').length,
    ).toBeGreaterThan(preparedInventories);
    const requests = f.effects().filter((event) => event.kind === 'activation-request');
    expect(requests).toHaveLength(fail === 'activation-token' ? 1 : 2);
    if (requests.length === 2) {
      expect(Date.parse(requests[1].checkedAt ?? '')).toBeGreaterThan(
        Date.parse(requests[0].checkedAt ?? ''),
      );
    }
  });

  it('resumes partial npm publication without republishing accepted bytes', () => {
    const f = fixture({ fail: 'npm-partial' });
    expect(f.run().status).toBe(1);
    expect(
      f
        .effects()
        .filter((event) => event.kind === 'npm-publish')
        .map((event) => event.package),
    ).toEqual(['@noodleseed/one']);
    const second = f.run();
    expect(second.stderr).toBe('');
    expect(second.status).toBe(0);
    expect(f.state().catalog).toBe(1);
    expect(f.effects()).toContainEqual({ kind: 'predecessor-read', release: 'r41' });
    expect(f.effects().filter((event) => event.kind === 'npm-publish')).toHaveLength(3);
  });

  it('recovers a fresh candidate after a partially published first upgrade while retaining catalog 1', () => {
    const f = fixture({ fail: 'npm-partial' });
    expect(f.run().status).toBe(1);
    expect(f.state().catalog).toBe(1);
    f.advanceCandidate();
    expect(f.manifest.releaseId).toBe('r43');
    expect(f.manifest.previousReleaseId).toBe('r41');
    const result = f.run();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(f.state().catalog).toBe(1);
    expect(f.effects()).toContainEqual({ kind: 'predecessor-read', release: 'r41' });
    expect(f.effects().filter((event) => event.kind === 'npm-publish')).toHaveLength(3);
    expect(f.effects().filter((event) => event.kind === 'catalog-activation')).toEqual([]);
  });

  it('accepts the exact staged-version conflict and fails closed on conflicting retry integrity', () => {
    const staged = fixture({ fail: 'npm-staged' });
    const result = staged.run();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    staged.corruptPublishedIntegrity('@noodleseed/one');
    const mutations = staged.effects().filter((event) => mutationKinds.includes(event.kind)).length;
    const retry = staged.run();
    expect(retry.status).toBe(1);
    expect(retry.stderr).toContain('integrity');
    expect(staged.effects().filter((event) => mutationKinds.includes(event.kind))).toHaveLength(
      mutations,
    );
  });

  it('submits all exact packages before waiting thirteen minutes for visibility and delayed latest', () => {
    const f = fixture({ fail: 'npm-delayed' });
    const result = f.run();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const effects = f.effects();
    const firstWait = effects.findIndex((event) => event.kind === 'clock-wait');
    expect(firstWait).toBeGreaterThan(0);
    expect(
      effects.slice(0, firstWait).filter((event) => event.kind === 'npm-publish'),
    ).toHaveLength(3);
    for (const name of Object.keys(f.manifest.packages)) {
      const staleFields = effects
        .filter((event) => event.kind === 'stale-npm-read' && event.package === name)
        .map((event) => event.name);
      expect(staleFields).toContain('versions');
      expect(staleFields).toContain('latest');
    }
    const elapsedMs = effects.findLast((event) => event.kind === 'clock-wait')?.elapsedMs ?? 0;
    expect(elapsedMs).toBeGreaterThanOrEqual(13 * 60_000);
    expect(elapsedMs).toBeLessThan(20 * 60_000);
    expect(effects.filter((event) => event.kind === 'npm-publish')).toHaveLength(3);
    expect(effects.filter((event) => event.kind === 'remove-service')).toEqual([]);
    expect(f.state().catalog).toBe(1);
  });

  it('stops unavailable publications within one shared budget and keeps the converged hosted release', () => {
    const f = fixture({ fail: 'npm-never-visible' });
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('did not converge within the shared publication deadline');
    const effects = f.effects();
    expect(effects.filter((event) => event.kind === 'npm-publish')).toHaveLength(3);
    expect(effects.filter((event) => event.kind === 'remove-service')).toEqual([]);
    expect(
      effects.filter((event) => event.kind === 'deploy').every((event) => event.release === 'r42'),
    ).toBe(true);
    const elapsedMs = effects.findLast((event) => event.kind === 'clock-wait')?.elapsedMs ?? 0;
    expect(elapsedMs).toBeGreaterThan(19 * 60_000);
    expect(elapsedMs).toBeLessThanOrEqual(20 * 60_000);
    expect(Object.keys(f.state().components)).toHaveLength(7);
    expect(f.state().catalog).toBe(1);
  });

  it('rejects a changed immutable bundle on retry before further deployment or publication', () => {
    const f = fixture({ fail: 'npm-partial' });
    expect(f.run().status).toBe(1);
    const mutations = f.effects().filter((event) => mutationKinds.includes(event.kind)).length;
    f.changeRetryBundle();
    const second = f.run();
    expect(second.status).toBe(1);
    expect(second.stderr).toContain('checksum');
    expect(f.effects().filter((event) => mutationKinds.includes(event.kind))).toHaveLength(
      mutations,
    );
  });
});
