import type { AppPackageArtifactV1 } from '@noodle-borg/app-package';
import type { CapabilityName } from '@noodle-borg/capabilities';
import { type AccessMode, normalizeServerVersion } from '@noodle-borg/module';
import type { ServedArtifact } from '@noodle-borg/protocol';
import type { AppPackageSnapshotV1 } from './app-package-snapshot.js';
import { deploymentAuthenticationFor } from './deployment-authentication.js';
import { deploymentRecordVersionError } from './deployment-record-version.js';
import { sameTenantRecord } from './deployment-versioning.js';
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
import { activeRecordVersion, type RegistryStateView } from './registry-state.js';
import {
  emptySecretEnvelope,
  idempotentDeploymentId,
  mintDeploymentId,
} from './registry-targets.js';
import type { DeployError, DeployOptions, RunDeployResult } from './registry-types.js';
import type {
  ArtifactStore,
  ConfigStore,
  DeployRecord,
  TenantAuthConfig,
  TenantRef,
} from './store.js';

/** Serialize candidate validation/activation with hierarchical configuration writers. */
export async function withDeploymentConfiguration<T extends { readonly ok: boolean }>(
  config: ConfigStore,
  org: string,
  work: () => Promise<T>,
): Promise<T> {
  if (!config.transactConfig) return work();
  let result: T | undefined;
  try {
    return await config.transactConfig(org, async () => {
      result = await work();
      return result;
    });
  } catch (error) {
    // A nested activation rejection has rolled back; preserve its already mapped public diagnostic.
    if (result?.ok === false) return result;
    throw error;
  }
}

/** Validate the exact destination scope before compilation or publication side effects. */
export async function deploymentWriteVersionError(
  state: RegistryStateView,
  tenant: TenantRef,
  serverVersion: string | undefined,
): Promise<DeployError | undefined> {
  const active = await activeDeploymentWriteScope(state, tenant, serverVersion);
  return active === undefined ? undefined : deploymentRecordVersionError(active);
}

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
    if (accessMode === 'mixed' && artifact.server.auth !== undefined && actor === undefined) {
      errors.push(...deployerRequiredError(accessMode).errors);
    }
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
  const versionError = deploymentRecordVersionError(existing);
  if (versionError !== undefined) {
    return { deploymentId, replay: { ok: false, errors: [versionError] } };
  }
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
  return {
    deploymentId,
    replay: { ...deployedRecordResult(existing), replayed: true },
  };
}

/** Deploy and retry responses report the committed operator policy, never the requested intent. */
export function deployedRecordResult(record: DeployRecord) {
  const ownerSubject = deploymentOwnerSubject(record);
  const authentication = deploymentAuthenticationFor(record);
  return {
    ok: true as const,
    deploymentId: record.deploymentId,
    deploymentVersion: record.deploymentVersion,
    ...(record.serverVersion !== undefined ? { serverVersion: record.serverVersion } : {}),
    ...(record.accessMode !== undefined ? { accessMode: record.accessMode } : {}),
    ...(authentication !== undefined ? { authentication } : {}),
    ...(ownerSubject !== undefined ? { ownerSubject } : {}),
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
    (record.schemaVersion === 2 ||
      (record.accessMode === options.accessMode &&
        (options.accessMode !== 'owner-only' ||
          deploymentOwnerSubject(record) === (options.ownerSubject ?? options.actor?.subject)))) &&
    record.deploymentSource === options.deploymentSource &&
    sameJson(record.hostedAssets, options.hostedAssets) &&
    sameJson(record.orgMembershipSources, options.orgMembershipSources)
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Writes target one exact scope; default routing deliberately prefers a versioned deployment. */
async function activeDeploymentWriteScope(
  state: RegistryStateView,
  tenant: TenantRef,
  serverVersion: string | undefined,
): Promise<DeployRecord | undefined> {
  if (serverVersion !== undefined) return activeRecordVersion(state, tenant, serverVersion);
  // The existing store port has no unversioned point lookup. Read durable records, never a worker cache.
  const records = state.store ? await state.store.loadAll() : [...state.records.values()];
  return records
    .filter(
      (record) =>
        record.active &&
        record.archivedAt === undefined &&
        record.serverVersion === undefined &&
        sameTenantRecord(record, tenant),
    )
    .sort((a, b) => b.deploymentVersion - a.deploymentVersion)[0];
}

/** Existing dormant mixed declarations require an explicit operator adoption. */
function mixedCustomerActivationError(
  previous: DeployRecord | undefined,
  previousAuth: TenantAuthConfig | undefined,
  accessMode: AccessMode | undefined,
  auth: TenantAuthConfig | undefined,
): DeployError | undefined {
  return previous?.schemaVersion === 1 &&
    previous.accessMode === 'mixed' &&
    previousAuth !== undefined &&
    accessMode === 'mixed' &&
    auth !== undefined
    ? {
        code: 'customer_auth_activation_required',
        path: 'accessMode',
        message:
          'Activate customer authentication with noodle access set mixed before redeploying this existing mixed deployment.',
      }
    : undefined;
}

/** Bind replacement policy to the observed active revision before the atomic store write. */
export async function replacementDeploymentPolicy(
  state: RegistryStateView,
  tenant: TenantRef,
  serverVersion: string | undefined,
  accessMode: AccessMode | undefined,
  auth: TenantAuthConfig | undefined,
  compile: (record: DeployRecord) => Promise<RegistryCompileResult>,
) {
  const previous = await activeDeploymentWriteScope(state, tenant, serverVersion);
  const previousBuilt = previous === undefined ? undefined : await compile(previous);
  return {
    previous,
    schemaVersion:
      previous?.schemaVersion === 2 || (accessMode === 'mixed' && auth !== undefined) ? 2 : 1,
    error: mixedCustomerActivationError(
      previous,
      previousBuilt?.ok ? previousBuilt.served.artifact.server.auth : previous?.serverAuth,
      accessMode,
      auth,
    ),
  };
}

/** Construct one immutable deployment candidate from compiled source and resolved operator policy. */
export function createRegistryDeployRecord(input: {
  readonly safeTenant: TenantRef;
  readonly safeServerVersion: string | undefined;
  readonly deploymentId: string;
  readonly version: number;
  readonly built: ServedArtifact;
  readonly manifest: string;
  readonly options: DeployOptions;
  readonly schemaVersion: number;
  readonly appPackageSnapshot: AppPackageSnapshotV1 | undefined;
}): DeployRecord {
  const {
    safeTenant,
    safeServerVersion,
    deploymentId,
    version,
    built,
    manifest,
    options,
    schemaVersion,
    appPackageSnapshot,
  } = input;
  const {
    actor,
    accessMode,
    automationId,
    deploymentSource,
    orgMembershipSources,
    connectors,
    hostedAssets,
  } = options;
  const serverAuth = built.artifact.server.auth;
  const ownerSubject =
    accessMode === 'owner-only' ? (options.ownerSubject ?? actor?.subject) : undefined;
  const record: DeployRecord = {
    schemaVersion,
    deploymentId,
    orgSlug: safeTenant.org,
    appSlug: safeTenant.app,
    environment: safeTenant.env,
    ...(safeServerVersion !== undefined ? { serverVersion: safeServerVersion } : {}),
    deploymentVersion: version,
    active: automationId === undefined,
    serverName: built.artifact.server.name,
    createdAt: new Date().toISOString(),
    ...(actor ? { createdBySubject: actor.subject, createdByEmail: actor.email } : {}),
    ...(ownerSubject !== undefined ? { ownerSubject } : {}),
    ...(deploymentSource !== undefined ? { deploymentSource } : {}),
    ...(accessMode !== undefined ? { accessMode } : {}),
    ...(orgMembershipSources !== undefined ? { orgMembershipSources } : {}),
    ...(serverAuth !== undefined ? { serverAuth } : {}),
    manifest,
    ...(connectors !== undefined ? { connectors } : {}),
    ...(hostedAssets !== undefined && hostedAssets.length > 0 ? { hostedAssets } : {}),
    ...(appPackageSnapshot !== undefined ? { appPackageSnapshot } : {}),
    secrets: emptySecretEnvelope(),
  };
  return record;
}
