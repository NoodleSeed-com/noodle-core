import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DailyCounterStore } from '@noodle-borg/admission-limits/portable';
import type { DeployAuthGate } from '@noodle-borg/control-plane/portable';
import { readJsonBody, sendJson } from '@noodle-borg/transport-http';
import {
  APPLICATION_DRAFT_LIMITS,
  ApplicationDraftCreateRequestSchema,
  ApplicationDraftDiffRequestSchema,
  ApplicationDraftDiffResponseSchema,
  ApplicationDraftEditRequestSchema,
  ApplicationDraftHistoryResponseSchema,
  ApplicationDraftListResponseSchema,
  ApplicationDraftResponseSchema,
  ApplicationDraftRevisionRequestSchema,
  ApplicationDraftUndoRequestSchema,
  ApplicationDraftValidationResponseSchema,
} from '@noodle-borg/wire-contracts';
import type { ApplicationDraftCompiler } from '../application-drafts/compiler.js';
import {
  ApplicationDraftError,
  DraftValidationUnavailableError,
} from '../application-drafts/contracts.js';
import { applicationDraftMethods, parseApplicationDraftPath } from '../application-drafts/paths.js';
import type { ApplicationDraftStore } from '../application-drafts/store.js';
import { admitBusinessTarget, authorizeBusinessApi } from '../business-api-admission.js';
import type { BusinessWorkspaceStore } from '../business-workspaces/store.js';
import { requestIdempotencyKey } from './business-information-request.js';

export interface ApplicationDraftRouteDeps {
  readonly drafts: ApplicationDraftStore;
  readonly workspaces: BusinessWorkspaceStore;
  readonly gate: DeployAuthGate;
  readonly publicCounters: DailyCounterStore;
  readonly maxBody: number;
  readonly now?: () => Date;
  readonly compiler?: Pick<ApplicationDraftCompiler, 'compile'>;
}

/** This bounded authoring surface never forwards a Portal token to general deployment/secrets APIs. */
export async function handleApplicationDraftRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: ApplicationDraftRouteDeps,
): Promise<void> {
  res.setHeader('cache-control', 'private, no-store');
  try {
    await handle(req, res, url, deps);
  } catch (error) {
    if (error instanceof DraftValidationUnavailableError) {
      if (error.code === 'busy') res.setHeader('retry-after', '2');
      return sendJson(res, error.code === 'busy' ? 429 : 503, {
        code: error.code === 'busy' ? 'validation_busy' : 'validation_unavailable',
        error: 'Draft validation is temporarily unavailable. Nothing was published.',
      });
    }
    if (error instanceof ApplicationDraftError) {
      const status =
        error.code === 'forbidden'
          ? 403
          : error.code === 'not_found'
            ? 404
            : error.code === 'draft_deleted'
              ? 410
              : error.code === 'invalid_draft'
                ? 400
                : 409;
      return sendJson(res, status, {
        error: error.code.replaceAll('_', ' '),
        code: error.code,
        ...(error.currentRevision === undefined ? {} : { currentRevision: error.currentRevision }),
      });
    }
    // Do not reflect compiler/source/cipher errors or log their customer-controlled messages.
    return sendJson(res, 503, {
      error: 'Draft storage is temporarily unavailable.',
      code: 'drafts_unavailable',
    });
  }
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: ApplicationDraftRouteDeps,
) {
  const ref = parseApplicationDraftPath(url.pathname);
  if (!ref) return sendJson(res, 404, { error: 'draft route not found' });
  const { org, app, id, action } = ref;
  const identity = await authorizeBusinessApi(req, res, deps);
  if (!identity) return;
  const permission = req.method === 'GET' ? 'drafts:read' : 'drafts:edit';
  if ((await deps.workspaces.authorize(org, identity.subject, permission)) !== 'allowed') {
    return sendJson(res, 403, { error: 'Workspace draft permission required.', code: 'forbidden' });
  }
  if (!(await admitBusinessTarget(res, { org }))) return;
  const scope = { org, app },
    actorSubject = identity.subject;
  if (id && req.method === 'GET' && action === 'history') {
    if ([...url.searchParams].length) return invalid(res);
    const revisions = await deps.drafts.history(scope, id, actorSubject);
    return sendJson(
      res,
      200,
      ApplicationDraftHistoryResponseSchema.parse({ ok: true, data: { revisions } }),
    );
  }
  if (id && req.method === 'GET' && action === 'diff') {
    if (
      [...url.searchParams].length !== 2 ||
      [...url.searchParams].some(
        ([key, value]) => !['from', 'to'].includes(key) || !/^[1-9]\d{0,9}$/.test(value),
      )
    )
      return invalid(res);
    const parsed = ApplicationDraftDiffRequestSchema.safeParse({
      from: Number(url.searchParams.get('from')),
      to: Number(url.searchParams.get('to')),
    });
    if (!parsed.success) return invalid(res);
    const diff = await deps.drafts.diff(scope, id, actorSubject, parsed.data.from, parsed.data.to);
    return sendJson(
      res,
      200,
      ApplicationDraftDiffResponseSchema.parse({ ok: true, data: { diff } }),
    );
  }
  if (req.method === 'GET' && action === undefined) {
    if (id === undefined) {
      if ([...url.searchParams].length) return invalid(res);
      const drafts = await deps.drafts.list(scope, actorSubject);
      return sendJson(
        res,
        200,
        ApplicationDraftListResponseSchema.parse({ ok: true, data: { drafts } }),
      );
    }
    const queries = [...url.searchParams];
    const value = url.searchParams.get('revision');
    if (
      queries.length > 1 ||
      queries.some(([key]) => key !== 'revision') ||
      (value !== null && (!/^[1-9]\d{0,9}$/.test(value) || Number(value) > 2147483647))
    )
      return invalid(res);
    const draft = await deps.drafts.get(
      scope,
      id,
      actorSubject,
      value === null ? undefined : Number(value),
    );
    return sendJson(res, 200, ApplicationDraftResponseSchema.parse({ ok: true, data: { draft } }));
  }
  const allowed = applicationDraftMethods(ref);
  if (!allowed.includes(req.method ?? '')) {
    res.setHeader('allow', allowed.join(', '));
    return sendJson(res, 405, { error: 'method not allowed' });
  }
  if ([...url.searchParams].length) return invalid(res);
  const body = await readJsonBody(
    req,
    Math.min(deps.maxBody, APPLICATION_DRAFT_LIMITS.totalBytes * 6 + 32_768),
  );
  if (!body.ok) return sendJson(res, body.status, { error: body.error });
  if (id && action === 'validate' && req.method === 'POST') {
    const parsed = ApplicationDraftRevisionRequestSchema.safeParse(body.value);
    if (!parsed.success) return invalid(res);
    if (!deps.compiler)
      return sendJson(res, 503, {
        code: 'validation_unavailable',
        error: 'Draft validation is not configured. Nothing was published.',
      });
    const input = { scope, id, actorSubject, expectedRevision: parsed.data.expectedRevision };
    const draft = await deps.drafts.forValidation(input);
    const result = await deps.compiler.compile(draft.source);
    // Do not hold a database lock during customer compilation. Recheck under the authority lock afterwards.
    const current = await deps.drafts.forValidation(input);
    if (
      current.sourceDigest !== draft.sourceDigest ||
      (result.ok && result.sourceDigest !== draft.sourceDigest)
    )
      throw new ApplicationDraftError('revision_conflict', current.revision);
    const validation = {
      draftId: id,
      revision: draft.revision,
      sourceDigest: draft.sourceDigest,
      check: 'source-and-manifest',
      published: false,
      ...(result.ok
        ? {
            status: 'valid',
            compilerDigest: result.compilerDigest,
            artifactDigest: result.artifactDigest,
            issues: [],
          }
        : { status: 'invalid', issues: result.issues }),
    };
    return sendJson(
      res,
      200,
      ApplicationDraftValidationResponseSchema.parse({ ok: true, data: { validation } }),
    );
  }
  if (id !== undefined && req.method === 'DELETE') {
    const parsed = ApplicationDraftRevisionRequestSchema.safeParse(body.value);
    if (!parsed.success) return invalid(res);
    await deps.drafts.remove({
      scope,
      id,
      actorSubject,
      expectedRevision: parsed.data.expectedRevision,
    });
    res.writeHead(204);
    res.end();
    return;
  }
  const idempotencyKey = requestIdempotencyKey(req);
  if (!idempotencyKey) return invalid(res);
  if (id === undefined && req.method === 'POST') {
    const parsed = ApplicationDraftCreateRequestSchema.safeParse(body.value);
    if (!parsed.success) return invalid(res);
    const draft = await deps.drafts.create({
      scope,
      actorSubject,
      idempotencyKey,
      environment: parsed.data.environment,
      source: parsed.data.source,
      ...(parsed.data.baseRelease === undefined ? {} : { baseRelease: parsed.data.baseRelease }),
    });
    return sendJson(res, 201, ApplicationDraftResponseSchema.parse({ ok: true, data: { draft } }));
  }
  if (id && req.method === 'PATCH') {
    const parsed = ApplicationDraftEditRequestSchema.safeParse(body.value);
    if (!parsed.success) return invalid(res);
    const draft = await deps.drafts.edit({
      scope,
      id,
      actorSubject,
      idempotencyKey,
      ...parsed.data,
    });
    return sendJson(res, 200, ApplicationDraftResponseSchema.parse({ ok: true, data: { draft } }));
  }
  if (id && action === 'undo' && req.method === 'POST') {
    const parsed = ApplicationDraftUndoRequestSchema.safeParse(body.value);
    if (!parsed.success) return invalid(res);
    const draft = await deps.drafts.undo({
      scope,
      id,
      actorSubject,
      idempotencyKey,
      ...parsed.data,
    });
    return sendJson(res, 200, ApplicationDraftResponseSchema.parse({ ok: true, data: { draft } }));
  }
  return invalid(res);
}

function invalid(res: ServerResponse): void {
  sendJson(res, 400, {
    error: 'Invalid draft request. Review the source, revision and retry key.',
    code: 'invalid_draft',
  });
}
