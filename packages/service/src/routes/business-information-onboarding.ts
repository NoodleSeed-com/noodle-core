import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '@noodle-borg/transport-http';
import {
  SolutionInstallationOptionsQuerySchema,
  SolutionInstallationOptionsResponseSchema,
} from '@noodle-borg/wire-contracts';
import { type BusinessInformationRouteDeps, requireIdentity } from './business-information.js';
import { canManageMembers } from './org-admin.js';

/** Installation permission only. Deployment still owns transactional capacity admission. */
export async function handleSolutionInstallationOptions(
  req: IncomingMessage,
  res: ServerResponse,
  deps: BusinessInformationRouteDeps,
): Promise<void> {
  if (req.method !== 'GET') {
    res.setHeader('allow', 'GET');
    return sendJson(res, 405, { error: 'method not allowed' });
  }
  const identity = await requireIdentity(req, res, deps);
  if (identity === false) return;
  const params = new URL(req.url ?? '/', 'http://service.invalid').searchParams;
  const parsed = SolutionInstallationOptionsQuerySchema.safeParse(Object.fromEntries(params));
  if (!parsed.success || [...params.keys()].some((key) => params.getAll(key).length !== 1))
    return sendJson(res, 400, {
      error: 'invalid installation options query',
      code: 'invalid_query',
    });
  const { cursor, limit } = parsed.data;
  const after =
    cursor === undefined ? undefined : Buffer.from(cursor, 'base64url').toString('utf8');
  if (
    after !== undefined &&
    (!/^[a-z][a-z0-9-]{0,99}$/.test(after) || Buffer.from(after).toString('base64url') !== cursor)
  )
    return sendJson(res, 400, {
      error: 'invalid installation options cursor',
      code: 'invalid_query',
    });
  const organizations = identity.superAdmin
    ? await deps.controlPlane.listOrgs()
    : await deps.controlPlane.listOrgsForSubject(identity.subject);
  const eligible: { slug: string; displayName?: string }[] = [];
  for (const organization of [...organizations].sort((left, right) =>
    left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0,
  )) {
    if (after !== undefined && organization.slug <= after) continue;
    if (!(await canManageMembers(deps.controlPlane, organization.slug, identity))) continue;
    eligible.push({
      slug: organization.slug,
      ...(organization.displayName === undefined ? {} : { displayName: organization.displayName }),
    });
    if (eligible.length > limit) break;
  }
  const page = eligible.slice(0, limit);
  const last = page.at(-1);
  res.setHeader('cache-control', 'no-store');
  sendJson(
    res,
    200,
    SolutionInstallationOptionsResponseSchema.parse({
      ok: true,
      data: {
        organizations: page,
        ...(eligible.length > limit && last !== undefined
          ? { nextCursor: Buffer.from(last.slug).toString('base64url') }
          : {}),
      },
    }),
  );
}
