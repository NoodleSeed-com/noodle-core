import { describe, expect, it } from 'vitest';
import {
  billingInventoryDeadline,
  releaseJobDeadline,
} from '../../../scripts/lib/system-release-command-adapter.mjs';
import { promoteSystemRelease } from '../../../scripts/system-release-promote.mjs';
import { harness, manifest } from './system-release-harness.js';

describe('billing image preflight before production mutation', () => {
  it('checks the candidate and captured rollback state before the first deployment', async () => {
    const h = harness();
    const previous = structuredClone(h.state);
    h.adapter.preflightBillingCatalog = async (candidate, rollback) => {
      expect(candidate).toEqual(manifest());
      expect(rollback).toHaveProperty('components', previous);
      expect(h.deployments).toEqual([]);
      h.calls.push('preflight:billing-catalog');
    };
    await promoteSystemRelease({ manifest: manifest(), publish: [] }, h.adapter);
    const preflight = h.calls.indexOf('preflight:billing-catalog');
    expect(preflight).toBeGreaterThan(h.calls.indexOf('preflight:workload-identity'));
    expect(preflight).toBeLessThan(h.calls.indexOf('promote:githubBuilder'));
  });

  it('fails unreadable or incompatible image metadata without deployment, rollback, or publication', async () => {
    const h = harness();
    h.adapter.preflightBillingCatalog = async () => {
      throw new Error('billing image metadata unavailable');
    };
    await expect(
      promoteSystemRelease({ manifest: manifest(), publish: [] }, h.adapter),
    ).rejects.toThrow('billing image metadata unavailable');
    expect(h.deployments).toEqual([]);
    expect(h.calls.some((call) => call.startsWith('publish:'))).toBe(false);
  });
});

describe('release job deadline', () => {
  const now = 1_000_000;
  it('caps inventory at twenty minutes and reserves five minutes for rollback', () => {
    expect(billingInventoryDeadline(releaseJobDeadline(undefined, now), now)).toBe(now + 1_200_000);
    expect(billingInventoryDeadline(now + 600_000, now)).toBe(now + 300_000);
    expect(releaseJobDeadline(String(now + 3_600_000), now)).toBe(now + 1_800_000);
  });
  it('rejects invalid or exhausted job budgets before inventory mutations', () => {
    for (const value of ['', 'invalid', '-1', '1.5', 'Infinity'])
      expect(() => releaseJobDeadline(value, now)).toThrow('invalid system release job deadline');
    expect(() => billingInventoryDeadline(now + 300_000, now)).toThrow(
      'insufficient system release rollback time',
    );
  });
});
