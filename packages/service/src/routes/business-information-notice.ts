import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJsonBody, sendJson } from '@noodle-borg/transport-http';
import {
  BusinessNoticeResponseSchema,
  BusinessNoticeSaveRequestSchema,
  OrganizationAgreementAcceptRequestSchema,
  OrganizationAgreementResponseSchema,
} from '@noodle-borg/wire-contracts';
import { admitBusinessTarget } from '../business-api-admission.js';
import type { BusinessOnboarding } from '../business-onboarding.js';
import { sendForbidden } from '../http-util.js';
import {
  type BusinessInformationRouteDeps,
  invalid,
  methodNotAllowed,
  requireIdentity,
  requireInstallationGrant,
  requireInstallationPermission,
} from './business-information.js';
import type { SolutionInstallationRef } from './business-information-paths.js';
import { canManageMembers } from './org-admin.js';

export async function handleOrganizationAgreement(
  req: IncomingMessage,
  res: ServerResponse,
  org: string,
  deps: BusinessInformationRouteDeps,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res);
  const identity = await requireIdentity(req, res, deps);
  if (identity === false) return;
  if (!(await canManageMembers(deps.controlPlane, org, identity)))
    return sendForbidden(res, 'organization owner required');
  if (!(await admitBusinessTarget(res, { org }))) return;
  const onboarding: BusinessOnboarding | undefined = deps.businessOnboarding;
  if (!onboarding)
    return sendJson(res, 503, {
      code: 'business_setup_unavailable',
      error: 'Business agreement configuration is unavailable.',
    });
  let status = await onboarding.status(org, identity.subject);
  if (req.method === 'POST') {
    const body = await readJsonBody(req, deps.maxBody);
    if (!body.ok) return sendJson(res, body.status, { error: body.error });
    const parsed = OrganizationAgreementAcceptRequestSchema.safeParse(body.value);
    if (!parsed.success) return invalid(res, parsed.error);
    status = await onboarding.accept(org, identity.subject, parsed.data);
  }
  return sendJson(res, 200, OrganizationAgreementResponseSchema.parse({ ok: true, data: status }));
}

export async function handleBusinessNotice(
  req: IncomingMessage,
  res: ServerResponse,
  ref: SolutionInstallationRef,
  deps: BusinessInformationRouteDeps,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'PUT') return methodNotAllowed(res);
  const identity = await requireIdentity(req, res, deps);
  if (identity === false) return;
  const authorized =
    req.method === 'PUT'
      ? await requireInstallationPermission(res, ref, identity, 'installation:administer', deps)
      : await requireInstallationGrant(res, ref, identity, deps);
  if (!authorized) return;
  let record = await deps.store.getBusinessNotice(authorized.scope);
  if (req.method === 'PUT') {
    const body = await readJsonBody(req, deps.maxBody);
    if (!body.ok) return sendJson(res, body.status, { error: body.error });
    const parsed = BusinessNoticeSaveRequestSchema.safeParse(body.value);
    if (!parsed.success) return invalid(res, parsed.error);
    record = await deps.store.setBusinessNotice({
      scope: authorized.scope,
      ...parsed.data,
      actorSubject: identity.subject,
    });
  }
  return sendJson(
    res,
    200,
    BusinessNoticeResponseSchema.parse({
      ok: true,
      data: {
        revision: record?.revision ?? 0,
        notice: record?.notice ?? null,
        canEdit: authorized.grant.role === 'administrator',
      },
    }),
  );
}
