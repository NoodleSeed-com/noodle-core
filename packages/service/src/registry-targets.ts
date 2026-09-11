import { createHash, randomUUID } from 'node:crypto';
import { RECORD_CONNECTOR_ID } from '@noodle-borg/compiler';
import type { ServedArtifact } from '@noodle-borg/protocol';
import type {
  OwnerTokenVerifier,
  ServedTarget,
  TargetAuthentication,
  TenantRouteRef,
} from '@noodle-borg/transport-http';
import { parseAppPackageSnapshot } from './app-package-snapshot.js';
import {
  hasExactCustomerAuthProjection,
  requiresCustomerAuthProjection,
} from './customer-auth-audience-binding.js';
import { deploymentRecordVersionError } from './deployment-record-version.js';
import type { NativeRecordConnectorFactory } from './native-record-connector.js';
import type { ServerRegistry } from './registry.js';
import { deploymentOwnerSubject } from './registry-helpers.js';
import type { RegistryStateView } from './registry-state.js';
import type { DeployRecord, SecretEnvelope, TenantAuthConfig, TenantRef } from './store.js';
import { validateTenantRef } from './store.js';

const targetPolicyVersions = new WeakMap<ServedTarget, number>();

/** Replace only the platform record port; unrelated compiled runtime ports retain their authority. */
export function rebindNativeRecords(
  target: ServedTarget,
  record: DeployRecord,
  factory: NativeRecordConnectorFactory | undefined,
): ServedTarget {
  const native = factory?.({
    tenant: recordTenant(record),
    artifact: target.served.artifact,
    deploymentId: record.deploymentId,
  });
  const previous = target.served.deps.connectors;
  return rememberTargetPolicy(record, {
    ...target,
    served: {
      ...target.served,
      deps: {
        ...target.served.deps,
        connectors: {
          resolve: (ref) =>
            ref.connectorId === RECORD_CONNECTOR_ID
              ? native?.version === ref.connectorVersion
                ? native
                : undefined
              : previous.resolve(ref),
        },
      },
    },
  });
}

/**
 * Build the front-door {@link ServedTarget} for a persisted record: its access mode plus the credential the
 * front-door checks. Legacy alpha records without an identity access mode are not served.
 */
export function servedTargetFor(
  record: DeployRecord,
  served: ServedArtifact,
  customerVerifierFactory?: (auth: TenantAuthConfig) => OwnerTokenVerifier,
): ServedTarget {
  const versionError = deploymentRecordVersionError(record);
  if (versionError !== undefined) throw new Error(versionError.code);
  const accessMode = record.accessMode;
  if (accessMode === undefined) {
    throw new Error(`deployment ${record.deploymentId} has unsupported legacy access mode`);
  }
  const customerOwned = requiresCustomerAuthProjection(record, served.artifact.server.auth);
  const customerAuth = customerOwned ? served.artifact.server.auth : undefined;
  if (customerOwned && customerAuth === undefined) {
    throw new MissingCustomerAuthError(record.deploymentId);
  }
  if (!hasExactCustomerAuthProjection(record, customerAuth)) {
    throw new MissingCustomerAuthError(record.deploymentId);
  }
  const boundServed = bindAppPackageSnapshot(served, record.appPackageSnapshot);
  const ownerSubject = deploymentOwnerSubject(record);
  return rememberTargetPolicy(record, {
    served: boundServed,
    deploymentId: record.deploymentId,
    accessMode,
    org: record.orgSlug,
    app: record.appSlug,
    environment: record.environment,
    ...(accessMode === 'org-members' && record.orgMembershipSources !== undefined
      ? { orgMembershipSources: record.orgMembershipSources }
      : {}),
    ...(accessMode === 'owner-only' && ownerSubject !== undefined ? { ownerSubject } : {}),
    authentication:
      customerAuth !== undefined
        ? customerTargetFields(customerAuth, customerVerifierFactory)
        : { kind: 'platform' },
  });
}

class MissingCustomerAuthError extends Error {
  constructor(readonly deploymentId: string) {
    super('customers access mode requires server.auth');
    this.name = 'MissingCustomerAuthError';
  }
}

export function tryServedTargetFor(
  record: DeployRecord,
  served: ServedArtifact,
  customerVerifierFactory?: (auth: TenantAuthConfig) => OwnerTokenVerifier,
): ServedTarget | undefined {
  try {
    return servedTargetFor(record, served, customerVerifierFactory);
  } catch (error) {
    if (error instanceof MissingCustomerAuthError) return undefined;
    throw error;
  }
}

function servedTargetMatchesRecord(target: ServedTarget, record: DeployRecord): boolean {
  const expectedOwner =
    record.accessMode === 'owner-only' ? deploymentOwnerSubject(record) : undefined;
  const expectedMembership =
    record.accessMode === 'org-members' ? record.orgMembershipSources : undefined;
  return (
    target.deploymentId === record.deploymentId &&
    target.accessMode === record.accessMode &&
    target.authentication?.kind ===
      (requiresCustomerAuthProjection(record, target.served.artifact.server.auth)
        ? 'customer'
        : 'platform') &&
    target.org === record.orgSlug &&
    target.app === record.appSlug &&
    target.environment === record.environment &&
    target.ownerSubject === expectedOwner &&
    sameStrings(target.orgMembershipSources, expectedMembership) &&
    target.served.appPackageSnapshot?.snapshotSha256 === record.appPackageSnapshot?.snapshotSha256
  );
}

function bindAppPackageSnapshot(served: ServedArtifact, value: unknown): ServedArtifact {
  const { appPackageSnapshot: _stale, ...runtime } = served;
  const snapshot = parseAppPackageSnapshot(value);
  return snapshot === undefined ? runtime : { ...runtime, appPackageSnapshot: snapshot };
}

/** Reconcile one persisted record with its cached served target without trusting stale auth projections. */
export async function targetForPersistedRecord(
  record: DeployRecord,
  state: {
    readonly records: Map<string, DeployRecord>;
    readonly servers: Map<string, ServedTarget>;
    readonly customerVerifierFactory?: (auth: TenantAuthConfig) => OwnerTokenVerifier;
    readonly hasCustomerAuthConflict: (
      record: DeployRecord,
      auth: TenantAuthConfig | undefined,
    ) => Promise<boolean>;
    readonly load?: () => Promise<ServedTarget | undefined>;
  },
): Promise<ServedTarget | undefined> {
  const cached = state.servers.get(record.deploymentId);
  const cachedSchemaVersion = cached === undefined ? undefined : targetPolicyVersions.get(cached);
  state.records.set(record.deploymentId, record);
  if (deploymentRecordVersionError(record) !== undefined) {
    state.servers.delete(record.deploymentId);
    return undefined;
  }
  if (cached === undefined) return state.load?.();
  if (!hasExactCustomerAuthProjection(record, cached.served.artifact.server.auth)) {
    state.servers.delete(record.deploymentId);
    return undefined;
  }
  if (
    record.active &&
    (await state.hasCustomerAuthConflict(record, cached.served.artifact.server.auth))
  ) {
    return undefined;
  }
  if (cachedSchemaVersion === record.schemaVersion && servedTargetMatchesRecord(cached, record))
    return cached;
  const reconciled = servedTargetFor(record, cached.served, state.customerVerifierFactory);
  state.servers.set(record.deploymentId, reconciled);
  return reconciled;
}

function sameStrings(left?: readonly string[], right?: readonly string[]): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.length === right.length &&
      left.every((value, index) => value === right[index]))
  );
}

function customerTargetFields(
  auth: TenantAuthConfig,
  customerVerifierFactory?: (auth: TenantAuthConfig) => OwnerTokenVerifier,
): TargetAuthentication {
  return {
    kind: 'customer',
    ...(auth.kind === 'bridge'
      ? {}
      : {
          authorizationServers:
            auth.kind === 'federatedOidc'
              ? auth.issuers.map((issuer) => issuer.issuer)
              : [auth.issuer],
        }),
    ...(customerVerifierFactory === undefined
      ? {}
      : { verifyToken: customerVerifierFactory(auth) }),
  };
}

export async function authorizationMetadataForTenant(
  registry: ServerRegistry,
  tenant: TenantRouteRef,
): Promise<
  | {
      readonly authorizationServers?: readonly string[];
      readonly requiredScopes: readonly string[];
    }
  | undefined
> {
  const target =
    tenant.serverVersion === undefined
      ? await registry.getActiveByTenant(tenant)
      : await registry.getActiveByTenantVersion(tenant, tenant.serverVersion);
  if (target === undefined) return undefined;
  const authorizationServers =
    target.authentication?.kind === 'customer'
      ? target.authentication.authorizationServers
      : undefined;
  const requiredScopes = [
    ...new Set(
      target.served.artifact.tools.flatMap((tool) => tool.authorization?.requiredScopes ?? []),
    ),
  ].sort();
  return {
    ...(authorizationServers === undefined ? {} : { authorizationServers }),
    requiredScopes,
  };
}

export function recordTenant(record: DeployRecord): TenantRef {
  return { org: record.orgSlug, app: record.appSlug, env: record.environment };
}

export function recordMatchesTenant(record: DeployRecord, ref: TenantRef): boolean {
  return record.orgSlug === ref.org && record.appSlug === ref.app && record.environment === ref.env;
}

export function emptySecretEnvelope(): SecretEnvelope {
  return { enc: 'none', values: {} };
}

export function tenantKey(ref: TenantRef): string {
  return `${ref.org}/${ref.app}/${ref.env}`;
}

export function tenantDeploymentKey(ref: TenantRef, serverVersion?: string): string {
  return serverVersion === undefined ? tenantKey(ref) : `${tenantKey(ref)}@${serverVersion}`;
}

/** Build a URL-safe, human-readable id from the manifest's server name plus a short random suffix. */
export function mintDeploymentId(name: string): string {
  return `${deploymentSlug(name)}-${randomUUID().slice(0, 8)}`;
}

/** Stable name-bearing id for a service-validated retry key; no request content is retained in it. */
export function idempotentDeploymentId(name: string, key: string): string {
  return `${deploymentSlug(name)}-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
}

function deploymentSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'server'
  );
}

/** Immutable source projection shared by registry installation consumers. */
export async function deploymentSourceFor(
  state: RegistryStateView,
  tenant: TenantRef,
  deploymentId: string,
) {
  const safeTenant = validateTenantRef(tenant);
  const record = state.store
    ? await state.store.get(deploymentId)
    : state.records.get(deploymentId);
  if (
    record === undefined ||
    record.archivedAt !== undefined ||
    record.orgSlug !== safeTenant.org ||
    record.appSlug !== safeTenant.app ||
    record.environment !== safeTenant.env
  )
    return undefined;
  return {
    manifest: record.manifest,
    ...(record.connectors === undefined ? {} : { connectors: record.connectors }),
    ...(record.hostedAssets === undefined
      ? {}
      : { hostedAssets: structuredClone(record.hostedAssets) }),
    ...(record.accessMode === undefined ? {} : { accessMode: record.accessMode }),
    ...(record.serverVersion === undefined ? {} : { serverVersion: record.serverVersion }),
  };
}

function rememberTargetPolicy(record: DeployRecord, target: ServedTarget): ServedTarget {
  targetPolicyVersions.set(target, record.schemaVersion);
  return target;
}
