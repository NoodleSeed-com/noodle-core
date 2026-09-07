import type { AppPackageArtifactV1 } from '@noodle-borg/app-package';
import type { CapabilityName } from '@noodle-borg/capabilities';
import { normalizeServerVersion } from '@noodle-borg/module';
import type { ServedArtifact } from '@noodle-borg/protocol';
import type { AppPackageSnapshotV1 } from './app-package-snapshot.js';
import type { RegistryCompileResult } from './registry-compile.js';
import {
  deployAccessRequiresActor,
  deployerRequiredError,
  deploymentOwnerSubject,
  emptyMembershipSourcesError,
  membershipSourcesRequireOrgMembersError,
  missingCapabilityErrors,
  serverAuthRequiredError,
} from './registry-helpers.js';
import { idempotentDeploymentId, mintDeploymentId } from './registry-targets.js';
import type { DeployError, DeployOptions, RunDeployResult } from './registry-types.js';
import type { ArtifactStore, DeployRecord, TenantRef } from './store.js';

export async function preflightRegistryDeploy(input: {
  readonly options: DeployOptions;
  readonly serviceCapabilities: readonly CapabilityName[];
  readonly compile: () => Promise<RegistryCompileResult>;
}): Promise<
  | {
      readonly ok: true;
      readonly serverName: string;
      readonly bindDeployment: (deploymentId: string) => ServedArtifact;
      readonly appPackageArtifact?: AppPackageArtifactV1;
      readonly appPackageSnapshot?: AppPackageSnapshotV1;
    }
  | { readonly ok: false; readonly errors: readonly DeployError[] }
> {
  const { actor, accessMode, orgMembershipSources } = input.options;
  if (input.options.serverVersion !== undefined) {
    normalizeServerVersion(input.options.serverVersion);
  }
  if (accessMode !== undefined && deployAccessRequiresActor(accessMode) && actor === undefined) {
    return deployerRequiredError(accessMode);
  }
  const built = await input.compile();
  const errors: DeployError[] = built.ok ? [] : [...built.errors];
  const artifact = built.ok ? built.served.artifact : built.compiledArtifact;
  if (artifact !== undefined) {
    errors.push(
      ...missingCapabilityErrors(
        artifact.requirements?.capabilities ?? [],
        input.serviceCapabilities,
      ),
    );
    if (accessMode === 'customers' && artifact.server.auth === undefined) {
      errors.push(...serverAuthRequiredError().errors);
    }
  }
  if (orgMembershipSources !== undefined) {
    if (orgMembershipSources.length === 0) errors.push(...emptyMembershipSourcesError().errors);
    if (accessMode !== 'org-members') {
      errors.push(...membershipSourcesRequireOrgMembersError().errors);
    }
  }
  // Only diagnostics cross the registry/API boundary; failed compilation cannot publish metadata.
  if (!built.ok || errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    serverName: built.served.artifact.server.name,
    bindDeployment: built.bindDeployment,
    ...(built.appPackageArtifact !== undefined
      ? { appPackageArtifact: built.appPackageArtifact }
      : {}),
    ...(built.appPackageSnapshot !== undefined
      ? { appPackageSnapshot: built.appPackageSnapshot }
      : {}),
  };
}

export async function resolveDeployAttempt(input: {
  readonly serverName: string;
  readonly idempotencyKey?: string;
  readonly store?: Pick<ArtifactStore, 'get'>;
  readonly records: ReadonlyMap<string, DeployRecord>;
  readonly tenant: TenantRef;
  readonly manifest: string;
  readonly options: DeployOptions;
}): Promise<{ readonly deploymentId: string; readonly replay?: RunDeployResult }> {
  const deploymentId =
    input.idempotencyKey === undefined
      ? mintDeploymentId(input.serverName)
      : idempotentDeploymentId(input.serverName, input.idempotencyKey);
  if (input.idempotencyKey === undefined) return { deploymentId };
  const existing = (await input.store?.get(deploymentId)) ?? input.records.get(deploymentId);
  if (existing === undefined) return { deploymentId };
  if (!sameIdempotentDeploy(existing, input.tenant, input.manifest, input.options)) {
    return {
      deploymentId,
      replay: {
        ok: false,
        conflict: true,
        code: 'idempotency_conflict',
        message: 'the deploy retry key is already bound to a different deployment',
      },
    };
  }
  const ownerSubject = deploymentOwnerSubject(existing);
  return {
    deploymentId,
    replay: {
      ok: true,
      deploymentId: existing.deploymentId,
      deploymentVersion: existing.deploymentVersion,
      ...(existing.serverVersion !== undefined ? { serverVersion: existing.serverVersion } : {}),
      ...(existing.accessMode !== undefined ? { accessMode: existing.accessMode } : {}),
      ...(ownerSubject !== undefined ? { ownerSubject } : {}),
      replayed: true,
    },
  };
}

function sameIdempotentDeploy(
  record: DeployRecord,
  tenant: TenantRef,
  manifest: string,
  options: DeployOptions,
): boolean {
  const serverVersion =
    options.serverVersion === undefined ? undefined : normalizeServerVersion(options.serverVersion);
  return (
    record.active &&
    record.archivedAt === undefined &&
    record.orgSlug === tenant.org &&
    record.appSlug === tenant.app &&
    record.environment === tenant.env &&
    record.serverVersion === serverVersion &&
    record.manifest === manifest &&
    record.connectors === options.connectors &&
    record.accessMode === options.accessMode &&
    record.deploymentSource === options.deploymentSource &&
    sameJson(record.hostedAssets, options.hostedAssets) &&
    sameJson(record.orgMembershipSources, options.orgMembershipSources) &&
    (options.accessMode !== 'owner-only' ||
      deploymentOwnerSubject(record) === (options.ownerSubject ?? options.actor?.subject))
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
