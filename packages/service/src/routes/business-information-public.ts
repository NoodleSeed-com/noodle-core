import type { IncomingMessage, ServerResponse } from 'node:http';
import { publicAdmissionRequestDigest } from '@noodle-borg/admission-limits/portable';
import { readJsonBody, sendJson } from '@noodle-borg/transport-http';
import { ManagedRecordCreateRequestSchema } from '@noodle-borg/wire-contracts';
import { creationPayload } from '../business-information/collection-controls.js';
import {
  idempotencyDigest,
  PayloadValidationError,
  requestFingerprint,
  validateManagedPayload,
} from '../business-information/portable.js';
import {
  type BusinessInformationRouteDeps,
  createNativeRecord,
  idempotencyConflict,
  invalid,
  methodNotAllowed,
  now,
} from './business-information.js';
import { consumePublicIntakeQuota } from './business-information-admission.js';
import type { PublicSolutionIntakeRef } from './business-information-paths.js';
import { requestIdempotencyKey } from './business-information-request.js';
import { collectionToPublicWire } from './business-information-wire.js';

const MAX_PUBLIC_INTAKE_BODY_BYTES = 32 * 1024;

/** Anonymous, quota-bound creation for an installation's explicitly enabled native collection. */
export async function handlePublicSolutionIntake(
  req: IncomingMessage,
  res: ServerResponse,
  ref: PublicSolutionIntakeRef,
  deps: BusinessInformationRouteDeps,
): Promise<void> {
  if (deps.publicIntakeEnabled === false) {
    return sendJson(res, 503, {
      error: 'public intake is temporarily disabled',
      code: 'intake_disabled',
    });
  }
  const installation = await deps.store.resolveInstallationByPublicId(ref.publicId);
  if (installation === undefined) return sendJson(res, 404, { error: 'solution not found' });
  if (deps.businessOnboarding && !(await deps.businessOnboarding.ready(installation)))
    return sendJson(res, 409, {
      code: 'business_setup_required',
      error: 'This business has not completed application setup.',
    });
  if (!installation.intakeActive && req.method === 'GET') {
    return sendJson(res, 503, { error: 'public intake is paused', code: 'intake_paused' });
  }
  const publicCollection = installation.definition.collections.find(
    (candidate) =>
      installation.managedCollections.includes(candidate.key) &&
      candidate.authority.authority === 'native',
  );
  if (req.method === 'GET' && ref.collection === undefined) {
    const notice = await deps.store.getBusinessNotice(installation.scope);
    if (publicCollection === undefined)
      return sendJson(res, 404, { error: 'public intake unavailable' });
    return sendJson(res, 200, {
      ok: true,
      data: {
        publicId: installation.publicId,
        ...(notice ? { businessNotice: notice.notice } : {}),
        title: installation.definition.title,
        description: installation.definition.description.slice(0, 240),
        collection: collectionToPublicWire(publicCollection),
      },
    });
  }
  if (req.method === 'POST' && ref.collection !== undefined) {
    if (publicCollection === undefined || publicCollection.key !== ref.collection) {
      return sendJson(res, 404, { error: 'public intake unavailable' });
    }
    const idempotencyKey = requestIdempotencyKey(req);
    if (idempotencyKey === undefined) {
      return sendJson(res, 400, { error: 'Idempotency-Key header is required (1-128 characters)' });
    }
    const body = await readJsonBody(req, Math.min(deps.maxBody, MAX_PUBLIC_INTAKE_BODY_BYTES));
    if (!body.ok) return sendJson(res, body.status, { error: body.error });
    const parsed = ManagedRecordCreateRequestSchema.safeParse(body.value);
    if (!parsed.success) return invalid(res, parsed.error);
    let payload: ReturnType<typeof validateManagedPayload>;
    try {
      creationPayload(publicCollection, parsed.data.payload, true);
      payload = validateManagedPayload(parsed.data.payload);
    } catch (error) {
      if (!(error instanceof PayloadValidationError)) throw error;
      return sendJson(res, 400, {
        error: error.message,
        code: error.code,
      });
    }
    const origin = { kind: 'embedded' as const, reference: 'public-intake' };
    const requestInput = {
      scope: installation.scope,
      collectionKey: ref.collection,
      idempotencyKey,
      payload,
      origin,
      actorSubject: 'anonymous',
    };
    const completed = await deps.store.probeRequest(requestInput);
    if (completed.disposition === 'conflict') return idempotencyConflict(res);
    if (completed.disposition === 'replayed') {
      return sendJson(res, 200, {
        ok: true,
        data: { recordId: completed.record.id, receivedAt: completed.record.createdAt },
      });
    }
    const quota = await consumePublicIntakeQuota(
      req,
      ref.publicId,
      {
        key: `solution-intake:logical:${ref.publicId}:${idempotencyDigest(idempotencyKey)}`,
        fingerprint: requestFingerprint({
          collectionKey: ref.collection,
          payload,
          origin,
          actorSubject: 'anonymous',
        }),
      },
      deps,
      {
        surfaceId: ref.publicId,
        installationId: installation.scope.installationId,
        route: new URL(req.url ?? '/', 'http://localhost').pathname,
        method: 'POST',
        idempotencyKey,
        requestDigest: publicAdmissionRequestDigest(JSON.stringify(body.value)),
      },
    );
    if (!quota.allowed) {
      if (quota.reason === 'invalid_attribution')
        return sendJson(res, 403, {
          error: 'public admission attribution is invalid',
          code: 'invalid_attribution',
        });
      if (quota.reason === 'admission_unavailable') {
        return sendJson(res, 503, {
          error: 'public intake admission is temporarily unavailable',
          code: 'admission_unavailable',
        });
      }
      if (quota.reason === 'idempotency_conflict') return idempotencyConflict(res);
      res.setHeader(
        'retry-after',
        String(Math.max(1, Math.ceil((quota.resetAt.getTime() - now(deps).getTime()) / 1000))),
      );
      return sendJson(res, 429, {
        error: 'public intake limit exceeded',
        code: 'quota_exceeded',
        limits: quota.limits.map((limit) => ({ ...limit, resetAt: limit.resetAt.toISOString() })),
      });
    }
    const result = await createNativeRecord(res, deps, {
      installation,
      collection: requestInput.collectionKey,
      idempotencyKey: requestInput.idempotencyKey,
      payload: requestInput.payload,
      origin: requestInput.origin,
      actorSubject: requestInput.actorSubject,
    });
    if (result === undefined) return;
    if (result.disposition === 'conflict') return idempotencyConflict(res);
    if (result.disposition === 'paused') {
      return sendJson(res, 503, { error: 'public intake is paused', code: 'intake_paused' });
    }
    return sendJson(res, result.disposition === 'created' ? 201 : 200, {
      ok: true,
      data: { recordId: result.record.id, receivedAt: result.record.createdAt },
    });
  }
  return methodNotAllowed(res);
}
