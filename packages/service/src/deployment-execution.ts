import { cspFaultsInManifest, type HostedPackagedAsset } from '@noodle-borg/compiler';
import type { ControlPlaneIdentity } from '@noodle-borg/control-plane/portable';
import type { OrgMembershipSource } from '@noodle-borg/module';
import { type AccessMode, noopLogger } from '@noodle-borg/transport-http';
import type { DeploymentSource } from '@noodle-borg/wire-contracts';
import { BUSINESS_SETUP_MESSAGE, BusinessOnboarding } from './business-onboarding.js';
import type { ServiceOptions } from './options.js';
import type { ServerRegistry } from './registry.js';
import { manifestUsesUserRoot } from './registry-access.js';
import { isIdentityAccessMode } from './routes/access-mode.js';
import { provisionPublicEmbed } from './routes/deploy-public-embed.js';
import { deploymentActivationRejection } from './routes/deployment-activation-response.js';
import type { AuditSink } from './store/audit.js';
import type { ControlPlaneStore, TenantRef } from './store.js';

export interface AuthorizedDeploymentInput {
  /** Saved-installation recovery must preserve an explicit embed revocation. */
  readonly allowRevokedEmbedReplacement?: boolean;
  readonly tenant: TenantRef;
  readonly manifest: string;
  readonly connectors?: string | undefined;
  readonly hostedAssets?: readonly HostedPackagedAsset[] | undefined;
  /** Installation-only immutable source assets, authorized by the caller; never accepted from deploy HTTP input. */
  readonly assetSourceScope?: TenantRef;
  readonly accessMode: AccessMode;
  readonly identity?: ControlPlaneIdentity | undefined;
  readonly ownerSubject?: string | undefined;
  readonly orgMembershipSources?: readonly OrgMembershipSource[] | undefined;
  readonly deploymentSource?: DeploymentSource | undefined;
  readonly serverVersion: string;
  readonly idempotencyKey?: string | undefined;
  readonly automationId?: string | undefined;
}
export interface AuthorizedDeploymentDependencies {
  readonly registry: ServerRegistry;
  readonly options: ServiceOptions;
  readonly controlPlane: ControlPlaneStore;
  readonly audit: AuditSink;
}
export type AuthorizedDeploymentResult =
  | {
      readonly ok: true;
      readonly result: Extract<Awaited<ReturnType<ServerRegistry['deploy']>>, { ok: true }>;
      readonly embedId?: string;
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly body: Readonly<Record<string, unknown>>;
    };

/** Shared post-authorization deploy flow. Both API deploys and installations retain registry activation hooks. */
export async function executeAuthorizedDeployment(
  input: AuthorizedDeploymentInput,
  dependencies: AuthorizedDeploymentDependencies,
): Promise<AuthorizedDeploymentResult> {
  const {
    tenant,
    manifest,
    connectors,
    accessMode,
    identity,
    ownerSubject,
    orgMembershipSources,
    deploymentSource,
    serverVersion,
    automationId,
  } = input;
  let hostedAssets = input.hostedAssets;
  const idempotency = { key: input.idempotencyKey };
  const { registry, options, controlPlane, audit } = dependencies;
  if (options.businessOnboarding && options.businessInformationStore) {
    const onboarding = new BusinessOnboarding(
      options.businessOnboarding,
      controlPlane,
      options.businessInformationStore,
    );
    for (const installation of await options.businessInformationStore.listInstallations(
      tenant.org,
    )) {
      if (
        installation.scope.app === tenant.app &&
        installation.scope.env === tenant.env &&
        !(await onboarding.ready(installation))
      )
        return reject(409, { code: 'business_setup_required', error: BUSINESS_SETUP_MESSAGE });
    }
  }
  if (input.assetSourceScope !== undefined && input.assetSourceScope.org !== tenant.org)
    return reject(403, {
      code: 'asset_source_forbidden',
      error: 'Asset source must belong to the authorized installation organization.',
    });
  const assetScope = input.assetSourceScope ?? tenant;
  if ((await registry.getAppArchivedAt(tenant.org, tenant.app)) !== undefined) {
    await audit.emit({
      eventType: 'deploy.rejected',
      ...tenant,
      decision: 'deny',
      status: 409,
      reasonCode: 'app_archived',
      ...(identity?.subject === undefined ? {} : { actorSubject: identity.subject }),
    });
    return reject(409, {
      error: 'app is archived; restore it before deploying',
      code: 'app_archived',
    });
  }
  // Identity access modes bind the data plane to verified identity, so the deployer must be authenticated.
  // (Localhost dev runs the gate open; such deploys are rejected for lack of an owner/audit actor.)
  if (isIdentityAccessMode(accessMode) && !identity) {
    return reject(401, {
      error: `${accessMode} deployments require an authenticated deployer`,
    });
  }
  if (accessMode === 'public' && manifestUsesUserRoot(manifest)) {
    return reject(400, {
      error: 'public access mode cannot reference ${user}; use mixed for optional identity',
    });
  }
  // Widget CSP gate (deploy-only): a CSP origin the host renderer will silently drop breaks the widget
  // for end users, so the deploy is refused here. The compiler surfaces the same faults as non-blocking
  // warnings, so `noodle dev`/`validate` still render the widget locally — only shipping is gated.
  const [cspFault] = cspFaultsInManifest(manifest);
  if (cspFault !== undefined) {
    return reject(400, {
      error:
        `widget "${cspFault.widget}" CSP ${cspFault.list} origin "${cspFault.value}" is not an ` +
        `absolute https:// origin and would be dropped by the host renderer` +
        (cspFault.suggestion !== undefined ? `; use "${cspFault.suggestion}"` : ''),
    });
  }

  if ((await controlPlane.getOrg(tenant.org)) === undefined) {
    await audit.emit({
      eventType: 'deploy.rejected',
      org: tenant.org,
      app: tenant.app,
      env: tenant.env,
      decision: 'deny',
      status: 404,
      reasonCode: 'organization_not_found',
      ...(identity?.subject !== undefined ? { actorSubject: identity.subject } : {}),
      ...(identity?.email !== undefined ? { actorEmail: identity.email } : {}),
    });
    return reject(404, {
      code: 'organization_not_found',
      error: 'organization must be created before deploy',
    });
  }

  const logger = options.logger ?? noopLogger;
  if (hostedAssets !== undefined && hostedAssets.length > 0) {
    if (options.assetStore === undefined) {
      await audit.emit({
        eventType: 'asset.rejected',
        org: tenant.org,
        app: tenant.app,
        env: tenant.env,
        decision: 'deny',
        status: 400,
        reasonCode: 'asset_store_not_configured',
        ...(identity?.subject !== undefined ? { actorSubject: identity.subject } : {}),
        ...(identity?.email !== undefined ? { actorEmail: identity.email } : {}),
        details: { assetCount: hostedAssets.length },
      });
      return reject(400, { error: 'hosted assets are not configured for this service' });
    }
    const verified = await options.assetStore.verifyUploadedAssets({
      scope: assetScope,
      assets: hostedAssets,
    });
    if (!verified.ok) {
      await audit.emit({
        eventType: 'asset.rejected',
        org: tenant.org,
        app: tenant.app,
        env: tenant.env,
        decision: 'deny',
        status: 400,
        reasonCode: 'asset_verification_failed',
        ...(identity?.subject !== undefined ? { actorSubject: identity.subject } : {}),
        ...(identity?.email !== undefined ? { actorEmail: identity.email } : {}),
        details: { assetCount: hostedAssets.length },
      });
      return reject(400, { error: verified.error });
    }
    hostedAssets = verified.assets;
  }
  let result: Awaited<ReturnType<ServerRegistry['deploy']>>;
  try {
    result = await registry.deploy(tenant, manifest, {
      connectors,
      actor: identity || undefined,
      accessMode,
      ownerSubject,
      ...(orgMembershipSources !== undefined ? { orgMembershipSources } : {}),
      hostedAssets,
      serverVersion,
      deploymentSource: automationId === undefined ? (deploymentSource ?? 'api') : 'github',
      ...(idempotency.key !== undefined ? { idempotencyKey: idempotency.key } : {}),
      ...(automationId === undefined ? {} : { automationId }),
    });
  } catch (error) {
    const rejected = await deploymentActivationRejection(error, {
      audit,
      eventType: 'deploy.rejected',
      org: tenant.org,
      app: tenant.app,
      env: tenant.env,
      ...(identity?.subject !== undefined ? { actorSubject: identity.subject } : {}),
      ...(identity?.email !== undefined ? { actorEmail: identity.email } : {}),
    });
    if (rejected !== undefined) return reject(rejected.status, rejected.body);
    throw error;
  }
  if (!result.ok) {
    if ('conflict' in result) {
      if (result.code === 'deployment_locked') {
        await audit.emit({
          eventType: 'deploy.rejected',
          org: tenant.org,
          app: tenant.app,
          env: tenant.env,
          decision: 'deny',
          status: 409,
          reasonCode: result.code,
          ...(identity?.subject !== undefined ? { actorSubject: identity.subject } : {}),
          ...(identity?.email !== undefined ? { actorEmail: identity.email } : {}),
          details: { serverVersion },
        });
      }
      return reject(409, {
        ok: false,
        code: result.code,
        error: result.message,
      });
    }
    if ('superseded' in result) {
      if (automationId !== undefined) {
        await options.deploymentAutomation
          ?.recordSuperseded?.({ automationId, target: tenant })
          .catch(() => undefined);
      }
      return reject(409, {
        ok: false,
        code: 'run_superseded',
        error: 'a newer GitHub deploy run exists for this app/env; this run was not activated',
        deploymentId: result.deploymentId,
        ...(result.serverVersion !== undefined ? { serverVersion: result.serverVersion } : {}),
      });
    }
    // Codes are safe enum strings; never a path-with-value. No secret name or value is logged.
    const codes = result.errors.map((error) => error.code).join(',');
    logger.warn('deploy.rejected', {
      status: 400,
      errorCount: result.errors.length,
      codes,
    });
    // Durable audit: a rejected deploy is a governance event. Safe fields only — no manifest body.
    await audit.emit({
      eventType: 'deploy.rejected',
      org: tenant.org,
      app: tenant.app,
      env: tenant.env,
      decision: 'deny',
      status: 400,
      reasonCode: 'compile_failed',
      ...(identity?.subject !== undefined ? { actorSubject: identity.subject } : {}),
      ...(identity?.email !== undefined ? { actorEmail: identity.email } : {}),
      details: { errorCount: result.errors.length, codes },
    });
    return reject(400, { ok: false, errors: result.errors });
  }

  // Counts only — never secret names or values.
  logger.info('deploy.ok', {
    deploymentId: result.deploymentId,
    serverVersion: result.serverVersion,
    org: tenant.org,
    app: tenant.app,
    env: tenant.env,
    hasConnectors: connectors !== undefined,
  });
  await audit.emit({
    eventType: 'deploy.accepted',
    org: tenant.org,
    app: tenant.app,
    env: tenant.env,
    decision: 'allow',
    status: 201,
    ...(result.deploymentId !== undefined ? { deploymentId: result.deploymentId } : {}),
    ...(identity?.subject !== undefined ? { actorSubject: identity.subject } : {}),
    ...(identity?.email !== undefined ? { actorEmail: identity.email } : {}),
    details: {
      accessMode: result.accessMode ?? accessMode,
      deploymentSource: automationId === undefined ? (deploymentSource ?? 'api') : 'github',
      ...(ownerSubject !== undefined ? { ownerSubject } : {}),
      serverVersion: result.serverVersion,
      hasConnectors: connectors !== undefined,
    },
  });
  // Tenant-safe developer-facing log (M3, ADR 0101): a safe deploy-lifecycle record the developer can read
  // via `noodle logs`. Only scalar metadata, no manifest/secret/payload material.
  await options.userAppLogStore?.emit({
    level: 'info',
    message: 'deployment live',
    org: tenant.org,
    app: tenant.app,
    env: tenant.env,
    ...(result.deploymentId !== undefined ? { deploymentId: result.deploymentId } : {}),
    details: { accessMode: result.accessMode ?? accessMode, serverVersion: result.serverVersion },
  });
  if (result.ok && hostedAssets !== undefined && hostedAssets.length > 0) {
    await audit.emit({
      eventType: 'asset.activation.accepted',
      org: tenant.org,
      app: tenant.app,
      env: tenant.env,
      decision: 'allow',
      status: 201,
      deploymentId: result.deploymentId,
      ...(identity?.subject !== undefined ? { actorSubject: identity.subject } : {}),
      ...(identity?.email !== undefined ? { actorEmail: identity.email } : {}),
      details: {
        assetCount: hostedAssets.length,
        totalBytes: hostedAssets.reduce((sum, asset) => sum + asset.byteLength, 0),
      },
    });
    await options.assetStore?.recordReachability({
      scope: assetScope,
      deploymentId: result.deploymentId,
      deploymentVersion: result.deploymentVersion,
      assets: hostedAssets,
    });
  }

  const embedId = await provisionPublicEmbed(
    registry,
    options,
    tenant,
    result.deploymentId,
    input.allowRevokedEmbedReplacement,
  );
  return { ok: true, result, ...(embedId === undefined ? {} : { embedId }) };
}

function reject(
  status: number,
  body: Readonly<Record<string, unknown>>,
): AuthorizedDeploymentResult {
  return { ok: false, status, body };
}
