import type { ArtifactCustomerAuthRouting, HostedPackagedAsset } from '@noodle-borg/compiler';
import type { OrganizationStore } from '@noodle-borg/control-plane/portable';
import type { OrgMembershipSource } from '@noodle-borg/module';
import type { SealedSecret } from '@noodle-borg/runtime';
import type { AccessMode } from '@noodle-borg/transport-http';
import type { DeploymentAuthentication, DeploymentSource } from '@noodle-borg/wire-contracts';
import type { AppPackageSnapshotV1 } from './app-package-snapshot.js';
import type { ProductionEnvironmentChange } from './store/environment-production.js';

export type {
  ActiveMcpSubdomainClaim,
  ChangeMcpSubdomainInput,
  CreateOrgWithOwnerInput,
  McpSubdomainMutationResult,
  McpSubdomainSetting,
  OrgDomainRecord,
  OrgInvitationRecord,
  OrgMemberRecord,
  OrgOpenAIAppsChallengeRecord,
  OrgRecord,
  OrgRole,
  PersonalWorkspaceProvisionInput,
  PersonalWorkspaceProvisionResult,
  SignupAllowlistKind,
  SignupAllowlistRecord,
  WelcomeEmailRecord,
} from '@noodle-borg/control-plane/portable';
export {
  type ConfigScope,
  type ConfigStore,
  type ConfigValueInput,
  type ConfigValueMetadata,
  InMemoryConfigStore,
  type ManagedConfigKind,
  resolveConfigScope,
  scopeChain,
} from './store/config-values.js';
export type { ProductionEnvironmentChange } from './store/environment-production.js';
// Store building blocks extracted by concern (size gate): validators, the in-memory and JSON-file
// backends, and the shared record helpers. Re-exported here so `./store.js` stays the single import
// surface.
export { InMemoryArtifactStore } from './store/in-memory.js';
export { JsonFileArtifactStore } from './store/json-file.js';
export {
  CONFIG_NAME_PATTERN,
  DEPLOYMENT_ID_PATTERN,
  DOMAIN_PATTERN,
  SLUG_PATTERN,
  validateConfigName,
  validateConfigScope,
  validateDomain,
  validateOrgMembershipDomain,
  validateOrgRole,
  validatePositiveInteger,
  validateSignupAllowlistKind,
  validateSlug,
  validateTenantRef,
} from './store/validate.js';

/**
 * Secret values at rest. The compiled runtime keeps plaintext tokens in memory (the broker), but the
 * *persisted* form is a tagged envelope. `aes-256-gcm` (Slice 26, ADR 0028) holds an AES-256-GCM
 * {@link SealedSecret} — the production form whenever persistence is enabled. `none` is the interim
 * plaintext form (Slice 25): still read for backward compatibility and used by non-persistent in-memory
 * stores, but a file-backed data dir always encrypts (the service fails closed without a master key).
 */
export type SecretEnvelope =
  | { readonly enc: 'none'; readonly values: Readonly<Record<string, string>> }
  | { readonly enc: 'aes-256-gcm'; readonly sealed: SealedSecret };

/**
 * The durable record for one deployed server. The compiled artifact is **not** stored — its execution
 * deps (connector registry, broker) are live JS closures and are not serializable — so restart recovery
 * **replays** {@link ServerRegistry.deploy} from these inputs. `deploy` is a pure, deterministic compile
 * of the source strings, so the inputs + identity are a faithful, reproducible record.
 */
export interface DeployRecord {
  /** Record format version; customer mixed adoption writes 2, which remains sticky on new records. */
  readonly schemaVersion: number;
  readonly deploymentId: string;
  readonly orgSlug: string;
  readonly appSlug: string;
  readonly environment: string;
  readonly serverVersion?: string;
  readonly deploymentVersion: number;
  readonly active: boolean;
  readonly serverName: string;
  /** ISO-8601 deploy timestamp. */
  readonly createdAt: string;
  readonly createdBySubject?: string;
  readonly createdByEmail?: string;
  /** OAuth subject authorized by owner-only access; absent legacy records fall back to the creator. */
  readonly ownerSubject?: string;
  /** Informational deploy origin. Absent on records written before source tracking. */
  readonly deploymentSource?: DeploymentSource;
  /**
   * How callers authenticate to this deployment's MCP endpoint. Identity modes require verified end-user
   * identity. Absent records are legacy alpha data and are not served as active identity deployments.
   */
  readonly accessMode?: AccessMode;
  /**
   * For `org-members`: which membership sources admit callers. Absent means every source. `[]` is a
   * deny-all state that only arises from an unrecognised persisted list, never from a deploy (ADR 0183).
   */
  readonly orgMembershipSources?: readonly OrgMembershipSource[];
  readonly serverAuth?: TenantAuthConfig;
  readonly manifest: string;
  readonly connectors?: string;
  readonly hostedAssets?: readonly HostedPackagedAsset[];
  readonly secrets: SecretEnvelope;
  /**
   * App soft-delete stamp (ADR 0117): ISO-8601 time the whole app was archived. Archived records are
   * never served or listed by default, and the sweeper hard-deletes them after the retention window.
   */
  readonly archivedAt?: string;
  /** Owner-applied freeze for this exact active server-version pointer. */
  readonly deploymentLock?: DeploymentLock;
  /** Immutable rendered package bytes bound to this exact deployment, when the manifest has a guide. */
  readonly appPackageSnapshot?: AppPackageSnapshotV1;
}

export interface DeploymentLockMetadata {
  /** ISO-8601 time the version pointer was locked. */
  readonly lockedAt: string;
  readonly lockedByEmail?: string;
}

export interface DeploymentLock extends DeploymentLockMetadata {
  /** Internal actor identity retained for audit evidence. */
  readonly lockedBySubject: string;
}

export interface TenantOidcAuthConfig {
  readonly kind?: 'oidc' | undefined;
  readonly issuer: string;
  readonly audience: string;
  readonly claims?: TenantAuthClaimMap | undefined;
  readonly routing?: ArtifactCustomerAuthRouting | undefined;
}

interface TenantFederatedOidcAuthConfig {
  readonly kind: 'federatedOidc';
  readonly issuers: readonly {
    readonly issuer: string;
    readonly audience: string;
    readonly claims?: TenantAuthClaimMap | undefined;
    readonly routing?: ArtifactCustomerAuthRouting | undefined;
  }[];
}

export interface TenantBridgeAuthConfig {
  readonly kind: 'bridge';
  readonly provider: string;
  readonly verifyUrl?: string | undefined;
  readonly authorizeUrl?: string | undefined;
  readonly projectId?: string | undefined;
  readonly apiKey?: string | undefined;
  readonly authDomain?: string | undefined;
  readonly appId?: string | undefined;
  readonly tenantId?: string | undefined;
  readonly audience?: string | undefined;
  readonly clientId?: string | undefined;
  readonly clientSecret?: string | undefined;
  readonly tokenUrl?: string | undefined;
  readonly scopes?: readonly string[] | undefined;
  readonly authMethod?: 'client_secret_basic' | 'client_secret_post' | undefined;
  readonly user?: TenantAuthClaimMap | undefined;
}

export type TenantAuthConfig =
  | TenantOidcAuthConfig
  | TenantFederatedOidcAuthConfig
  | TenantBridgeAuthConfig;

export interface TenantAuthClaimMap {
  readonly id?: string | undefined;
  readonly email?: string | undefined;
  readonly name?: string | undefined;
  readonly tenant?: string | undefined;
  readonly orgs?: string | undefined;
  readonly roles?: string | undefined;
  readonly scopes?: string | undefined;
}

export interface TenantRef {
  readonly org: string;
  readonly app: string;
  readonly env: string;
}

export interface DeploymentSummary {
  readonly deploymentId: string;
  readonly orgSlug: string;
  readonly appSlug: string;
  readonly environment: string;
  readonly serverVersion?: string;
  readonly active: boolean;
  readonly serverName: string;
  readonly createdAt: string;
  readonly createdByEmail?: string;
  readonly ownerSubject?: string;
  readonly deploymentSource?: DeploymentSource;
  readonly accessMode: AccessMode;
  readonly deploymentLock?: DeploymentLockMetadata;
  /** Present iff the record is archived (ADR 0117); surfaced only on `includeArchived` listings. */
  readonly archivedAt?: string;
  /** Tenant MCP endpoint for this record; stamped by the routes from the request base, never stored. */
  readonly endpointUrl?: string;
}

/**
 * One app's aggregated summary across every environment (the `apps` resource, ADR: apps-as-a-resource).
 * `latest` is the *facing* deployment — the active record with the newest `createdAt` across every env,
 * or (with nothing active) simply the newest record overall; `undefined` only for an app that exists as
 * an empty anchor (a Postgres `apps` row with zero deploy records — never the in-memory/json-file stores).
 */
export interface AppSummary {
  readonly orgSlug: string;
  readonly appSlug: string;
  /** Distinct env names for the app, ranked prod, staging, dev, then alphabetically. */
  readonly environments: readonly string[];
  readonly latest?: DeploymentSummary;
  readonly accessMode?: string;
  /** `latest?.active ?? false`. */
  readonly active: boolean;
  /** Present iff the facing deployment is archived (every record for an archived app is stamped). */
  readonly archivedAt?: string;
  /** Earliest activity: the earliest deploy `createdAt`, or the anchor's `createdAt` with no records. */
  readonly createdAt: string;
  /** Latest deploy `createdAt`; absent for an empty-anchor app (no deploy activity at all). */
  readonly lastActivityAt?: string;
}

/**
 * One environment's summary within an app (the `envs` resource). `latest` is the *facing* deployment
 * for **this** environment specifically (unlike {@link AppSummary.latest}, which faces across every
 * env) — the active record with the newest `createdAt` in this env, or (with nothing active) simply
 * the newest record in this env; `undefined` only for an env that exists as an empty anchor (a
 * Postgres `environments` row with zero deploy records — never the in-memory/json-file stores).
 */
export interface EnvSummary {
  readonly orgSlug: string;
  readonly appSlug: string;
  readonly envName: string;
  /** App-level designation used by analytics and Headless defaults; independent of the env name. */
  readonly isProduction: boolean;
  readonly latest?: DeploymentSummary;
  readonly accessMode?: string;
  /** `latest?.active ?? false`. */
  readonly active: boolean;
  /** Present iff the facing deployment is archived. */
  readonly archivedAt?: string;
  /** Earliest activity: the earliest deploy `createdAt`, or the anchor's `createdAt` with no records. */
  readonly createdAt: string;
  /** Latest deploy `createdAt`; absent for an empty-anchor env (no deploy activity at all). */
  readonly lastActivityAt?: string;
  /** Total records for this env, respecting `includeArchived` (0 for an empty-anchor env). */
  readonly deploymentCount: number;
}

/** Filter for {@link ArtifactStore.listDeployments}. Archived records are excluded unless opted in. */
export interface DeploymentListFilter {
  readonly org: string;
  readonly app?: string;
  readonly env?: string;
  readonly includeArchived?: boolean;
}

/** Outcome of {@link ArtifactStore.archiveApp} (ADR 0117 §5 idempotency semantics). */
export interface AppArchiveResult {
  /** The stamp that governs retention — the original one when the app was already archived. */
  readonly archivedAt: string;
  readonly archivedDeployments: number;
  readonly alreadyArchived: boolean;
}

/** Outcome of {@link ArtifactStore.restoreApp}. `restoredDeployments` is 0 for a no-op restore. */
export interface AppRestoreResult {
  readonly restoredDeployments: number;
}

/** Compiler-authoritative customer auth projection observed before an app restore transaction. */
export interface CustomerAuthRestoreProjection {
  readonly deploymentId: string;
  readonly manifest: string;
  readonly serverAuth: TenantAuthConfig;
}

/** Atomic restore guard for every active customer deployment whose archive stamp will be cleared. */
export interface AppRestorePrecondition {
  readonly customerAuthProjections: readonly CustomerAuthRestoreProjection[];
}

export interface DeploymentStatus {
  readonly target: TenantRef;
  readonly deployment: {
    readonly deploymentId: string;
    readonly endpointUrl: string;
    readonly serverVersion?: string;
    readonly active: boolean;
    readonly serverName: string;
    readonly createdAt: string;
    readonly createdByEmail?: string;
    readonly ownerSubject?: string;
    readonly accessMode: AccessMode;
    readonly authentication?: DeploymentAuthentication;
    readonly deploymentLock?: DeploymentLockMetadata;
  };
  readonly health: {
    readonly state: 'ready' | 'missing-config' | 'unhealthy';
  };
  readonly config: {
    readonly ok: boolean;
    readonly missingSecrets: readonly string[];
  };
}

export interface DeploymentActivationResult {
  readonly active: DeployRecord;
  readonly previousActive?: DeployRecord;
  readonly alreadyActive: boolean;
}

/** One atomic access/owner compare-and-set over the active deployment's observed state. */
export interface DeploymentPolicyPrecondition {
  readonly active: Pick<
    DeployRecord,
    'deploymentId' | 'schemaVersion' | 'accessMode' | 'ownerSubject' | 'manifest' | 'serverAuth'
  > | null;
}

/** The source and authority validated before atomically activating this exact target revision. */
export interface DeploymentActivationPrecondition {
  readonly expectedAccessMode: AccessMode | undefined;
  /** Older callers are restricted to schema-1 targets. */
  readonly expectedSchemaVersion?: number;
  readonly expectedRevision?: Pick<
    DeployRecord,
    | 'manifest'
    | 'connectors'
    | 'hostedAssets'
    | 'serverAuth'
    | 'serverVersion'
    | 'ownerSubject'
    | 'createdBySubject'
    | 'orgMembershipSources'
    | 'archivedAt'
  >;
  readonly expectedActivePolicy?: DeploymentPolicyPrecondition;
  /** Compiler-authoritative projection, applied only after revision validation. */
  readonly serverAuth?: TenantAuthConfig;
}

export interface ActiveAccessUpdateInput {
  /** Internal policy adoption; callers cannot author a deployment schema version. */
  readonly schemaVersion?: 2;
  readonly accessMode: AccessMode;
  /** Desired owner mutation. Omission preserves the current effective owner; clearing is unsupported. */
  readonly ownerSubject?: string;
  readonly expectedAccessMode: AccessMode | undefined;
  /** Older callers omit this and are restricted to version-1 records. */
  readonly expectedSchemaVersion?: number;
  readonly expectedManifest?: string;
  readonly expectedOwnerSubject: string | undefined;
  /** Compiler-authoritative projection persisted atomically when enabling customer access. */
  readonly serverAuth?: TenantAuthConfig;
}

export type DeploymentLockUpdateResult =
  | { readonly ok: true; readonly record: DeployRecord; readonly changed: boolean }
  | { readonly ok: false; readonly reason: 'no_active_deployment' | 'conflict' };

export interface ControlPlaneStore extends OrganizationStore {}

/**
 * Durable storage for deployed-server records. `append` writes (or replaces) one server's immutable deploy
 * inputs while preserving owner state changed through {@link updateActiveAccess}; `loadAll` returns every
 * current record for restart recovery. Historical records are retained so a tenant environment can reactivate
 * an earlier deployment without changing the tenant-facing URL.
 */
export interface ArtifactStore {
  append(record: DeployRecord, precondition?: DeploymentPolicyPrecondition): Promise<void>;
  loadAll(): Promise<readonly DeployRecord[]>;
  /**
   * Fetch one server's record by id, or `undefined` if absent. A point read used by lazy
   * recompile-on-cache-miss ([ADR 0036](../../../docs/decisions/0036-stateless-registry-lazy-recompile.md)),
   * so any instance can serve a server it never deployed. Fail-soft: a corrupt/unreadable record reads as
   * `undefined`, never throws.
   */
  get(deploymentId: string): Promise<DeployRecord | undefined>;
  getActiveByTenant(ref: TenantRef): Promise<DeployRecord | undefined>;
  getActiveByTenantVersion(
    ref: TenantRef,
    serverVersion: string,
  ): Promise<DeployRecord | undefined>;
  /** Atomically lock or unlock the exact currently-active version pointer. */
  setDeploymentLock(
    ref: TenantRef,
    serverVersion: string,
    expectedDeploymentId: string,
    deploymentLock: DeploymentLock | undefined,
  ): Promise<DeploymentLockUpdateResult>;
  /**
   * Return another active app/environment that owns one of `auth`'s customer OIDC issuer/audience
   * bindings. Implementations may optimize this security lookup; registries fall back to `loadAll`.
   */
  findActiveCustomerAuthAudienceConflict?(
    ref: TenantRef,
    auth: TenantAuthConfig,
  ): Promise<TenantRef | undefined>;
  activateDeployment(
    ref: TenantRef,
    deploymentId: string,
    precondition?: DeploymentActivationPrecondition,
    options?: { readonly automationId?: string },
  ): Promise<DeploymentActivationResult | undefined>;
  /**
   * Compare and set the active record's access mode and effective owner. The access precondition is the raw
   * persisted value; the owner precondition resolves legacy records through creator provenance.
   */
  updateActiveAccess(
    ref: TenantRef,
    deploymentId: string,
    input: ActiveAccessUpdateInput,
  ): Promise<DeployRecord | undefined>;
  listDeployments(filter: DeploymentListFilter): Promise<readonly DeploymentSummary[]>;
  /**
   * App soft delete (ADR 0117). `getAppArchivedAt` reports the app's archived stamp (defined iff the
   * app has records and every record is stamped). `archiveApp` stamps every record for the app (all
   * environments/versions); `restoreApp` clears the stamps; both resolve `undefined` for an app with
   * no records. `sweepArchived` hard-deletes a complete app only when every one of its records is archived
   * strictly before `before`, returning every record from each deleted app so the caller can reclaim
   * associated config and emit audit events.
   */
  getAppArchivedAt(org: string, app: string): Promise<string | undefined>;
  archiveApp(org: string, app: string, at: string): Promise<AppArchiveResult | undefined>;
  restoreApp(
    org: string,
    app: string,
    precondition?: AppRestorePrecondition,
  ): Promise<AppRestoreResult | undefined>;
  sweepArchived(before: string): Promise<readonly DeployRecord[]>;
  /**
   * The `apps` resource: one {@link AppSummary} per app in `org`, sorted by last activity desc (see
   * {@link summarizeApps}). Archived apps are excluded unless `includeArchived`. Capped at `limit`
   * (default 200) — `truncated` signals a cap, callers never see records silently dropped.
   */
  listApps(
    org: string,
    opts?: { readonly includeArchived?: boolean; readonly limit?: number },
  ): Promise<{ readonly apps: readonly AppSummary[]; readonly truncated: boolean }>;
  /** One app's {@link AppSummary}; `undefined` when the app has no records and no anchor. */
  getApp(org: string, app: string): Promise<AppSummary | undefined>;
  /** Authoritative app incarnation identity, independent of display summaries. */
  getAppGeneration(org: string, app: string): Promise<string | undefined>;
  /**
   * The `envs` resource: one {@link EnvSummary} per environment for `app`, production first and then
   * alphabetically (see {@link summarizeEnvs}). Archived envs are excluded unless `includeArchived`.
   * No pagination — env counts per app are small.
   */
  listEnvironments(
    org: string,
    app: string,
    opts?: { readonly includeArchived?: boolean },
  ): Promise<readonly EnvSummary[]>;
  /** One env's {@link EnvSummary}; `undefined` when the env has no records and no anchor. */
  getEnvironment(org: string, app: string, env: string): Promise<EnvSummary | undefined>;
  /** Atomically designate an existing environment as production; `undefined` for a missing app/env. */
  setProductionEnvironment(
    org: string,
    app: string,
    env: string,
  ): Promise<ProductionEnvironmentChange | undefined>;
  /**
   * One deployment's {@link DeploymentSummary} by id, scoped to `org` (the deployment item resource,
   * `GET /v1/orgs/{org}/deployments/{deploymentId}`). `undefined` both when the deployment does not
   * exist and when it exists but belongs to a different org — cross-org existence must never leak
   * through this lookup. Archived records ARE returned (with `archivedAt` set): inspecting a
   * deployment's history, including an archived one, is the point of a by-id lookup, so there is no
   * `includeArchived` filter here.
   */
  getDeployment(org: string, deploymentId: string): Promise<DeploymentSummary | undefined>;
}
