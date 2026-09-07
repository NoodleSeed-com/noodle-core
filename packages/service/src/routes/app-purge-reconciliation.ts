import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  AppPurgeReconciliationError,
  type AppPurgeReconciliationOperator,
  type DeployAuthGate,
} from '@noodle-borg/control-plane/portable';
import { readJsonBody, sendJson } from '@noodle-borg/transport-http';
import {
  APP_PURGE_RECONCILIATION_MAX_CANDIDATES,
  AppPurgeReconciliationApplyRequestSchema,
  AppPurgeReconciliationApplyResponseSchema,
  AppPurgeReconciliationPreviewRequestSchema,
  AppPurgeReconciliationPreviewResponseSchema,
} from '@noodle-borg/wire-contracts';
import { sendForbidden } from '../http-util.js';
import { authorizeControlPlane } from './control-plane.js';

export type AppPurgeReconciliationAction = 'preview' | 'apply';

export interface AppPurgeReconciliationRouteDeps {
  readonly gate: DeployAuthGate;
  readonly operator?: AppPurgeReconciliationOperator;
  readonly releaseSha: string;
  readonly maxBody: number;
  readonly clock?: () => Date;
}

const UNAVAILABLE = {
  ok: false,
  code: 'app_purge_reconciliation_unavailable',
  error: 'app purge reconciliation is unavailable',
} as const;

/** Super-admin-only, exact-set historical repair boundary from ADR 0225. */
export async function handleAppPurgeReconciliationRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AppPurgeReconciliationRouteDeps,
  action: AppPurgeReconciliationAction,
): Promise<void> {
  const identity = await authorizeControlPlane(req, res, deps.gate, { requireIdentity: true });
  if (identity === false) return;
  if (!identity.superAdmin) return sendForbidden(res, 'super-admin required');

  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.search !== '') {
    return sendJson(res, 400, { ok: false, error: 'query parameters are not supported' });
  }
  const contentType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    return sendJson(res, 415, { ok: false, error: 'content type must be application/json' });
  }
  const body = await readJsonBody(req, deps.maxBody);
  if (!body.ok) return sendJson(res, body.status, { ok: false, error: body.error });
  const parsed =
    action === 'preview'
      ? AppPurgeReconciliationPreviewRequestSchema.safeParse(body.value)
      : AppPurgeReconciliationApplyRequestSchema.safeParse(body.value);
  if (!parsed.success) {
    return sendJson(res, 400, { ok: false, error: 'invalid app purge reconciliation request' });
  }
  if (deps.operator === undefined || !/^[0-9a-f]{40}$/.test(deps.releaseSha)) {
    return sendJson(res, 503, UNAVAILABLE);
  }

  try {
    const now = deps.clock?.() ?? new Date();
    if (action === 'preview') {
      const request = AppPurgeReconciliationPreviewRequestSchema.parse(parsed.data);
      const artifact = await deps.operator.preview({
        releaseSha: deps.releaseSha,
        limit: request.limit ?? APP_PURGE_RECONCILIATION_MAX_CANDIDATES,
        now,
      });
      return sendJson(
        res,
        200,
        AppPurgeReconciliationPreviewResponseSchema.parse({ ok: true, artifact }),
      );
    }

    const request = AppPurgeReconciliationApplyRequestSchema.parse(parsed.data);
    const response = await deps.operator.apply({
      request,
      actor: {
        subject: identity.subject,
        ...(identity.email === undefined ? {} : { email: identity.email }),
      },
      currentReleaseSha: deps.releaseSha,
      now,
    });
    return sendJson(res, 200, AppPurgeReconciliationApplyResponseSchema.parse(response));
  } catch (error) {
    if (error instanceof AppPurgeReconciliationError) {
      return sendJson(res, 409, {
        ok: false,
        code: error.code,
        error: 'app purge reconciliation request conflicts with current state',
      });
    }
    return sendJson(res, 503, UNAVAILABLE);
  }
}
