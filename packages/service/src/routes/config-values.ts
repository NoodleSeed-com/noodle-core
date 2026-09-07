import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ControlPlaneIdentity, DeployAuthGate } from '@noodle-borg/control-plane/portable';
import { DEVELOPER_CLI_PATH } from '@noodle-borg/developer-mcp';
import { readJsonBody, sendJson } from '@noodle-borg/transport-http';
import {
  configValueSetRequestSchema,
  EffectiveConfigResponseSchema,
  formatWireError,
  RevealSecretResponseSchema,
} from '@noodle-borg/wire-contracts';
import {
  type EffectiveConfigResponse,
  projectEffectiveConfig,
} from '../config-value-projection.js';
import { sendForbidden } from '../http-util.js';
import type { DeveloperGrantStore } from '../oauth/developer-grant.js';
import type { ServerRegistry } from '../registry.js';
import type { AuditSink } from '../store/audit.js';
import type { ConfigStore, ControlPlaneStore } from '../store.js';
import type { ConfigRouteRef } from './config-values-paths.js';
import { authorizeControlPlane, type DeveloperRouteAuthorization } from './control-plane.js';

export async function handleConfigValues(
  req: IncomingMessage,
  res: ServerResponse,
  gate: DeployAuthGate,
  controlPlane: ControlPlaneStore,
  configStore: ConfigStore,
  registry: ServerRegistry,
  maxBody: number,
  ref: ConfigRouteRef,
  audit: AuditSink,
  developerGrants?: DeveloperGrantStore,
): Promise<void> {
  const identity = await authorizeControlPlane(req, res, gate, {
    requireIdentity: true,
    ...developerConfigAccess(developerGrants, controlPlane, ref, req.method),
  });
  if (identity === false) return;
  if (ref.reveal) {
    return handleSecretReveal(res, controlPlane, configStore, registry, ref, identity, audit);
  }
  if (ref.invalid !== undefined) return sendJson(res, 400, { error: ref.invalid });
  const member =
    identity !== undefined
      ? await controlPlane.getOrgMember({
          org: ref.scope.org,
          subject: identity.subject,
        })
      : undefined;
  if (identity !== undefined && !identity.superAdmin) {
    if (!member) return sendForbidden(res, 'forbidden');
  }
  if (ref.effective) {
    // Effective reads can return variable plaintext, so even support administrators require a live explicit
    // organization membership. The legacy exact-scope paths retain their existing support-admin behavior.
    if (member === undefined) return sendForbidden(res, 'forbidden');
    if (req.method !== 'GET' || ref.name !== undefined || ref.scope.level !== 'env') {
      return sendJson(res, 404, { error: 'not found' });
    }
    return handleEffectiveConfigValues(
      res,
      controlPlane,
      configStore,
      registry,
      ref.kind,
      ref.scope,
      member,
    );
  }
  if (req.method === 'GET' && ref.name === undefined) {
    return sendJson(res, 200, {
      ok: true,
      values: await configStore.listConfigValues(ref.kind, ref.scope),
    });
  }
  if (req.method === 'PUT' && ref.name !== undefined) {
    const body = await readJsonBody(req, maxBody);
    if (!body.ok) return sendJson(res, body.status, { error: body.error });
    const parsed = configValueSetRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      return sendJson(res, 400, { error: formatWireError(parsed.error) });
    }
    try {
      const value = await configStore.setConfigValue({
        kind: ref.kind,
        scope: ref.scope,
        name: ref.name,
        value: parsed.data.value,
        ...(identity !== undefined ? { updatedBySubject: identity.subject } : {}),
        ...(identity?.email !== undefined ? { updatedByEmail: identity.email } : {}),
      });
      // Durable audit: config name + scope + actor only — the value is NEVER recorded.
      await emitConfigAudit(audit, `config.${ref.kind}.set`, ref, identity);
      return sendJson(res, 200, { ok: true, value });
    } catch (error) {
      return sendJson(res, 400, { error: (error as Error).message });
    }
  }
  if (req.method === 'DELETE' && ref.name !== undefined) {
    await configStore.deleteConfigValue(ref.kind, ref.scope, ref.name);
    await emitConfigAudit(audit, `config.${ref.kind}.deleted`, ref, identity);
    res.writeHead(204);
    res.end();
    return;
  }
  return sendJson(res, 404, { error: 'not found' });
}

/**
 * How much managed config a live developer grant may reach. Config operations follow the user's
 * current organization membership at request time:
 *
 * - reads use `cloud:read`; writes/deletes use `config:write` at org, app, or environment scope.
 * - `reveal` returns a secret's plaintext and is never delegated to a grant-bound credential.
 *
 * Returning `{}` leaves `developerAccess` unset, which `authorizeControlPlane` treats as denied for
 * a grant-bound identity and ignores for an ordinary one.
 */
function developerConfigAccess(
  grants: DeveloperGrantStore | undefined,
  controlPlane: ControlPlaneStore,
  ref: ConfigRouteRef,
  method: string | undefined,
): { developerAccess?: DeveloperRouteAuthorization } {
  if (grants === undefined || ref.reveal || ref.invalid !== undefined) return {};
  return {
    developerAccess: {
      grants,
      controlPlane,
      org: ref.scope.org,
      capability: method === 'GET' ? 'cloud:read' : 'config:write',
      resourcePaths: new Set([DEVELOPER_CLI_PATH]),
    },
  };
}

async function handleSecretReveal(
  res: ServerResponse,
  controlPlane: ControlPlaneStore,
  configStore: ConfigStore,
  registry: ServerRegistry,
  ref: ConfigRouteRef,
  identity: ControlPlaneIdentity,
  audit: AuditSink,
): Promise<void> {
  if (ref.kind !== 'secret' || ref.scope.level !== 'env' || ref.name === undefined) {
    return sendJson(res, 404, { error: 'not found' });
  }
  const { org, app, env } = ref.scope;
  const [organization, application, environment] = await Promise.all([
    controlPlane.getOrg(org),
    registry.getApp(org, app),
    registry.getEnvironment(org, app, env),
  ]);
  if (organization === undefined || application === undefined || environment === undefined) {
    await emitSecretRevealAudit(audit, ref, identity, 404, 'tenant_not_found');
    return sendJson(res, 404, { error: 'not found' });
  }
  const member = await controlPlane.getOrgMember({ org, subject: identity.subject });
  if (member?.role !== 'owner') {
    await emitSecretRevealAudit(audit, ref, identity, 403, 'owner_required');
    return sendForbidden(res, 'forbidden');
  }
  const now = Math.floor(Date.now() / 1_000);
  if (
    identity.authTime === undefined ||
    !Number.isInteger(identity.authTime) ||
    identity.authTime < 0 ||
    identity.authTime > now ||
    now - identity.authTime > 300
  ) {
    await emitSecretRevealAudit(audit, ref, identity, 403, 'fresh_auth_required');
    return sendForbidden(res, 'fresh_auth_required');
  }
  if (ref.invalid !== undefined) {
    await emitSecretRevealAudit(audit, ref, identity, 400, 'invalid_request');
    return sendJson(res, 400, { error: ref.invalid });
  }
  const [organizationValues, appValues, environmentValues, resolved] = await Promise.all([
    configStore.listConfigValues('secret', { level: 'org', org }),
    configStore.listConfigValues('secret', { level: 'app', org, app }),
    configStore.listConfigValues('secret', ref.scope),
    configStore.resolveConfigValues('secret', ref.scope, ref.name),
  ]);
  const effective = projectEffectiveConfig({
    kind: 'secret',
    organization: { id: organization.slug },
    app: { id: application.appSlug },
    environment: {
      id: environment.envName,
      name: environment.envName,
      isProduction: environment.isProduction,
    },
    organizationValues,
    appValues,
    environmentValues,
  }).find((entry) => entry.name === ref.name);
  if (effective === undefined || !Object.hasOwn(resolved, ref.name)) {
    await emitSecretRevealAudit(audit, ref, identity, 404, 'secret_not_found');
    return sendJson(res, 404, { error: 'not found' });
  }
  await emitSecretRevealAudit(audit, ref, identity, 200, 'revealed');
  return sendJson(
    res,
    200,
    RevealSecretResponseSchema.parse({
      ok: true,
      value: resolved[ref.name],
      source: effective.source,
    }),
  );
}

async function handleEffectiveConfigValues(
  res: ServerResponse,
  controlPlane: ControlPlaneStore,
  configStore: ConfigStore,
  registry: ServerRegistry,
  kind: ConfigRouteRef['kind'],
  scope: Extract<ConfigRouteRef['scope'], { readonly level: 'env' }>,
  member: Awaited<ReturnType<ControlPlaneStore['getOrgMember']>>,
): Promise<void> {
  const { org, app, env } = scope;
  try {
    const [
      organization,
      application,
      environment,
      organizationValues,
      appValues,
      environmentValues,
    ] = await Promise.all([
      controlPlane.getOrg(org),
      registry.getApp(org, app),
      registry.getEnvironment(org, app, env),
      configStore.listConfigValues(kind, { level: 'org', org }),
      configStore.listConfigValues(kind, { level: 'app', org, app }),
      configStore.listConfigValues(kind, scope),
    ]);
    if (organization === undefined || application === undefined || environment === undefined) {
      return sendJson(res, 404, { error: 'not found' });
    }
    const response: EffectiveConfigResponse = {
      kind,
      environment: {
        id: environment.envName,
        name: environment.envName,
        isProduction: environment.isProduction,
      },
      capabilities: {
        canManage: member?.role === 'owner' || member?.role === 'developer',
        canReveal: member?.role === 'owner',
      },
      entries: projectEffectiveConfig({
        kind,
        organization: { id: organization.slug },
        app: { id: application.appSlug },
        environment: {
          id: environment.envName,
          name: environment.envName,
          isProduction: environment.isProduction,
        },
        organizationValues,
        appValues,
        environmentValues,
      }),
    };
    return sendJson(res, 200, EffectiveConfigResponseSchema.parse(response));
  } catch (error) {
    return sendJson(res, 400, { error: (error as Error).message });
  }
}

/**
 * Emit a managed-config audit event. Records the scope, config name, and actor — but never the secret/variable
 * value, which must not enter the audit store (matches the no-leak contract of the audit sink).
 */
function emitConfigAudit(
  audit: AuditSink,
  eventType: string,
  ref: ConfigRouteRef,
  identity: ControlPlaneIdentity | undefined,
): Promise<void> {
  const scope = ref.scope;
  return audit.emit({
    eventType,
    org: scope.org,
    ...(scope.level !== 'org' ? { app: scope.app } : {}),
    ...(scope.level === 'env' ? { env: scope.env } : {}),
    ...(identity?.subject !== undefined ? { actorSubject: identity.subject } : {}),
    ...(identity?.email !== undefined ? { actorEmail: identity.email } : {}),
    ...(ref.name !== undefined ? { details: { kind: ref.kind, name: ref.name } } : {}),
  });
}

function emitSecretRevealAudit(
  audit: AuditSink,
  ref: ConfigRouteRef,
  identity: ControlPlaneIdentity,
  status: number,
  reason: string,
): Promise<void> {
  const scope = ref.scope;
  return audit.emit({
    eventType: reason === 'revealed' ? 'config.secret.revealed' : 'config.secret.reveal_denied',
    org: scope.org,
    ...(scope.level !== 'org' ? { app: scope.app } : {}),
    ...(scope.level === 'env' ? { env: scope.env } : {}),
    actorSubject: identity.subject,
    actorEmail: identity.email,
    decision: reason === 'revealed' ? 'allow' : 'deny',
    status,
    reasonCode: reason,
    details: {
      kind: 'secret',
      scope: 'effective',
      name: ref.name ?? '__invalid__',
      reason,
    },
  });
}
