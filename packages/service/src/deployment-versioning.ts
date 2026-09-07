import { compareServerVersions } from '@noodle-borg/module';

export interface DeploymentVersionRecord {
  readonly orgSlug: string;
  readonly appSlug: string;
  readonly environment: string;
  readonly active: boolean;
  readonly deploymentVersion: number;
  readonly serverVersion?: string;
  /** Soft-delete stamp (ADR 0117). An archived record never resolves as an active deployment. */
  readonly archivedAt?: string;
}

export interface TenantVersionRef {
  readonly org: string;
  readonly app: string;
  readonly env: string;
}

export function sameTenantRecord(
  record: Pick<DeploymentVersionRecord, 'orgSlug' | 'appSlug' | 'environment'>,
  tenant: TenantVersionRef | Pick<DeploymentVersionRecord, 'orgSlug' | 'appSlug' | 'environment'>,
): boolean {
  if ('org' in tenant) {
    return (
      record.orgSlug === tenant.org &&
      record.appSlug === tenant.app &&
      record.environment === tenant.env
    );
  }
  return (
    record.orgSlug === tenant.orgSlug &&
    record.appSlug === tenant.appSlug &&
    record.environment === tenant.environment
  );
}

export function sameDeploymentScope(
  a: DeploymentVersionRecord,
  b: DeploymentVersionRecord,
): boolean {
  return sameTenantRecord(a, b) && a.serverVersion === b.serverVersion;
}

export function defaultActiveRecord<T extends DeploymentVersionRecord>(
  records: readonly T[],
  ref: TenantVersionRef,
): T | undefined {
  const active = records.filter(
    (record) => record.active && record.archivedAt === undefined && sameTenantRecord(record, ref),
  );
  const versioned = active
    .filter((record) => record.serverVersion !== undefined)
    .sort(compareDeployRecordVersionDescending);
  return (
    versioned[0] ??
    active
      .filter((record) => record.serverVersion === undefined)
      .sort((a, b) => b.deploymentVersion - a.deploymentVersion)[0]
  );
}

export function compareDeployRecordVersionDescending<T extends DeploymentVersionRecord>(
  a: T,
  b: T,
): number {
  const byVersion = compareServerVersions(b.serverVersion as string, a.serverVersion as string);
  return byVersion !== 0 ? byVersion : b.deploymentVersion - a.deploymentVersion;
}
