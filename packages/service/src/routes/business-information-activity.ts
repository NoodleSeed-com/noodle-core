import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJsonBody, sendJson } from '@noodle-borg/transport-http';
import {
  ActivityPolicyError,
  type ActivityProjectionAction,
  type ApplicationActivity,
} from '../application-activity.js';
import { businessGrantAllows } from '../business-information/model.js';
import {
  type BusinessInformationRouteDeps,
  requireIdentity,
  requireInstallationPermission,
} from './business-information.js';
import type { SolutionInstallationRef } from './business-information-paths.js';

export interface BusinessActivityRouteDeps extends BusinessInformationRouteDeps {
  readonly activity?: ApplicationActivity;
}
export async function handleApplicationActivity(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ref: SolutionInstallationRef,
  deps: BusinessActivityRouteDeps,
): Promise<void> {
  const coordination = ref.action === 'coordination';
  const suffix = url.pathname.split('/').at(-1);
  const action: ActivityProjectionAction = coordination
    ? suffix === 'resolve'
      ? 'coordination-resolve'
      : 'coordination-list'
    : suffix === 'settings'
      ? req.method === 'PATCH'
        ? 'save-settings'
        : 'settings'
      : suffix === 'preview' || suffix === 'export'
        ? suffix
        : 'list';
  const allowed = coordination
    ? suffix === 'resolve'
      ? ['POST']
      : ['GET']
    : suffix === 'settings'
      ? ['GET', 'PATCH']
      : ['GET'];
  if (!allowed.includes(req.method ?? '')) {
    res.setHeader('allow', allowed.join(', '));
    return sendJson(res, 405, { error: 'method not allowed' });
  }
  const identity = await requireIdentity(req, res, deps);
  if (identity === false) return;
  const permission =
    coordination || action === 'save-settings'
      ? 'installation:administer'
      : action === 'export'
        ? 'records:export'
        : 'records:read';
  const authorize = () => requireInstallationPermission(res, ref, identity, permission, deps);
  const authorized = await authorize();
  if (!authorized) return;
  res.setHeader('cache-control', 'private, no-store');
  try {
    if (!deps.activity)
      throw new ActivityPolicyError(
        coordination ? 'coordination_unavailable' : 'activity_unavailable',
      );
    let body: unknown;
    if (req.method !== 'GET') {
      const parsed = await readJsonBody(req, deps.maxBody);
      if (!parsed.ok) return sendJson(res, parsed.status, { error: parsed.error });
      body = parsed.value;
      if (!(await authorize())) return;
    }
    const result = await deps.activity.project(authorized.scope, action, {
      parameters: [...url.searchParams.entries()],
      body,
      reviewer: identity.subject,
      canEdit: businessGrantAllows(authorized.grant, 'installation:administer'),
    });
    if ('audit' in result)
      await deps.audit?.emit({
        ...result.audit,
        org: ref.org,
        app: authorized.scope.app,
        env: authorized.scope.env,
        actorSubject: identity.subject,
      });
    if (await authorize()) sendJson(res, 200, result.response);
  } catch (error) {
    if (!(error instanceof ActivityPolicyError)) throw error;
    sendJson(
      res,
      error.code.endsWith('_unavailable') ? 503 : error.code.endsWith('_conflict') ? 409 : 400,
      { code: error.code, error: error.message },
    );
  }
}
