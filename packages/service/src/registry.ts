import type { CapabilityName } from '@noodle-borg/capabilities';
import type {
  CatalogConnector,
  HostedPackagedAsset,
  LocalAssetOptions,
  PackagedAsset,
} from '@noodle-borg/compiler';
import type { RollbackResult } from '@noodle-borg/control-plane/portable';
import {
  type KnowledgeDeployHooks,
  KnowledgePublicationError,
  type KnowledgeSearchPortFactory,
  withKnowledgePublication,
} from '@noodle-borg/knowledge-operations/portable';
import type { PlatformIdentityRecoveryPlan } from '@noodle-borg/module';
import {
  DeploymentActivationError,
  type EndpointUrlOptions,
  normalizeServerVersion,
  type PolicyGate,
} from '@noodle-borg/module';
import type { Connector, SecretBox } from '@noodle-borg/runtime';
import type { OwnerTokenVerifier, ServedTarget } from '@noodle-borg/transport-http';
import { normalizePersistedConnectorsForCompile } from './connector-normalize.js';
import {
  CustomerAuthAudienceConflictError,
  customerAuthAudienceConflictFailure,
  hasActiveCustomerAuthAudienceConflict,
} from './customer-auth-audience-binding.js';
import {
  DeploymentLockedError,
  deploymentLockedConflict,
  deploymentLockedPreflight,
} from './deployment-lock.js';
import { defaultActiveRecord } from './deployment-versioning.js';
import type { OAuthStore } from './oauth/store.js';
import { updateRegistryAccess } from './registry-access.js';
import { compileRegistryTarget, type RegistryCompileResult } from './registry-compile.js';
import { preflightRegistryDeploy, resolveDeployAttempt } from './registry-deploy-transaction.js';
import {
  type ActiveDeployProvenance,
  deploymentOwnerSubject,
  missingCapabilityErrors,
} from './registry-helpers.js';
import { registryDeploymentPackage, renderDeploymentPackageSnapshot } from './registry-package.js';
import { recoverRegistryRecords } from './registry-recover.js';
import { rollbackDeployment, rollbackWithMappedErrors } from './registry-rollback.js';
import {
  activeRecord,
  activeRecordVersion,
  persistDeployRecord,
  type RegistryStateView,
  reconcilePlatformAccountResetRegistryCache,
  registryAppArchivedAt,
  registryArchiveApp,
  registryCustomerAuthRestoreProjections,
  registryGetApp,
  registryGetDeployment,
  registryGetEnvironment,
  registryListApps,
  registryListEnvironments,
  registryRestoreApp,
  registrySetProductionEnvironment,
  registrySweepArchived,
  setRegistryDeploymentLock,
} from './registry-state.js';
import { deploymentStatusFor } from './registry-status.js';
import {
  emptySecretEnvelope,
  recordTenant,
  servedTargetFor,
  targetForPersistedRecord,
  tenantDeploymentKey,
  tenantKey,
} from './registry-targets.js';
import type {
  AccessUpdateOptions,
  AccessUpdateResult,
  DeployOptions,
  DeployPreflightResult,
  RecoverResult,
  RunDeployResult,
  ServerRegistryOptions,
} from './registry-types.js';
import { withBuiltinStateCatalog } from './state-catalog.js';
import type { StateHandleStoreFactory } from './state-connector-factory.js';
import {
  deploymentSummary,
  matchesDeploymentFilter,
  validateDeploymentListFilter,
} from './store/records.js';
import {
  type AppArchiveResult,
  type AppRestoreResult,
  type AppSummary,
  type ArtifactStore,
  type ConfigStore,
  type CustomerAuthRestoreProjection,
  type DeploymentListFilter,
  type DeploymentLock,
  type DeploymentLockUpdateResult,
  type DeploymentStatus,
  type DeploymentSummary,
  type DeployRecord,
  type EnvSummary,
  InMemoryConfigStore,
  type ProductionEnvironmentChange,
  type SecretEnvelope,
  type TenantAuthConfig,
  type TenantRef,
  validateTenantRef,
} from './store.js';

export type { RollbackResult } from '@noodle-borg/control-plane/portable';
export type { DeploymentPackage } from './registry-package.js';
export type {
  AccessUpdateFailureCode,
  AccessUpdateOptions,
  AccessUpdateResult,
  DeployError,
  DeployOptions,
  DeployPreflightResult,
  DeployResult,
  RecoverResult,
  ServerRegistryOptions,
} from './registry-types.js';

export class ServerRegistry {
  readonly #servers = new Map<string, ServedTarget>();
  readonly #records = new Map<string, DeployRecord>();
  readonly #activeTenants = new Map<string, string>();
  readonly #productionEnvironments = new Map<string, string>();
  readonly #store: ArtifactStore | undefined;
  readonly #configStore: ConfigStore;
  readonly #customerVerifierFactory: ((auth: TenantAuthConfig) => OwnerTokenVerifier) | undefined;
  readonly #policyGate: PolicyGate | undefined;
  readonly #transactionalModuleDeploymentActivation: boolean;
  #platformCatalog: readonly CatalogConnector[];
  #platformConnectors: readonly Connector[];
  readonly #stateHandleStoreFactory: StateHandleStoreFactory | undefined;
  readonly #delegatedCredentialStore:
    | Pick<OAuthStore, 'getDelegatedCredential' | 'putDelegatedCredential'>
    | undefined;
  readonly #sealCustomerCredential: ((credential: string) => Promise<SecretEnvelope>) | undefined;
  readonly #openCustomerCredential: ((credential: SecretEnvelope) => Promise<string>) | undefined;
  readonly #delegatedExchange: ServerRegistryOptions['delegatedExchange'];
  readonly #localDevtoolsDelegatedExchange: ServerRegistryOptions['localDevtoolsDelegatedExchange'];
  readonly #externalCredentialExchange: ServerRegistryOptions['externalCredentialExchange'];
  readonly #googleWorkloadIdentity: ServerRegistryOptions['googleWorkloadIdentity'];
  readonly #appPackageRenderer: ServerRegistryOptions['renderAppPackage'];
  #serviceCapabilities: readonly CapabilityName[];
  #knowledgeHooks: KnowledgeDeployHooks | undefined;
  #knowledgeSearch: KnowledgeSearchPortFactory | undefined;
  #localAssetOptions: LocalAssetOptions | undefined;
  readonly #localAssetsByPath = new Map<string, PackagedAsset>();
  readonly #inflight = new Map<string, Promise<ServedTarget | undefined>>();

  constructor(
    store?: ArtifactStore,
    _secretBox?: SecretBox,
    configStore?: ConfigStore,
    options: ServerRegistryOptions = {},
  ) {
    if (
      options.localDevtoolsDelegatedExchange !== undefined &&
      options.delegatedExchange !== undefined
    ) {
      throw new Error('local Devtools and hosted OAuth signing authorities cannot coexist');
    }
    this.#store = store;
    this.#configStore = configStore ?? new InMemoryConfigStore();
    this.#customerVerifierFactory = options.customerVerifierFactory;
    this.#policyGate = options.policyGate;
    this.#transactionalModuleDeploymentActivation =
      options.transactionalModuleDeploymentActivation === true;
    this.#platformCatalog = withBuiltinStateCatalog(options.platformCatalog ?? []);
    this.#platformConnectors = options.platformConnectors ?? [];
    this.#stateHandleStoreFactory = options.stateHandleStoreFactory;
    this.#delegatedCredentialStore = options.delegatedCredentialStore;
    this.#sealCustomerCredential = options.sealCustomerCredential;
    this.#openCustomerCredential = options.openCustomerCredential;
    this.#delegatedExchange = options.delegatedExchange;
    this.#localDevtoolsDelegatedExchange = options.localDevtoolsDelegatedExchange;
    this.#externalCredentialExchange = options.externalCredentialExchange;
    this.#googleWorkloadIdentity = options.googleWorkloadIdentity;
    this.#appPackageRenderer = options.renderAppPackage;
    this.#serviceCapabilities = options.serviceCapabilities ?? [
      'observability',
      'secrets',
      'connectors',
      'apps',
    ];
  }
  setServiceCapabilities(capabilities: readonly CapabilityName[]): void {
    this.#serviceCapabilities = capabilities;
  }
  supportsTransactionalModuleDeploymentActivation(): boolean {
    return this.#transactionalModuleDeploymentActivation;
  }
  setPlatformConnectors(input: {
    readonly catalog: readonly CatalogConnector[];
    readonly connectors: readonly Connector[];
  }): void {
    this.#platformCatalog = withBuiltinStateCatalog(input.catalog);
    this.#platformConnectors = input.connectors;
  }
  setLocalAssetOptions(options: LocalAssetOptions): void {
    this.#localAssetOptions = options;
    this.#localAssetsByPath.clear();
  }
  getLocalAsset(pathname: string): PackagedAsset | undefined {
    return this.#localAssetsByPath.get(pathname);
  }
  async deploy(
    tenant: TenantRef,
    manifest: string,
    options: DeployOptions = {},
  ): Promise<RunDeployResult> {
    const {
      connectors,
      actor,
      accessMode,
      hostedAssets,
      serverVersion,
      deploymentSource,
      idempotencyKey,
    } = options;
    const { orgMembershipSources } = options;
    const { automationId } = options;
    const safeTenant = validateTenantRef(tenant);
    const safeServerVersion =
      serverVersion !== undefined ? normalizeServerVersion(serverVersion) : undefined;
    if (safeServerVersion !== undefined) {
      const active = await activeRecordVersion(this.#stateView(), safeTenant, safeServerVersion);
      if (active?.deploymentLock !== undefined) return deploymentLockedConflict();
    }
    const preflight = await preflightRegistryDeploy({
      options,
      serviceCapabilities: this.#serviceCapabilities,
      compile: () => this.#compileTarget(safeTenant, manifest, connectors, hostedAssets, false),
    });
    if (!preflight.ok) return preflight;
    const attempt = await resolveDeployAttempt({
      serverName: preflight.serverName,
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      ...(this.#store !== undefined ? { store: this.#store } : {}),
      records: this.#records,
      tenant: safeTenant,
      manifest,
      options,
    });
    if (attempt.replay !== undefined) return attempt.replay;
    const { deploymentId } = attempt;
    let appPackageSnapshot = preflight.appPackageSnapshot;
    if (preflight.appPackageArtifact !== undefined && appPackageSnapshot === undefined) {
      const rendered = renderDeploymentPackageSnapshot(
        preflight.appPackageArtifact,
        this.#appPackageRenderer,
      );
      if (!rendered.ok) return rendered;
      appPackageSnapshot = rendered.snapshot;
    }
    const version = Date.now();
    const built = preflight.bindDeployment(deploymentId);
    const serverAuth = built.artifact.server.auth;
    const ownerSubject =
      accessMode === 'owner-only' ? (options.ownerSubject ?? actor?.subject) : undefined;
    const record: DeployRecord = {
      schemaVersion: 1,
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

    if (await this.#hasCustomerAuthAudienceConflict(record, serverAuth)) {
      return customerAuthAudienceConflictFailure();
    }
    let active: DeployRecord;
    try {
      active = await withKnowledgePublication(
        this.#knowledgeHooks,
        safeTenant,
        deploymentId,
        built.artifact.server.knowledge,
        () =>
          persistDeployRecord(this.#stateView(), record, safeTenant, automationId === undefined),
      );
    } catch (error) {
      if (error instanceof KnowledgePublicationError) {
        return { ok: false, errors: error.errors };
      }
      if (error instanceof CustomerAuthAudienceConflictError) {
        return customerAuthAudienceConflictFailure();
      }
      if (error instanceof DeploymentLockedError) return deploymentLockedConflict();
      throw error;
    }

    if (automationId !== undefined) {
      let activation: Awaited<ReturnType<ArtifactStore['activateDeployment']>>;
      try {
        activation = await this.#store?.activateDeployment(safeTenant, deploymentId, undefined, {
          automationId,
        });
      } catch (error) {
        if (error instanceof DeploymentActivationError && error.code === 'automation_superseded') {
          return {
            ok: false,
            superseded: true,
            deploymentId,
            deploymentVersion: version,
            ...(safeServerVersion !== undefined ? { serverVersion: safeServerVersion } : {}),
          };
        }
        if (error instanceof CustomerAuthAudienceConflictError) {
          return customerAuthAudienceConflictFailure();
        }
        if (error instanceof DeploymentLockedError) return deploymentLockedConflict();
        throw error;
      }
      if (activation === undefined) {
        return {
          ok: false,
          errors: [
            {
              code: 'run_activation_failed',
              path: 'deploymentId',
              message: 'deployment could not be activated for this automation run',
            },
          ],
        };
      }
      active = activation.active;
      this.#records.set(active.deploymentId, active);
      const previous = activation.previousActive;
      if (previous !== undefined && previous.deploymentId !== active.deploymentId) {
        this.#records.set(previous.deploymentId, { ...previous, active: false });
      }
    }
    if (await this.#hasCustomerAuthAudienceConflict(active, serverAuth)) {
      return customerAuthAudienceConflictFailure();
    }
    this.#servers.set(deploymentId, servedTargetFor(active, built, this.#customerVerifierFactory));
    this.#activeTenants.set(tenantDeploymentKey(safeTenant, safeServerVersion), deploymentId);
    this.#activeTenants.delete(tenantKey(safeTenant));
    const activeOwnerSubject = deploymentOwnerSubject(active);
    return {
      ok: true,
      deploymentId,
      deploymentVersion: version,
      ...(safeServerVersion !== undefined ? { serverVersion: safeServerVersion } : {}),
      ...(accessMode !== undefined ? { accessMode } : {}),
      ...(activeOwnerSubject !== undefined ? { ownerSubject: activeOwnerSubject } : {}),
    };
  }
  /** Read-only deploy validation used by the CLI before config writes, asset upload, or persistence. */
  async preflightDeploy(
    tenant: TenantRef,
    manifest: string,
    options: DeployOptions = {},
  ): Promise<DeployPreflightResult> {
    const safeTenant = validateTenantRef(tenant);
    const safeServerVersion =
      options.serverVersion === undefined
        ? undefined
        : normalizeServerVersion(options.serverVersion);
    if (safeServerVersion !== undefined) {
      const active = await activeRecordVersion(this.#stateView(), safeTenant, safeServerVersion);
      if (active?.deploymentLock !== undefined) return deploymentLockedPreflight();
    }
    const result = await preflightRegistryDeploy({
      options,
      serviceCapabilities: this.#serviceCapabilities,
      compile: () =>
        this.#compileTarget(safeTenant, manifest, options.connectors, options.hostedAssets, true),
    });
    return result.ok ? { ok: true } : result;
  }

  async recover(): Promise<RecoverResult> {
    if (!this.#store) return { recovered: 0, failed: [] };
    return recoverRegistryRecords(await this.#store.loadAll(), {
      compilePersistedRecord: (record) => this.#compilePersistedRecord(record),
      serviceCapabilities: this.#serviceCapabilities,
      customerVerifierFactory: this.#customerVerifierFactory,
      hasCustomerAuthAudienceConflict: (record, auth) =>
        this.#hasCustomerAuthAudienceConflict(record, auth),
      servers: this.#servers,
      records: this.#records,
      activeTenants: this.#activeTenants,
    });
  }

  async #compileTarget(
    tenant: TenantRef,
    manifest: string,
    connectors: string | undefined,
    hostedAssets?: readonly HostedPackagedAsset[],
    renderAppPackage = false,
    deploymentId?: string,
  ): Promise<RegistryCompileResult> {
    return compileRegistryTarget(
      {
        configStore: this.#configStore,
        platformCatalog: this.#platformCatalog,
        localAssetOptions: this.#localAssetOptions,
        localAssetsByPath: this.#localAssetsByPath,
        delegatedCredentialStore: this.#delegatedCredentialStore,
        sealCustomerCredential: this.#sealCustomerCredential,
        openCustomerCredential: this.#openCustomerCredential,
        delegatedExchange: this.#delegatedExchange,
        localDevtoolsDelegatedExchange: this.#localDevtoolsDelegatedExchange,
        externalCredentialExchange: this.#externalCredentialExchange,
        googleWorkloadIdentity: this.#googleWorkloadIdentity,
        stateHandleStoreFactory: this.#stateHandleStoreFactory,
        platformConnectors: this.#platformConnectors,
        policyGate: this.#policyGate,
        appPackageRenderer: this.#appPackageRenderer,
        knowledgeSearch: this.#knowledgeSearch,
      },
      { tenant, manifest, connectors, hostedAssets, deploymentId, renderAppPackage },
    );
  }

  #compilePersistedRecord(record: DeployRecord) {
    return this.#compileTarget(
      recordTenant(record),
      record.manifest,
      record.connectors === undefined
        ? undefined
        : normalizePersistedConnectorsForCompile(record.connectors),
      record.hostedAssets,
      false,
      record.deploymentId,
    );
  }
  async get(deploymentId: string): Promise<ServedTarget | undefined> {
    if (this.#records.get(deploymentId)?.archivedAt !== undefined) return undefined;
    const cached = this.#servers.get(deploymentId);
    if (cached) return cached;
    if (!this.#store) return undefined;
    const inflight = this.#inflight.get(deploymentId);
    if (inflight) return inflight;
    const promise = this.#loadAndCompile(this.#store, deploymentId).finally(() => {
      this.#inflight.delete(deploymentId);
    });
    this.#inflight.set(deploymentId, promise);
    return promise;
  }

  /** Resolve a deployment-id data-plane route only while that exact record is actively serving. */
  async getServing(deploymentId: string): Promise<ServedTarget | undefined> {
    const record = this.#store
      ? await this.#store.get(deploymentId)
      : this.#records.get(deploymentId);
    if (record === undefined || !record.active || record.archivedAt !== undefined) return undefined;
    return this.#targetForPersistedRecord(record);
  }

  async getActiveByTenant(ref: TenantRef): Promise<ServedTarget | undefined> {
    const safe = validateTenantRef(ref);
    if (this.#store) {
      const record = await this.#store.getActiveByTenant(safe);
      if (record === undefined) return undefined;
      this.#activeTenants.set(tenantKey(safe), record.deploymentId);
      return this.#targetForPersistedRecord(record);
    }
    const cachedId = this.#activeTenants.get(tenantKey(safe));
    if (cachedId !== undefined) return this.get(cachedId);
    const record = defaultActiveRecord([...this.#records.values()], safe);
    if (record === undefined) return undefined;
    this.#activeTenants.set(tenantKey(safe), record.deploymentId);
    this.#activeTenants.set(tenantDeploymentKey(safe, record.serverVersion), record.deploymentId);
    return this.get(record.deploymentId);
  }

  async activeDeployProvenance(ref: TenantRef): Promise<ActiveDeployProvenance> {
    const safe = validateTenantRef(ref);
    const record = this.#store
      ? await this.#store.getActiveByTenant(safe)
      : defaultActiveRecord([...this.#records.values()], safe);
    if (record === undefined) return undefined;
    return {
      accessMode: record.accessMode,
      orgMembershipSources: record.orgMembershipSources,
      ownerSubject: deploymentOwnerSubject(record),
    };
  }

  async getActiveByTenantVersion(
    ref: TenantRef,
    serverVersion: string,
  ): Promise<ServedTarget | undefined> {
    const safe = validateTenantRef(ref);
    const record = await activeRecordVersion(this.#stateView(), safe, serverVersion);
    return record !== undefined ? this.#targetForPersistedRecord(record) : undefined;
  }

  async listDeployments(filter: DeploymentListFilter): Promise<readonly DeploymentSummary[]> {
    const safe = validateDeploymentListFilter(filter);
    if (this.#store) return this.#store.listDeployments(safe);
    return [...this.#records.values()]
      .filter((record) => matchesDeploymentFilter(record, safe))
      .sort((a, b) => b.deploymentVersion - a.deploymentVersion)
      .map(deploymentSummary);
  }

  getAppArchivedAt(org: string, app: string): Promise<string | undefined> {
    return registryAppArchivedAt(this.#stateView(), org, app);
  }

  archiveApp(org: string, app: string, at: string): Promise<AppArchiveResult | undefined> {
    return registryArchiveApp(this.#stateView(), org, app, at);
  }

  restoreApp(org: string, app: string): Promise<AppRestoreResult | undefined> {
    return registryRestoreApp(this.#stateView(), org, app, (record) =>
      this.#compilePersistedRecord(record),
    );
  }

  sweepArchived(before: string): Promise<readonly DeployRecord[]> {
    return registrySweepArchived(this.#stateView(), before);
  }

  listApps(
    org: string,
    opts: { includeArchived?: boolean; limit?: number } = {},
  ): Promise<{ readonly apps: readonly AppSummary[]; readonly truncated: boolean }> {
    return registryListApps(this.#stateView(), org, opts);
  }

  getApp(org: string, app: string): Promise<AppSummary | undefined> {
    return registryGetApp(this.#stateView(), org, app);
  }

  listEnvironments(
    org: string,
    app: string,
    opts: { includeArchived?: boolean } = {},
  ): Promise<readonly EnvSummary[]> {
    return registryListEnvironments(this.#stateView(), org, app, opts);
  }

  getEnvironment(org: string, app: string, env: string): Promise<EnvSummary | undefined> {
    return registryGetEnvironment(this.#stateView(), org, app, env);
  }

  setProductionEnvironment(
    org: string,
    app: string,
    env: string,
  ): Promise<ProductionEnvironmentChange | undefined> {
    return registrySetProductionEnvironment(this.#stateView(), org, app, env);
  }

  getDeployment(org: string, deploymentId: string): Promise<DeploymentSummary | undefined> {
    return registryGetDeployment(this.#stateView(), org, deploymentId);
  }

  /** Store-first historical package read; never recompiles or rerenders deployment bytes. */
  async getDeploymentPackage(org: string, deploymentId: string) {
    return registryDeploymentPackage(this.#stateView(), org, deploymentId);
  }

  reconcilePlatformAccountReset(input: PlatformIdentityRecoveryPlan): void {
    reconcilePlatformAccountResetRegistryCache(this.#stateView(), input);
  }
  customerAuthRestoreProjections(
    deploymentIds: readonly string[],
  ): Promise<readonly CustomerAuthRestoreProjection[]> {
    return registryCustomerAuthRestoreProjections(this.#stateView(), deploymentIds, (record) =>
      this.#compilePersistedRecord(record),
    );
  }

  #stateView(): RegistryStateView {
    return {
      store: this.#store,
      records: this.#records,
      servers: this.#servers,
      activeTenants: this.#activeTenants,
      productionEnvironments: this.#productionEnvironments,
    };
  }

  async getStatus(
    ref: TenantRef,
    baseUrl: string,
    serverVersion?: string,
    endpointOptions: EndpointUrlOptions = {},
  ): Promise<DeploymentStatus | undefined> {
    const safe = validateTenantRef(ref);
    const record =
      serverVersion === undefined
        ? await activeRecord(this.#stateView(), safe)
        : await activeRecordVersion(this.#stateView(), safe, serverVersion);
    if (record === undefined) return undefined;
    const built = await this.#compilePersistedRecord(record);
    return deploymentStatusFor(safe, record, built, baseUrl, endpointOptions);
  }
  async updateAccess(ref: TenantRef, options: AccessUpdateOptions): Promise<AccessUpdateResult> {
    const safe = validateTenantRef(ref);
    return updateRegistryAccess(
      this.#stateView(),
      safe,
      options,
      (deploymentId) => this.get(deploymentId),
      this.#customerVerifierFactory,
      (record, auth) => this.#hasCustomerAuthAudienceConflict(record, auth),
    );
  }
  async setDeploymentLock(
    ref: TenantRef,
    serverVersion: string,
    expectedDeploymentId: string,
    deploymentLock: DeploymentLock | undefined,
  ): Promise<DeploymentLockUpdateResult> {
    return setRegistryDeploymentLock(
      this.#stateView(),
      validateTenantRef(ref),
      serverVersion,
      expectedDeploymentId,
      deploymentLock,
    );
  }
  async rollback(ref: TenantRef, deploymentId: string): Promise<RollbackResult> {
    const safe = validateTenantRef(ref);
    return rollbackWithMappedErrors({
      run: () =>
        rollbackDeployment(
          this.#stateView(),
          safe,
          deploymentId,
          (record) => this.#compilePersistedRecord(record),
          this.#serviceCapabilities,
          this.#customerVerifierFactory,
          (record, auth) => this.#hasCustomerAuthAudienceConflict(record, auth),
        ),
      pairKnowledge: async () => this.#knowledgeHooks?.rollback(deploymentId),
      isAudienceConflict: (error) => error instanceof CustomerAuthAudienceConflictError,
      isDeploymentLocked: (error): error is Error => error instanceof DeploymentLockedError,
    });
  }
  get configStore(): ConfigStore {
    return this.#configStore;
  }
  /** Deploy-coupled knowledge publication (ADR 0202); absent means knowledge deploys fail closed upstream. */
  setKnowledgeDeployHooks(hooks: KnowledgeDeployHooks, search?: KnowledgeSearchPortFactory): void {
    this.#knowledgeHooks = hooks;
    this.#knowledgeSearch = search;
  }
  /** Deployment-bound `search_<name>` execution for the assistant loop; absent lists nothing. */
  get knowledgeSearch(): KnowledgeSearchPortFactory | undefined {
    return this.#knowledgeSearch;
  }

  async #targetForPersistedRecord(record: DeployRecord): Promise<ServedTarget | undefined> {
    const store = this.#store;
    return targetForPersistedRecord(record, {
      records: this.#records,
      servers: this.#servers,
      ...(this.#customerVerifierFactory
        ? { customerVerifierFactory: this.#customerVerifierFactory }
        : {}),
      hasCustomerAuthConflict: (candidate, auth) =>
        this.#hasCustomerAuthAudienceConflict(candidate, auth),
      ...(store ? { load: () => this.#loadAndCompile(store, record) } : {}),
    });
  }

  async #loadAndCompile(
    store: ArtifactStore,
    source: string | DeployRecord,
  ): Promise<ServedTarget | undefined> {
    const record = typeof source === 'string' ? await store.get(source) : source;
    if (!record) return undefined;
    const deploymentId = record.deploymentId;
    if (record.archivedAt !== undefined) return undefined;
    const built = await this.#compilePersistedRecord(record);
    if (!built.ok) {
      throw new Error(
        `deployment ${deploymentId} failed to recompile (${built.errors.map((e) => e.code).join(',')})`,
      );
    }
    const missingCapabilities = missingCapabilityErrors(
      built.served.artifact.requirements?.capabilities ?? [],
      this.#serviceCapabilities,
    );
    if (missingCapabilities.length > 0) {
      throw new Error(
        `deployment ${deploymentId} failed capability requirements (${missingCapabilities.map((e) => e.path).join(',')})`,
      );
    }
    if (
      record.active &&
      (await this.#hasCustomerAuthAudienceConflict(record, built.served.artifact.server.auth))
    ) {
      return undefined;
    }
    const target = servedTargetFor(record, built.served, this.#customerVerifierFactory);
    this.#servers.set(deploymentId, target);
    this.#records.set(deploymentId, record);
    return target;
  }

  async #hasCustomerAuthAudienceConflict(
    record: DeployRecord,
    auth: TenantAuthConfig | undefined,
  ): Promise<boolean> {
    return hasActiveCustomerAuthAudienceConflict(this.#store, this.#records, record, auth);
  }

  get size(): number {
    return this.#servers.size;
  }
}
