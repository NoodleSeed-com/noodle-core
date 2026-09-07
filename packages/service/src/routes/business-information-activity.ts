import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJsonBody, sendJson } from '@noodle-borg/transport-http';
import {
  ApplicationActivityListResponseSchema,
  ApplicationActivityPreviewResponseSchema,
  ApplicationActivitySettingsResponseSchema,
  ApplicationActivitySettingsSaveRequestSchema,
} from '@noodle-borg/wire-contracts';
import { ActivityPolicyError, type ApplicationActivity } from '../application-activity.js';
import { businessGrantAllows } from '../business-information/model.js';
import {
  type BusinessInformationRouteDeps,
  requireIdentity,
  requireInstallationPermission,
} from './business-information.js';
import type { SolutionInstallationRef } from './business-information-paths.js';
import { parseBusinessPaging } from './business-information-request.js';

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
  const settings = url.pathname.endsWith('/activity/settings');
  const exporting = url.pathname.endsWith('/activity/export');
  const preview = url.pathname.endsWith('/activity/preview');
  if (req.method !== 'GET' && !(settings && req.method === 'PATCH')) {
    res.setHeader('allow', settings ? 'GET, PATCH' : 'GET');
    return sendJson(res, 405, { error: 'method not allowed' });
  }
  const identity = await requireIdentity(req, res, deps);
  if (identity === false) return;
  const permission =
    req.method === 'PATCH'
      ? 'installation:administer'
      : exporting
        ? 'records:export'
        : 'records:read';
  const authorized = await requireInstallationPermission(res, ref, identity, permission, deps);
  if (!authorized) return;
  const reply = async (body: unknown): Promise<void> => {
    if (await requireInstallationPermission(res, ref, identity, permission, deps))
      sendJson(res, 200, body);
  };
  res.setHeader('cache-control', 'private, no-store');
  try {
    const allowedQuery = settings || preview ? [] : ['limit', 'cursor'];
    for (const key of url.searchParams.keys())
      if (!allowedQuery.includes(key) || url.searchParams.getAll(key).length !== 1)
        throw new ActivityPolicyError('activity_invalid');
    if (!deps.activity) throw new ActivityPolicyError('activity_unavailable');
    const canEdit = businessGrantAllows(authorized.grant, 'installation:administer');
    if (settings && req.method === 'PATCH') {
      const body = await readJsonBody(req, deps.maxBody);
      if (!body.ok) return sendJson(res, body.status, { error: body.error });
      const parsed = ApplicationActivitySettingsSaveRequestSchema.safeParse(body.value);
      if (!parsed.success) throw new ActivityPolicyError('activity_invalid');
      const data = await deps.activity.save(authorized.scope, parsed.data);
      await deps.audit?.emit({
        eventType: 'config.activity.retention_changed',
        org: ref.org,
        app: authorized.scope.app,
        env: authorized.scope.env,
        actorSubject: identity.subject,
        details: { retentionDays: data.retentionDays },
      });
      return reply(ApplicationActivitySettingsResponseSchema.parse({ ok: true, data }));
    }
    if (preview)
      return reply(
        ApplicationActivityPreviewResponseSchema.parse({
          ok: true,
          data: await deps.activity.preview(authorized.scope),
        }),
      );
    if (settings)
      return reply(
        ApplicationActivitySettingsResponseSchema.parse({
          ok: true,
          data: (await deps.activity.settings(authorized.scope, canEdit)).projection,
        }),
      );
    const paging = parseBusinessPaging(url, 100);
    if (!paging.ok) return sendJson(res, 400, { error: paging.error });
    const data = await deps.activity.page(authorized.scope, {
      purpose: exporting ? 'export' : 'list',
      limit: paging.value.limit ?? 50,
      ...(paging.value.cursor === undefined ? {} : { cursor: paging.value.cursor }),
    });
    return reply(ApplicationActivityListResponseSchema.parse({ ok: true, data }));
  } catch (error) {
    if (!(error instanceof ActivityPolicyError)) throw error;
    sendJson(
      res,
      error.code === 'activity_unavailable' ? 503 : error.code === 'activity_conflict' ? 409 : 400,
      { code: error.code, error: error.message },
    );
  }
}
