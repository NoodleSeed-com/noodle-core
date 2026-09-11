import * as controlPlaneRows from '@noodle-borg/control-plane';
import {
  type NamedDeploymentActivationHook,
  normalizeServerVersion,
  type OrganizationProvisioningHook,
} from '@noodle-borg/module';
import type { SecretBox } from '@noodle-borg/runtime';
import type { Pool } from 'pg';
import { defaultActiveRecord } from '../deployment-versioning.js';
import { createOrganizationProvisioningTx } from '../modules/context.js';
import type {
  ActiveAccessUpdateInput,
  AppArchiveResult,
  AppRestorePrecondition,
  AppRestoreResult,
  AppSummary,
  ArtifactStore,
  ConfigScope,
  ConfigStore,
  ConfigValueInput,
  ConfigValueMetadata,
  ControlPlaneStore,
  CreateOrgWithOwnerInput,
  DeploymentActivationPrecondition,
  DeploymentActivationResult,
  DeploymentListFilter,
  DeploymentLock,
  DeploymentLockUpdateResult,
  DeploymentPolicyPrecondition,
  DeploymentSummary,
  DeployRecord,
  EnvSummary,
  ManagedConfigKind,
  OrgDomainRecord,
  OrgInvitationRecord,
  OrgMemberRecord,
  OrgOpenAIAppsChallengeRecord,
  OrgRecord,
  OrgRole,
  PersonalWorkspaceProvisionInput,
  PersonalWorkspaceProvisionResult,
  ProductionEnvironmentChange,
  SignupAllowlistKind,
  SignupAllowlistRecord,
  TenantAuthConfig,
  TenantRef,
  WelcomeEmailRecord,
} from '../store.js';
import { validateOrgMembershipDomain, validateSlug, validateTenantRef } from '../store.js';
import { activateDeploymentRows } from './postgres-activation.js';
import {
  archiveAppRows,
  getAppArchivedAtRow,
  getAppRow,
  listAppsRows,
  restoreAppRows,
  sweepArchivedAppRows,
} from './postgres-apps.js';
import {
  listConfigValuesRow,
  resolveConfigValuesRow,
  transactConfigRows,
} from './postgres-config.js';
import { findActiveCustomerAuthAudienceConflictRow } from './postgres-customer-auth-audience.js';
import type { CustomerAuthAudienceReconciliation } from './postgres-customer-auth-audience-schema.js';
import { appendDeployRecordRows } from './postgres-deploy-records.js';
import { updateActiveDeploymentAccessRow } from './postgres-deployment-access.js';
import { setDeploymentLockRow } from './postgres-deployment-lock.js';
import {
  getEnvironmentRow,
  listEnvironmentsRows,
  setProductionEnvironmentRow,
} from './postgres-envs.js';
import { PostgresMcpSubdomainStore } from './postgres-mcp-subdomain.js';
import { provisionPersonalWorkspaceRow } from './postgres-personal-workspace.js';
import {
  DEPLOY_SUMMARY_COLUMNS,
  type DeployRow,
  type DeploySummaryRow,
  isPostgresStoreOptions,
  rowToDeploymentSummary,
  rowToRecord,
} from './postgres-rows.js';
import { ensureArtifactSchema } from './postgres-schema.js';
import { postgresQueryExecutor } from './postgres-transaction.js';
import { validateDeploymentListFilter } from './records.js';

/**
 * Relational {@link ArtifactStore} backend ([ADR 0035](../../../../docs/decisions/0035-relational-artifact-store.md)).
 * One row per deployment in a `deploy_records` table; a shared, networked, strongly-consistent store
 * that replaces the per-instance {@link JsonFileArtifactStore} so multiple stateless instances (Cloud Run)
 * can serve the same servers ([ADR 0034](../../../../docs/decisions/0034-gcp-hosting-topology.md)).
 *
 * The throughput is trivial — one write per deploy, point reads on cache-miss recompile — so the design
 * optimizes for durability, strong consistency, and portability (the same SQL runs on Cloud SQL, RDS,
 * Azure DB, or a self-hosted Postgres). The `pg.Pool` is **injected**: connection construction stays
 * outside this class, keeping it pure SQL and unit-testable against any local Postgres.
 */
export interface PostgresStoreOptions {
  readonly secretBox?: SecretBox;
  readonly now?: () => Date;
  readonly deploymentActivation?:
    | readonly NamedDeploymentActivationHook[]
    | (() => readonly NamedDeploymentActivationHook[]);
  readonly organizationProvisioning?:
    | OrganizationProvisioningHook
    | (() => OrganizationProvisioningHook | undefined);
}

export class PostgresArtifactStore
  extends PostgresMcpSubdomainStore
  implements ArtifactStore, ControlPlaneStore, ConfigStore
{
  readonly #pool: Pool;
  readonly #secretBox: SecretBox | undefined;
  readonly #now: () => Date;
  readonly #deploymentActivation: () => readonly NamedDeploymentActivationHook[];
  readonly #organizationProvisioning: () => OrganizationProvisioningHook | undefined;

  constructor(pool: Pool, secretBoxOrOptions?: SecretBox | PostgresStoreOptions) {
    const options = isPostgresStoreOptions(secretBoxOrOptions) ? secretBoxOrOptions : undefined;
    const secretBox = isPostgresStoreOptions(secretBoxOrOptions)
      ? secretBoxOrOptions.secretBox
      : secretBoxOrOptions;
    const now = options?.now ?? (() => new Date());
    super(pool, now);
    this.#pool = pool;
    this.#secretBox = secretBox;
    this.#now = now;
    const deploymentActivation = options?.deploymentActivation;
    this.#deploymentActivation =
      typeof deploymentActivation === 'function'
        ? deploymentActivation
        : () => deploymentActivation ?? [];
    const organizationProvisioning = options?.organizationProvisioning;
    this.#organizationProvisioning =
      typeof organizationProvisioning === 'function'
        ? organizationProvisioning
        : () => organizationProvisioning;
  }

  /**
   * Create the `deploy_records` table if absent (idempotent). Run once at startup before serving. The
   * `secrets` column is `jsonb` and holds the tagged {@link SecretEnvelope} (AES-256-GCM ciphertext when a
   * master key is configured — never cleartext at rest). `schema_version` carries a forward-migration hook.
   */
  async ensureSchema(): Promise<void> {
    await this.ensureSchemaWithCustomerAuthAudienceReport();
  }

  async ensureSchemaWithCustomerAuthAudienceReport(): Promise<CustomerAuthAudienceReconciliation> {
    return ensureArtifactSchema(this.#pool);
  }

  append(record: DeployRecord, precondition?: DeploymentPolicyPrecondition): Promise<void> {
    return appendDeployRecordRows(this.#pool, record, this.#deploymentActivation(), precondition);
  }

  async get(deploymentId: string): Promise<DeployRecord | undefined> {
    const { rows } = await postgresQueryExecutor(this.#pool).query<DeployRow>(
      'SELECT * FROM deploy_records WHERE deployment_id = $1',
      [deploymentId],
    );
    const row = rows[0];
    return row ? rowToRecord(row) : undefined;
  }

  async getActiveByTenant(ref: TenantRef): Promise<DeployRecord | undefined> {
    const safe = validateTenantRef(ref);
    const { rows } = await postgresQueryExecutor(this.#pool).query<DeployRow>(
      `SELECT *
       FROM deploy_records
       WHERE org_slug = $1 AND app_slug = $2 AND environment = $3 AND active = true
         AND archived_at IS NULL
       ORDER BY deployment_version DESC`,
      [safe.org, safe.app, safe.env],
    );
    return defaultActiveRecord(rows.map(rowToRecord), safe);
  }

  async getActiveByTenantVersion(
    ref: TenantRef,
    serverVersion: string,
  ): Promise<DeployRecord | undefined> {
    const safe = validateTenantRef(ref);
    const safeVersion = normalizeServerVersion(serverVersion);
    const { rows } = await postgresQueryExecutor(this.#pool).query<DeployRow>(
      `SELECT *
       FROM deploy_records
       WHERE org_slug = $1
         AND app_slug = $2
         AND environment = $3
         AND server_version = $4
         AND active = true
         AND archived_at IS NULL
       ORDER BY deployment_version DESC
       LIMIT 1`,
      [safe.org, safe.app, safe.env, safeVersion],
    );
    const row = rows[0];
    return row ? rowToRecord(row) : undefined;
  }

  setDeploymentLock(
    ref: TenantRef,
    serverVersion: string,
    expectedDeploymentId: string,
    deploymentLock: DeploymentLock | undefined,
  ): Promise<DeploymentLockUpdateResult> {
    return setDeploymentLockRow(
      this.#pool,
      ref,
      serverVersion,
      expectedDeploymentId,
      deploymentLock,
    );
  }

  findActiveCustomerAuthAudienceConflict(
    ref: TenantRef,
    auth: TenantAuthConfig,
  ): Promise<TenantRef | undefined> {
    return findActiveCustomerAuthAudienceConflictRow(postgresQueryExecutor(this.#pool), ref, auth);
  }

  async updateActiveAccess(
    ref: TenantRef,
    deploymentId: string,
    input: ActiveAccessUpdateInput,
  ): Promise<DeployRecord | undefined> {
    return updateActiveDeploymentAccessRow(this.#pool, ref, deploymentId, input);
  }

  async activateDeployment(
    ref: TenantRef,
    deploymentId: string,
    precondition?: DeploymentActivationPrecondition,
    options?: { readonly automationId?: string },
  ): Promise<DeploymentActivationResult | undefined> {
    return activateDeploymentRows(
      this.#pool,
      ref,
      deploymentId,
      precondition,
      this.#deploymentActivation(),
      options,
    );
  }

  async loadAll(): Promise<readonly DeployRecord[]> {
    const { rows } = await postgresQueryExecutor(this.#pool).query<DeployRow>(
      'SELECT * FROM deploy_records',
    );
    return rows.map(rowToRecord);
  }

  async listDeployments(filter: DeploymentListFilter): Promise<readonly DeploymentSummary[]> {
    const safe = validateDeploymentListFilter(filter);
    const clauses = ['org_slug = $1'];
    const values: unknown[] = [safe.org];
    if (safe.app !== undefined) {
      values.push(safe.app);
      clauses.push(`app_slug = $${values.length}`);
    }
    if (safe.env !== undefined) {
      values.push(safe.env);
      clauses.push(`environment = $${values.length}`);
    }
    if (safe.includeArchived !== true) clauses.push('archived_at IS NULL');
    const { rows } = await postgresQueryExecutor(this.#pool).query<DeploySummaryRow>(
      `SELECT ${DEPLOY_SUMMARY_COLUMNS}
       FROM deploy_records
       WHERE ${clauses.join(' AND ')}
       ORDER BY deployment_version DESC`,
      values,
    );
    return rows.map(rowToDeploymentSummary);
  }

  async getAppArchivedAt(org: string, app: string): Promise<string | undefined> {
    return getAppArchivedAtRow(postgresQueryExecutor(this.#pool), org, app);
  }

  async archiveApp(org: string, app: string, at: string): Promise<AppArchiveResult | undefined> {
    return archiveAppRows(this.#pool, org, app, at);
  }

  async restoreApp(
    org: string,
    app: string,
    precondition?: AppRestorePrecondition,
  ): Promise<AppRestoreResult | undefined> {
    return restoreAppRows(this.#pool, org, app, precondition, this.#deploymentActivation());
  }

  sweepArchived(before: string): Promise<readonly DeployRecord[]> {
    return sweepArchivedAppRows(this.#pool, before);
  }

  async listApps(
    org: string,
    opts: { readonly includeArchived?: boolean; readonly limit?: number } = {},
  ): Promise<{ readonly apps: readonly AppSummary[]; readonly truncated: boolean }> {
    return listAppsRows(postgresQueryExecutor(this.#pool), org, opts);
  }

  async getAppGeneration(org: string, app: string): Promise<string | undefined> {
    const result = await postgresQueryExecutor(this.#pool).query<{ generation: string }>(
      `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS generation FROM apps WHERE org_slug=$1 AND slug=$2`,
      [validateSlug('org', org), validateSlug('app', app)],
    );
    return result.rows[0]?.generation;
  }

  async getApp(org: string, app: string): Promise<AppSummary | undefined> {
    return getAppRow(postgresQueryExecutor(this.#pool), org, app);
  }

  async listEnvironments(
    org: string,
    app: string,
    opts: { readonly includeArchived?: boolean } = {},
  ): Promise<readonly EnvSummary[]> {
    return listEnvironmentsRows(postgresQueryExecutor(this.#pool), org, app, opts);
  }

  async getEnvironment(org: string, app: string, env: string): Promise<EnvSummary | undefined> {
    return getEnvironmentRow(postgresQueryExecutor(this.#pool), org, app, env);
  }

  async setProductionEnvironment(
    org: string,
    app: string,
    env: string,
  ): Promise<ProductionEnvironmentChange | undefined> {
    return setProductionEnvironmentRow(this.#pool, org, app, env);
  }

  async getDeployment(org: string, deploymentId: string): Promise<DeploymentSummary | undefined> {
    const safeOrg = validateSlug('org', org);
    // Org-scoped in the query itself (not filtered after fetch): a deployment_id belonging to another
    // org must never be distinguishable from an unknown one.
    const { rows } = await postgresQueryExecutor(this.#pool).query<DeploySummaryRow>(
      `SELECT ${DEPLOY_SUMMARY_COLUMNS} FROM deploy_records WHERE deployment_id = $1 AND org_slug = $2`,
      [deploymentId, safeOrg],
    );
    const row = rows[0];
    return row ? rowToDeploymentSummary(row) : undefined;
  }

  setConfigValue(input: ConfigValueInput): Promise<ConfigValueMetadata> {
    return this.transactConfig(input.scope.org, (transaction) => transaction.setConfigValue(input));
  }

  deleteConfigValue(kind: ManagedConfigKind, scope: ConfigScope, name: string): Promise<boolean> {
    return this.transactConfig(scope.org, (transaction) =>
      transaction.deleteConfigValue(kind, scope, name),
    );
  }

  transactConfig<T>(org: string, work: (transaction: ConfigStore) => Promise<T>): Promise<T> {
    return transactConfigRows(this.#pool, this.#secretBox, org, work);
  }

  listConfigValues(
    kind: ManagedConfigKind,
    scope: ConfigScope,
  ): Promise<readonly ConfigValueMetadata[]> {
    return listConfigValuesRow(postgresQueryExecutor(this.#pool), kind, scope);
  }

  resolveConfigValues(
    kind: ManagedConfigKind,
    scope: ConfigScope,
    name?: string,
  ): Promise<Record<string, string>> {
    return resolveConfigValuesRow(
      postgresQueryExecutor(this.#pool),
      this.#secretBox,
      kind,
      scope,
      name,
    );
  }

  async createOrg(input: { slug: string; displayName?: string }): Promise<OrgRecord> {
    return controlPlaneRows.createOrgRow(this.#pool, input);
  }
  createOrgWithOwner(input: CreateOrgWithOwnerInput): Promise<OrgRecord> {
    return controlPlaneRows.createOrgWithOwnerRow(
      this.#pool,
      input,
      this.#now,
      createOrganizationProvisioningTx(this.#organizationProvisioning),
    );
  }

  provisionPersonalWorkspace(
    input: PersonalWorkspaceProvisionInput,
  ): Promise<PersonalWorkspaceProvisionResult> {
    return provisionPersonalWorkspaceRow(
      this.#pool,
      input,
      this.#now,
      createOrganizationProvisioningTx(this.#organizationProvisioning),
    );
  }

  claimWelcomeEmail(input: {
    readonly now: Date;
    readonly leaseMs: number;
  }): Promise<WelcomeEmailRecord | undefined> {
    return controlPlaneRows.claimWelcomeEmailRow(this.#pool, input);
  }

  markWelcomeEmailSent(input: {
    readonly subject: string;
    readonly providerMessageId: string;
  }): Promise<void> {
    return controlPlaneRows.markWelcomeEmailSentRow(this.#pool, input);
  }

  markWelcomeEmailFailed(input: {
    readonly subject: string;
    readonly nextAttemptAt: Date;
  }): Promise<void> {
    return controlPlaneRows.markWelcomeEmailFailedRow(this.#pool, input);
  }

  getWelcomeEmail(subject: string): Promise<WelcomeEmailRecord | undefined> {
    return controlPlaneRows.getWelcomeEmailRow(this.#pool, subject);
  }

  async updateOrg(input: { slug: string; displayName: string }): Promise<OrgRecord | undefined> {
    return controlPlaneRows.updateOrgRow(this.#pool, input);
  }

  async getOrg(slug: string): Promise<OrgRecord | undefined> {
    return controlPlaneRows.getOrgRow(this.#pool, slug);
  }

  getOrganizationAgreement(org: string, version: string) {
    return controlPlaneRows.getOrganizationAgreementRow(
      postgresQueryExecutor(this.#pool),
      org,
      version,
    );
  }

  acceptOrganizationAgreement(input: controlPlaneRows.AcceptOrganizationAgreementInput) {
    return controlPlaneRows.acceptOrganizationAgreementRow(this.#pool, input);
  }

  async listOrgs(): Promise<readonly OrgRecord[]> {
    return controlPlaneRows.listOrgRows(this.#pool);
  }

  async listOrgsForSubject(subject: string): Promise<readonly OrgRecord[]> {
    return controlPlaneRows.listOrgRowsForSubject(this.#pool, subject);
  }

  async addOrgMember(input: {
    org: string;
    subject: string;
    email: string;
    role: OrgRole;
  }): Promise<OrgMemberRecord> {
    return controlPlaneRows.addOrgMemberRow(this.#pool, input);
  }

  async removeOrgMember(input: { org: string; subject: string }): Promise<boolean> {
    return controlPlaneRows.removeOrgMemberRow(this.#pool, input);
  }

  async updateOrgMemberRole(input: {
    org: string;
    subject: string;
    role: OrgRole;
  }): Promise<OrgMemberRecord | undefined> {
    return controlPlaneRows.updateOrgMemberRoleRow(this.#pool, input);
  }

  async getOrgMember(input: {
    org: string;
    subject: string;
  }): Promise<OrgMemberRecord | undefined> {
    return controlPlaneRows.getOrgMemberRow(this.#pool, input);
  }

  async listOrgMembers(org: string): Promise<readonly OrgMemberRecord[]> {
    return controlPlaneRows.listOrgMemberRows(this.#pool, org);
  }

  async isOrgMember(input: { org: string; subject: string }): Promise<boolean> {
    return controlPlaneRows.isOrgMemberRow(this.#pool, input);
  }

  async addOrgDomain(input: {
    org: string;
    domain: string;
    challenge?: string;
  }): Promise<OrgDomainRecord> {
    const org = validateSlug('org', input.org);
    // Validate before creating the org so a rejected domain leaves no side effect.
    validateOrgMembershipDomain(input.domain);
    await this.createOrg({ slug: org });
    return controlPlaneRows.addOrgDomainRow(this.#pool, { ...input, org });
  }

  removeOrgDomain(input: { org: string; domain: string }): Promise<boolean> {
    return controlPlaneRows.removeOrgDomainRow(this.#pool, input);
  }

  async markOrgDomainVerification(input: {
    org: string;
    domain: string;
    verified: boolean;
  }): Promise<OrgDomainRecord | undefined> {
    return controlPlaneRows.markOrgDomainVerificationRow(this.#pool, this.#now, input);
  }

  async listOrgDomains(org: string): Promise<readonly OrgDomainRecord[]> {
    return controlPlaneRows.listOrgDomainRows(this.#pool, org);
  }

  async setOrgOpenAIAppsChallenge(input: {
    org: string;
    challenge: string;
    updatedBySubject?: string;
    updatedByEmail?: string;
  }): Promise<OrgOpenAIAppsChallengeRecord> {
    return controlPlaneRows.setOrgOpenAIAppsChallengeRow(this.#pool, input);
  }

  async getOrgOpenAIAppsChallenge(org: string): Promise<OrgOpenAIAppsChallengeRecord | undefined> {
    return controlPlaneRows.getOrgOpenAIAppsChallengeRow(this.#pool, org);
  }

  async clearOrgOpenAIAppsChallenge(org: string): Promise<boolean> {
    return controlPlaneRows.clearOrgOpenAIAppsChallengeRow(this.#pool, org);
  }

  async isDataPlaneOrgMember(input: {
    org: string;
    subject: string;
    email?: string;
  }): Promise<boolean> {
    if (await this.isOrgMember({ org: input.org, subject: input.subject })) return true;
    if (input.email === undefined) return false;
    return controlPlaneRows.hasOrgDomainMembership(this.#pool, {
      org: input.org,
      email: input.email,
    });
  }

  async allowSignup(input: {
    kind: SignupAllowlistKind;
    value: string;
    createdBySubject?: string;
  }): Promise<SignupAllowlistRecord> {
    return controlPlaneRows.allowSignupRow(this.#pool, input);
  }

  async listSignupAllowlist(): Promise<readonly SignupAllowlistRecord[]> {
    return controlPlaneRows.listSignupAllowlistRows(this.#pool);
  }

  async isSignupAllowed(input: { subject: string; email: string }): Promise<boolean> {
    return controlPlaneRows.isSignupAllowedByRows(this.#pool, input);
  }

  async createOrgInvitation(input: {
    org: string;
    email: string;
    role: OrgRole;
    tokenHash: string;
    createdBySubject: string;
    createdByEmail?: string;
    expiresAt: Date;
  }): Promise<OrgInvitationRecord> {
    return controlPlaneRows.createOrgInvitationRow(this.#pool, this.#now, input);
  }

  async getOrgInvitation(input: { tokenHash: string }): Promise<OrgInvitationRecord | undefined> {
    return controlPlaneRows.getOrgInvitationRow(this.#pool, this.#now, input);
  }

  async consumeOrgInvitation(input: {
    tokenHash: string;
  }): Promise<OrgInvitationRecord | undefined> {
    return controlPlaneRows.consumeOrgInvitationRow(this.#pool, this.#now, input);
  }

  async listOrgInvitations(org: string): Promise<readonly OrgInvitationRecord[]> {
    return controlPlaneRows.listOrgInvitationRows(this.#pool, org);
  }

  async revokeOrgInvitation(input: { org: string; email: string }): Promise<number> {
    return controlPlaneRows.revokeOrgInvitationRows(this.#pool, input);
  }
}
