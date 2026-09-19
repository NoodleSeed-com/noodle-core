import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJsonBody, sendJson } from '@noodle-borg/transport-http';
import {
  NativeRecordLifecycleMigrateRequestSchema,
  NativeRecordLifecyclePreviewResponseSchema,
  NativeRecordLifecycleResponseSchema,
} from '@noodle-borg/wire-contracts';
import { NativeLifecycleError } from '../business-information/native-record-lifecycle.js';
import {
  type BusinessInformationRouteDeps,
  invalid,
  methodNotAllowed,
  requireIdentity,
  requireInstallationPermission,
} from './business-information.js';
import type { SolutionInstallationRef } from './business-information-paths.js';

export async function handleNativeRecordLifecycle(
  req: IncomingMessage,
  res: ServerResponse,
  ref: SolutionInstallationRef,
  deps: BusinessInformationRouteDeps,
): Promise<void> {
  res.setHeader('cache-control', 'private, no-store');
  if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res);
  const identity = await requireIdentity(req, res, deps);
  if (identity === false) return;
  const authorized = await requireInstallationPermission(
    res,
    ref,
    identity,
    'installation:administer',
    deps,
  );
  if (!authorized) return;
  try {
    if (req.method === 'GET') {
      const data = await deps.store.nativeLifecycle.preview(authorized.scope, identity.subject);
      return sendJson(
        res,
        200,
        NativeRecordLifecyclePreviewResponseSchema.parse({ ok: true, data }),
      );
    }
    const body = await readJsonBody(req, deps.maxBody);
    if (!body.ok) return sendJson(res, body.status, { error: body.error });
    const parsed = NativeRecordLifecycleMigrateRequestSchema.safeParse(body.value);
    if (!parsed.success) return invalid(res, parsed.error);
    const data = await deps.store.nativeLifecycle.migrate({
      scope: authorized.scope,
      actor: identity.subject,
      preview: parsed.data.preview,
    });
    return sendJson(res, 200, NativeRecordLifecycleResponseSchema.parse({ ok: true, data }));
  } catch (error) {
    if (!(error instanceof NativeLifecycleError)) throw error;
    return sendJson(
      res,
      error.code === 'lifecycle_denied' ? 403 : error.code === 'lifecycle_conflict' ? 409 : 503,
      {
        code: error.code,
        error:
          error.code === 'lifecycle_conflict'
            ? 'The reviewed inventory changed or expired. Review again before applying the migration.'
            : error.code === 'lifecycle_denied'
              ? 'Current Owner or Admin permission is required.'
              : 'Native record lifecycle is unavailable.',
      },
    );
  }
}
