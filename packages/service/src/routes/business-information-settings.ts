import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJsonBody, sendJson } from '@noodle-borg/transport-http';
import {
  ApplicationSettingsResponseSchema,
  ApplicationSettingsSaveRequestSchema,
} from '@noodle-borg/wire-contracts';
import {
  ApplicationSettings,
  installationSettingsTarget,
  SettingsError,
} from '../application-settings.js';
import { resolveSettingsTargets } from '../application-settings-targets.js';
import { businessGrantAllows } from '../business-information/model.js';
import type { ServerRegistry } from '../registry.js';
import type { ConfigStore } from '../store.js';
import {
  type BusinessInformationRouteDeps,
  requireIdentity,
  requireInstallationPermission,
} from './business-information.js';
import type { SolutionInstallationRef } from './business-information-paths.js';

export async function handleBusinessSettings(
  req: IncomingMessage,
  res: ServerResponse,
  ref: SolutionInstallationRef,
  deps: BusinessInformationRouteDeps & {
    readonly configStore?: ConfigStore;
    readonly registry?: ServerRegistry;
  },
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'PATCH') {
    res.setHeader('allow', 'GET, PATCH');
    return sendJson(res, 405, { error: 'method not allowed' });
  }
  const identity = await requireIdentity(req, res, deps);
  if (identity === false) return;
  const authorized = await requireInstallationPermission(
    res,
    ref,
    identity,
    req.method === 'PATCH' ? 'installation:administer' : 'records:read',
    deps,
  );
  if (authorized === undefined) return;
  if (deps.configStore?.transactConfig === undefined)
    return sendJson(res, 503, {
      code: 'settings_unavailable',
      error: 'Atomic configuration storage is unavailable.',
    });
  const target = installationSettingsTarget(authorized.installation);
  const settings = new ApplicationSettings(deps.configStore);
  const canEdit = businessGrantAllows(authorized.grant, 'installation:administer');
  res.setHeader('cache-control', 'private, no-store');
  try {
    if (req.method === 'GET') {
      await settings.initialize(target);
      return sendJson(
        res,
        200,
        ApplicationSettingsResponseSchema.parse({
          ok: true,
          data: await settings.read(target, canEdit),
        }),
      );
    }
    const body = await readJsonBody(req, deps.maxBody);
    if (!body.ok) return sendJson(res, body.status, { error: body.error });
    const parsed = ApplicationSettingsSaveRequestSchema.safeParse(body.value);
    if (!parsed.success)
      return sendJson(res, 400, { code: 'settings_invalid', error: 'Invalid settings update.' });
    const registry = deps.registry;
    const data = await settings.save(
      target,
      parsed.data,
      identity.subject,
      registry ? () => resolveSettingsTargets(registry, target.scope, deps.store) : undefined,
    );
    await deps.audit?.emit({
      eventType: 'config.variable.business_settings_changed',
      org: authorized.scope.org,
      app: authorized.scope.app,
      env: authorized.scope.env,
      actorSubject: identity.subject,
      details: {
        revision: data.revision,
        changedKeys: [...Object.keys(parsed.data.values), ...(parsed.data.resetKeys ?? [])]
          .sort()
          .join(','),
      },
    });
    sendJson(res, 200, ApplicationSettingsResponseSchema.parse({ ok: true, data }));
  } catch (error) {
    if (!(error instanceof SettingsError)) throw error;
    sendJson(
      res,
      error.code === 'settings_conflict' ? 409 : error.code === 'settings_unavailable' ? 503 : 400,
      { code: error.code, error: error.message },
    );
  }
}
