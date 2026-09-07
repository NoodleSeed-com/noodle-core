import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PreparedPackagedAsset } from '@noodle-borg/compiler';
import type { ControlPlaneIdentity, DeployAuthGate } from '@noodle-borg/control-plane/portable';
import { readJsonBody, sendJson } from '@noodle-borg/transport-http';
import { AssetPlanError } from '../assets.js';
import { baseFromRequest, sendForbidden } from '../http-util.js';
import type { ServiceOptions } from '../options.js';
import type { AuditSink } from '../store/audit.js';
import type { ControlPlaneStore, TenantRef } from '../store.js';
import { parsePreparedAssets } from './assets.js';
import { authorizeControlPlane } from './control-plane.js';

export async function handleAssetPreflight(
  req: IncomingMessage,
  res: ServerResponse,
  options: ServiceOptions,
  maxBody: number,
  tenant: TenantRef,
  gate: DeployAuthGate,
  controlPlane: ControlPlaneStore,
  audit: AuditSink,
): Promise<void> {
  // GHD-3: a GitHub run preflights its widget assets with the same run-scoped token it deploys with
  // (ADR 0132 Decision 3), never a control-plane identity. When that header is present the human
  // auth is skipped and the run token is the whole authorization; the recorded actor is the run.
  const isRunRequest = req.headers['x-noodle-run-token'] !== undefined;
  let identity: ControlPlaneIdentity | undefined;
  if (isRunRequest && options.deploymentAutomation === undefined) {
    return sendJson(res, 503, {
      error: 'automated deploys are not configured for this service',
      code: 'run_deploy_unavailable',
    });
  }
  const automation =
    isRunRequest && options.deploymentAutomation !== undefined
      ? await options.deploymentAutomation.authorize({
          action: 'asset-preflight',
          request: req,
          target: tenant,
        })
      : undefined;
  if (automation?.kind === 'denied') {
    return sendJson(res, automation.status, {
      error: automation.message,
      code: automation.code,
    });
  }
  if (automation?.kind === 'authorized') {
    identity = automation.actor;
  } else if (isRunRequest) {
    return sendJson(res, 401, {
      error: 'run token is not authorized for this asset preflight',
      code: 'run_token_unauthorized',
    });
  } else {
    const authed = await authorizeControlPlane(req, res, gate, { requireIdentity: true });
    if (authed === false) return;
    identity = authed || undefined;
    if (identity && !identity.superAdmin) {
      const member = await controlPlane.isOrgMember({ org: tenant.org, subject: identity.subject });
      if (!member) return sendForbidden(res, 'forbidden');
    }
  }
  if (options.assetStore === undefined) {
    return sendJson(res, 400, { error: 'hosted assets are not configured for this service' });
  }
  const body = await readJsonBody(req, maxBody);
  if (!body.ok) return sendJson(res, body.status, { error: body.error });
  let assets: readonly PreparedPackagedAsset[];
  try {
    assets = parsePreparedAssets((body.value as { assets?: unknown }).assets);
  } catch (error) {
    return sendJson(res, 400, {
      error: `invalid asset preflight request: ${(error as Error).message}`,
    });
  }
  const uploadBaseUrl = baseFromRequest(req, options.tls ?? {});
  const publicBaseUrl = options.assetPublicBaseUrl ?? uploadBaseUrl;
  let plan: Awaited<ReturnType<typeof options.assetStore.planUploads>>;
  try {
    plan = await options.assetStore.planUploads({
      scope: tenant,
      assets,
      uploadBaseUrl,
      publicBaseUrl,
    });
  } catch (error) {
    if (error instanceof AssetPlanError) {
      await audit.emit({
        eventType: 'asset.preflight.rejected',
        org: tenant.org,
        app: tenant.app,
        env: tenant.env,
        decision: 'deny',
        status: 400,
        reasonCode: 'asset_plan_rejected',
        ...(identity?.subject !== undefined ? { actorSubject: identity.subject } : {}),
        ...(identity?.email !== undefined ? { actorEmail: identity.email } : {}),
        details: { assetCount: assets.length },
      });
      return sendJson(res, 400, { error: error.message });
    }
    throw error;
  }
  await audit.emit({
    eventType: 'asset.preflight.accepted',
    org: tenant.org,
    app: tenant.app,
    env: tenant.env,
    decision: 'allow',
    status: 200,
    ...(identity?.subject !== undefined ? { actorSubject: identity.subject } : {}),
    ...(identity?.email !== undefined ? { actorEmail: identity.email } : {}),
    details: {
      assetCount: assets.length,
      uploadCount: plan.uploads.length,
      totalBytes: assets.reduce((sum, asset) => sum + asset.byteLength, 0),
    },
  });
  return sendJson(res, 200, { ok: true, ...plan });
}
