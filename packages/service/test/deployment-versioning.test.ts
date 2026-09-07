import { describe, expect, it } from 'vitest';
import {
  compareDeployRecordVersionDescending,
  type DeploymentVersionRecord,
  defaultActiveRecord,
  sameDeploymentScope,
  sameTenantRecord,
} from '../src/deployment-versioning.js';

const REF = { org: 'acme', app: 'hello', env: 'prod' };

function record(input: Partial<DeploymentVersionRecord> = {}): DeploymentVersionRecord {
  return {
    orgSlug: 'acme',
    appSlug: 'hello',
    environment: 'prod',
    active: true,
    deploymentVersion: 1,
    ...input,
  };
}

describe('deployment versioning helpers', () => {
  it('matches records by tenant ref or another record', () => {
    const current = record();
    expect(sameTenantRecord(current, REF)).toBe(true);
    expect(sameTenantRecord(current, record({ deploymentVersion: 2 }))).toBe(true);
    expect(sameTenantRecord(current, { ...REF, app: 'other' })).toBe(false);
  });

  it('scopes active deployments by tenant and server version', () => {
    expect(
      sameDeploymentScope(record({ serverVersion: '1' }), record({ serverVersion: '1' })),
    ).toBe(true);
    expect(
      sameDeploymentScope(record({ serverVersion: '1' }), record({ serverVersion: '2' })),
    ).toBe(false);
    expect(sameDeploymentScope(record(), record())).toBe(true);
  });

  it('returns the highest active semantic version and breaks ties by deployment time', () => {
    const v2Old = record({ deploymentVersion: 2, serverVersion: '2.0.0' });
    const v2New = record({ deploymentVersion: 3, serverVersion: '2.0' });
    const lowerNewer = record({ deploymentVersion: 99, serverVersion: '1.99.99' });
    const legacy = record({ deploymentVersion: 100 });

    expect(defaultActiveRecord([legacy, lowerNewer, v2Old, v2New], REF)).toBe(v2New);
    expect([v2Old, lowerNewer, v2New].sort(compareDeployRecordVersionDescending)).toEqual([
      v2New,
      v2Old,
      lowerNewer,
    ]);
  });

  it('falls back to active legacy records and returns undefined for no matches', () => {
    const inactiveVersioned = record({
      active: false,
      deploymentVersion: 99,
      serverVersion: '3',
    });
    const legacy = record({ deploymentVersion: 2 });
    expect(defaultActiveRecord([inactiveVersioned, legacy], REF)).toBe(legacy);
    expect(defaultActiveRecord([record({ appSlug: 'other' })], REF)).toBeUndefined();
    expect(defaultActiveRecord([], REF)).toBeUndefined();
  });
});
