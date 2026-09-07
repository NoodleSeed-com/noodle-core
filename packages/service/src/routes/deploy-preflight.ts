import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { cspFaultsInManifest } from '@noodle-borg/compiler';
import type { DeployAuthGate } from '@noodle-borg/control-plane/portable';
import { readDeployBody, sendJson } from '@noodle-borg/transport-http';
import {
  DEPLOY_PREFLIGHT_CHECK_TIMEOUT_MS,
  deployPreflightRequestSchema,
  formatWireError,
} from '@noodle-borg/wire-contracts';
import type { ServiceOptions } from '../options.js';
import type { ServerRegistry } from '../registry.js';
import { manifestUsesUserRoot } from '../registry-access.js';
import type { DeployError } from '../registry-types.js';
import type { AuditSink } from '../store/audit.js';
import type { ControlPlaneStore, TenantRef } from '../store.js';
import { isIdentityAccessMode } from './access-mode.js';
import {
  authorizeDeploymentOwnerSelection,
  authorizeTenantControl,
  developerGrantRouteAccess,
} from './control-plane.js';

// Per-process resource admission, not a tenant quota or distributed state authority.
const activePreflights = new WeakSet<ServerRegistry>();

/**
 * Read-only first-deploy readiness. It intentionally does not verify uploaded asset bytes:
 * the CLI calls this before it requests upload targets or sends any bytes.
 */
export async function handleDeployPreflight(
  req: IncomingMessage,
  res: ServerResponse,
  registry: ServerRegistry,
  options: ServiceOptions,
  maxBody: number,
  tenant: TenantRef,
  gate: DeployAuthGate,
  controlPlane: ControlPlaneStore,
  audit: AuditSink,
): Promise<void> {
  const startedAt = Date.now();
  const suppliedId = req.headers['x-request-id'];
  const requestId =
    typeof suppliedId === 'string' &&
    /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(suppliedId)
      ? suppliedId
      : randomUUID();
  res.setHeader('x-request-id', requestId);
  const identity = await authorizeTenantControl(
    req,
    res,
    gate,
    controlPlane,
    tenant.org,
    developerGrantRouteAccess(options.developerGrantStore, 'deployments:write'),
  );
  if (identity === false) return;
  if ((await controlPlane.getOrg(tenant.org)) === undefined) {
    return sendJson(res, 404, {
      code: 'organization_not_found',
      error: 'organization must be created before deploy',
    });
  }
  const archivedAt = await registry.getAppArchivedAt(tenant.org, tenant.app);
  if (archivedAt !== undefined) {
    return sendJson(res, 409, {
      code: 'app_archived',
      error: 'app is archived; restore it before deploying',
    });
  }

  if (activePreflights.has(registry)) {
    await audit.emit({
      eventType: 'deploy.preflight.rejected',
      ...tenant,
      actorSubject: identity.subject,
      decision: 'deny',
      status: 503,
      reasonCode: 'deploy_preflight_busy',
      details: { requestId, phase: 'admission', elapsedMs: Date.now() - startedAt },
    });
    res.setHeader('retry-after', '5');
    return sendJson(res, 503, {
      code: 'deploy_preflight_busy',
      phase: 'admission',
      error:
        'This instance is already checking a deployment. Retry once after the indicated delay.',
    });
  }
  activePreflights.add(registry);
  let clientDisconnected = false;
  let deadlineExceeded = false;
  let phase = 'body';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onClose = () => {
    if (!res.writableFinished) clientDisconnected = true;
  };
  res.once('close', onClose);
  try {
    await audit.emit({
      eventType: 'deploy.preflight.started',
      ...tenant,
      actorSubject: identity.subject,
      decision: 'allow',
      details: { requestId, phase, elapsedMs: Date.now() - startedAt },
    });
    const body = await readDeployBody(req, maxBody);
    if (req.aborted || res.destroyed) return;
    if (!body.ok) return sendJson(res, body.status, { error: body.error });
    phase = 'validation';
    let parsed: ReturnType<typeof deployPreflightRequestSchema.parse>;
    try {
      const raw = JSON.parse(body.text) as unknown;
      const result = deployPreflightRequestSchema.safeParse(raw);
      if (!result.success) throw new Error(formatWireError(result.error));
      parsed = result.data;
    } catch (error) {
      return sendJson(res, 400, {
        code: 'invalid_deploy_request',
        error: `invalid deploy preflight request: ${(error as Error).message}`,
      });
    }

    const accessMode = parsed.accessMode ?? 'owner-only';
    if (isIdentityAccessMode(accessMode) && identity === undefined) {
      return sendJson(res, 401, {
        code: 'deployer_identity_required',
        error: `${accessMode} deployments require an authenticated deployer`,
      });
    }
    const ownerSelection = await authorizeDeploymentOwnerSelection(
      res,
      controlPlane,
      tenant.org,
      accessMode,
      identity,
      parsed.ownerSubject,
    );
    if (!ownerSelection.ok) return;
    const requestErrors: DeployError[] = [];
    if (accessMode === 'public' && manifestUsesUserRoot(parsed.manifest)) {
      requestErrors.push({
        code: 'public_user_context_conflict',
        path: 'accessMode',
        message: 'public access mode cannot reference ${user}; use mixed for optional identity',
      });
    }
    for (const cspFault of cspFaultsInManifest(parsed.manifest)) {
      requestErrors.push({
        code: 'invalid_widget_csp',
        path: `widgets.${cspFault.widgetIndex}.csp.${cspFault.list}.${cspFault.index}`,
        message:
          `widget "${cspFault.widget}" CSP ${cspFault.list} origin "${cspFault.value}" is not an ` +
          `absolute https:// origin and would be dropped by the host renderer` +
          (cspFault.suggestion !== undefined ? `; use "${cspFault.suggestion}"` : ''),
      });
    }

    phase = 'checks';
    timer = setTimeout(() => {
      deadlineExceeded = true;
      if (!res.headersSent && !res.destroyed)
        sendJson(res, 504, {
          code: 'deploy_preflight_timeout',
          phase,
          error: `Preflight exceeded its ${DEPLOY_PREFLIGHT_CHECK_TIMEOUT_MS}ms checking budget. Publication did not start.`,
        });
    }, DEPLOY_PREFLIGHT_CHECK_TIMEOUT_MS);
    const pending = [
      registry.getApp(tenant.org, tenant.app),
      registry.getEnvironment(tenant.org, tenant.app, tenant.env),
      registry.preflightDeploy(tenant, parsed.manifest, {
        ...(parsed.connectors !== undefined ? { connectors: parsed.connectors } : {}),
        actor: identity,
        accessMode,
        ownerSubject: ownerSelection.ownerSubject,
        ...(parsed.orgMembershipSources !== undefined
          ? { orgMembershipSources: parsed.orgMembershipSources }
          : {}),
        ...(parsed.hostedAssets !== undefined ? { hostedAssets: parsed.hostedAssets } : {}),
        ...(parsed.serverVersion !== undefined ? { serverVersion: parsed.serverVersion } : {}),
        deploymentSource: parsed.deploymentSource ?? 'cli',
      }),
    ] as const;
    const checked = await Promise.all(pending)
      .catch(async (error: unknown) => {
        // Keep the resource slot until every already-started check settles, including after a timeout.
        await Promise.allSettled(pending);
        throw error;
      })
      .finally(() => clearTimeout(timer));
    const [application, environment, preflight] = checked;
    const errors = [...requestErrors, ...(preflight.ok ? [] : preflight.errors)];
    const missingSecrets = configNames(errors, 'missing_secret', 'secrets.');
    const missingVariables = configNames(errors, 'missing_variable', 'variables.');
    const appState = application === undefined ? 'will-create' : 'existing';
    const environmentState = environment === undefined ? 'will-create' : 'existing';
    const ready = errors.length === 0;
    const codes = [...new Set(errors.map((error) => error.code))].sort().join(',');
    await audit.emit({
      eventType: 'deploy.preflight.checked',
      org: tenant.org,
      app: tenant.app,
      env: tenant.env,
      decision: 'allow',
      status: 200,
      actorSubject: identity.subject,
      ...(identity.email !== undefined ? { actorEmail: identity.email } : {}),
      details: {
        requestId,
        phase,
        elapsedMs: Date.now() - startedAt,
        clientDisconnected,
        deadlineExceeded,
        ready,
        appState,
        environmentState,
        ...(ownerSelection.ownerSubject !== undefined
          ? { ownerSubject: ownerSelection.ownerSubject }
          : {}),
        errorCount: errors.length,
        codes,
        missingSecretCount: missingSecrets.length,
        missingVariableCount: missingVariables.length,
      },
    });
    if (deadlineExceeded || clientDisconnected || res.destroyed) return;
    return sendJson(res, 200, {
      ok: true,
      ready,
      ...(ownerSelection.ownerSubject !== undefined
        ? { ownerSubject: ownerSelection.ownerSubject }
        : {}),
      target: {
        ...tenant,
        appState,
        environmentState,
      },
      config: {
        ready: missingSecrets.length === 0 && missingVariables.length === 0,
        missingSecrets,
        missingVariables,
      },
      errors,
    });
  } catch (error) {
    await audit.emit({
      eventType: 'deploy.preflight.failed',
      ...tenant,
      actorSubject: identity.subject,
      decision: 'deny',
      status: res.headersSent ? res.statusCode : 500,
      reasonCode: 'preflight_failed',
      details: {
        requestId,
        phase,
        elapsedMs: Date.now() - startedAt,
        clientDisconnected,
        deadlineExceeded,
      },
    });
    throw error;
  } finally {
    clearTimeout(timer);
    res.removeListener('close', onClose);
    activePreflights.delete(registry);
  }
}

function configNames(
  errors: readonly { readonly code: string; readonly path: string }[],
  code: string,
  prefix: string,
): string[] {
  return [
    ...new Set(
      errors
        .filter((error) => error.code === code && error.path.startsWith(prefix))
        .map((error) => error.path.slice(prefix.length))
        .filter((name) => name.length > 0),
    ),
  ].sort();
}
