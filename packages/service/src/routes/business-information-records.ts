import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJsonBody, sendJson } from '@noodle-borg/transport-http';
import {
  ManagedRecordCreateRequestSchema,
  ManagedRecordMutationRequestSchema,
  ManagedRecordStatusSchema,
} from '@noodle-borg/wire-contracts';
import { admitBusinessMutation } from '../business-api-admission.js';
import {
  type BusinessInformationStore,
  businessGrantAllows,
  type ManagedRequestOperation,
  PayloadValidationError,
} from '../business-information/portable.js';
import {
  type BusinessInformationRouteDeps,
  enabledCollection,
  idempotencyConflict,
  invalid,
  methodNotAllowed,
  mutationFailure,
  now,
} from './business-information.js';
import {
  requireIdentity,
  requireInstallationPermission,
  resolveBusinessStaffGrant,
  runBusinessStaffOperation,
} from './business-information-access.js';
import {
  loadExternalRecord,
  sendExternalRecordPage,
  sourceBindingKey,
  unsupportedExternalOperation,
} from './business-information-external.js';
import type { SolutionInstallationRef } from './business-information-paths.js';
import { createNativeRecord } from './business-information-record-create.js';
import { cursorRequest, sendNativeRecordActivity } from './business-information-record-reads.js';
import {
  expectedRevision,
  mutationPermission,
  parseNativeRecordQuery,
  parseBusinessPaging as parsePaging,
  requestIdempotencyKey,
} from './business-information-request.js';
import {
  collectionToWire,
  externalRecordToWire,
  recordDetailToWire,
  recordToWire,
} from './business-information-wire.js';

export async function handleManagedRecords(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ref: SolutionInstallationRef,
  deps: BusinessInformationRouteDeps,
): Promise<void> {
  const identity = await requireIdentity(req, res, deps);
  if (identity === false) return;
  if (ref.collection === undefined) return sendJson(res, 404, { error: 'not found' });
  const collection = ref.collection;
  if (ref.action === 'activity' && req.method === 'GET' && ref.recordId !== undefined) {
    const authorized = await requireInstallationPermission(
      res,
      ref,
      identity,
      'records:read',
      deps,
    );
    if (authorized === undefined) return;
    const definition = enabledCollection(res, authorized.installation, collection);
    if (definition === undefined) return;
    if (definition.authority.authority === 'external') {
      return sendJson(res, 200, { ok: true, data: { activities: [] } });
    }
    return sendNativeRecordActivity(
      res,
      url,
      authorized.installation.scope,
      collection,
      ref.recordId,
      deps.store,
      identity.subject,
    );
  }
  if (ref.action === 'export' && req.method === 'GET') {
    const authorized = await requireInstallationPermission(
      res,
      ref,
      identity,
      'records:export',
      deps,
    );
    if (authorized === undefined) return;
    const definition = enabledCollection(res, authorized.installation, collection);
    if (definition === undefined) return;
    const paging = parsePaging(url, 500);
    if (!paging.ok) return sendJson(res, 400, { error: paging.error });
    if (definition.authority.authority === 'external') {
      return sendExternalRecordPage(
        res,
        authorized.installation,
        definition,
        { ...paging.value, limit: paging.value.limit ?? 500 },
        deps,
      );
    }
    const page = await cursorRequest(res, () =>
      runBusinessStaffOperation(deps, authorized.scope, identity.subject, 'records:export', () =>
        deps.store.exportRequests({
          scope: authorized.installation.scope,
          collectionKey: collection,
          ...paging.value,
          includeDeleted: url.searchParams.get('includeDeleted') === 'true',
        }),
      ),
    );
    if (page === undefined) return;
    return sendJson(res, 200, {
      ok: true,
      data: {
        records: page.records.map((record) => ({
          ...recordToWire(record),
          ...(record.content ? { notes: record.content.notes } : {}),
        })),
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      },
    });
  }
  if (ref.recordId === undefined && req.method === 'GET') {
    const authorized = await requireInstallationPermission(
      res,
      ref,
      identity,
      'records:read',
      deps,
    );
    if (authorized === undefined) return;
    const definition = enabledCollection(res, authorized.installation, collection);
    if (definition === undefined) return;
    const paging = parsePaging(url, 100);
    if (!paging.ok) return sendJson(res, 400, { error: paging.error });
    const query = parseNativeRecordQuery(url);
    if (!query.ok) return sendJson(res, 400, { error: query.error, code: 'invalid_query' });
    if (definition.authority.authority === 'external') {
      if (Object.keys(query.value).length > 0)
        return sendJson(res, 400, {
          error: 'Field and date queries currently require a native collection.',
          code: 'invalid_query',
        });
      return sendExternalRecordPage(res, authorized.installation, definition, paging.value, deps);
    }
    const statusValue = url.searchParams.get('status');
    const status =
      statusValue === null ? undefined : ManagedRecordStatusSchema.safeParse(statusValue);
    if (status !== undefined && !status.success)
      return sendJson(res, 400, { error: 'invalid status' });
    const assigneeSubject = url.searchParams.get('assigneeSubject') ?? undefined;
    const page = await cursorRequest(res, () =>
      runBusinessStaffOperation(deps, authorized.scope, identity.subject, 'records:read', () =>
        deps.store.listRequests({
          scope: authorized.installation.scope,
          collectionKey: collection,
          ...paging.value,
          ...query.value,
          ...(status === undefined ? {} : { status: status.data }),
          ...(assigneeSubject === undefined ? {} : { assigneeSubject }),
          includeDeleted: url.searchParams.get('includeDeleted') === 'true',
        }),
      ),
    );
    if (page === undefined) return;
    return sendJson(res, 200, {
      ok: true,
      data: {
        records: page.records.map(recordToWire),
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      },
    });
  }
  if (ref.recordId === undefined && req.method === 'POST') {
    const authorized = await requireInstallationPermission(
      res,
      ref,
      identity,
      'records:create',
      deps,
    );
    if (authorized === undefined) return;
    const definition = enabledCollection(res, authorized.installation, collection);
    if (definition === undefined) return;
    if (definition.authority.authority === 'external') {
      return unsupportedExternalOperation(res, 'create');
    }
    const idempotencyKey = requestIdempotencyKey(req);
    if (idempotencyKey === undefined) {
      return sendJson(res, 400, { error: 'Idempotency-Key header is required (1-128 characters)' });
    }
    const body = await readJsonBody(req, deps.maxBody);
    if (!body.ok) return sendJson(res, body.status, { error: body.error });
    const parsed = ManagedRecordCreateRequestSchema.safeParse(body.value);
    if (!parsed.success) return invalid(res, parsed.error);
    const result = await createNativeRecord(res, deps, {
      installation: authorized.installation,
      collection,
      idempotencyKey,
      payload: parsed.data.payload,
      origin: { kind: 'portal' },
      actorSubject: identity.subject,
      admit: () => admitBusinessMutation(res, authorized.scope),
    });
    if (result === undefined) return;
    if (result.disposition === 'conflict') return idempotencyConflict(res);
    if (result.disposition === 'paused') {
      return sendJson(res, 503, {
        error: 'Record creation requires an active application.',
        code: 'application_unavailable',
      });
    }
    return sendJson(res, result.disposition === 'created' ? 201 : 200, {
      ok: true,
      data: { record: recordToWire(result.record) },
    });
  }
  if (ref.recordId !== undefined && req.method === 'GET') {
    const recordId = ref.recordId;
    const authorized = await requireInstallationPermission(
      res,
      ref,
      identity,
      'records:read',
      deps,
    );
    if (authorized === undefined) return;
    const definition = enabledCollection(res, authorized.installation, collection);
    if (definition === undefined) return;
    if (definition.authority.authority === 'external') {
      const loaded = await loadExternalRecord(
        authorized.installation,
        definition,
        ref.recordId,
        deps,
      );
      if (loaded === undefined)
        return sendJson(res, 503, { error: 'collection source unavailable' });
      if (loaded.record === undefined) return sendJson(res, 404, { error: 'record not found' });
      return sendJson(res, 200, {
        ok: true,
        data: {
          record: externalRecordToWire(loaded.record, loaded.binding),
          collection: collectionToWire(definition),
        },
      });
    }
    const record = await runBusinessStaffOperation(
      deps,
      authorized.scope,
      identity.subject,
      'records:read',
      () => deps.store.getRequest(authorized.installation.scope, collection, recordId),
    );
    if (record === undefined) return sendJson(res, 404, { error: 'record not found' });
    return sendJson(res, 200, {
      ok: true,
      data: recordDetailToWire(authorized.installation, record),
    });
  }
  if (ref.recordId !== undefined && req.method === 'PATCH') {
    const recordId = ref.recordId;
    const body = await readJsonBody(req, deps.maxBody);
    if (!body.ok) return sendJson(res, body.status, { error: body.error });
    const parsed = ManagedRecordMutationRequestSchema.safeParse(body.value);
    if (!parsed.success) return invalid(res, parsed.error);
    const permission = mutationPermission(parsed.data.operation);
    const authorized = await requireInstallationPermission(res, ref, identity, permission, deps);
    if (authorized === undefined) return;
    const definition = enabledCollection(res, authorized.installation, collection);
    if (definition === undefined) return;
    if (definition.authority.authority === 'external') {
      return unsupportedExternalOperation(res, parsed.data.operation);
    }
    if (parsed.data.operation === 'migrate-schema') {
      const result = await runBusinessStaffOperation(
        deps,
        authorized.scope,
        identity.subject,
        permission,
        () =>
          deps.store.migrateLegacyRequest({
            scope: authorized.installation.scope,
            collectionKey: collection,
            id: recordId,
            expectedRevision: parsed.data.expectedRevision,
            actorSubject: identity.subject,
          }),
      );
      if (!result.ok) return mutationFailure(res, result);
      return sendJson(res, 200, { ok: true, data: { record: recordToWire(result.record) } });
    }
    let operation: ManagedRequestOperation;
    if (parsed.data.operation === 'update') {
      operation = {
        kind: 'update',
        payload: parsed.data.patch,
        ...(parsed.data.unset ? { unset: parsed.data.unset } : {}),
      };
    } else if (parsed.data.operation === 'assign') {
      if (parsed.data.assigneeSubject !== null) {
        const assigneeGrant = await resolveBusinessStaffGrant(
          deps,
          authorized.installation.scope,
          parsed.data.assigneeSubject,
        );
        if (
          assigneeGrant === undefined ||
          assigneeGrant.revokedAt !== undefined ||
          !businessGrantAllows(assigneeGrant, 'records:assign')
        ) {
          return sendJson(res, 422, {
            error: 'assignee must have an active operator grant',
            code: 'invalid_assignee',
          });
        }
      }
      operation = {
        kind: 'assign',
        assigneeSubject: parsed.data.assigneeSubject ?? undefined,
      };
    } else if (parsed.data.operation === 'set-status') {
      operation = { kind: 'set_status', status: parsed.data.status };
    } else {
      operation = { kind: 'add_note', note: parsed.data.note };
    }
    let result: Awaited<ReturnType<BusinessInformationStore['mutateRequest']>>;
    try {
      result = await runBusinessStaffOperation(
        deps,
        authorized.scope,
        identity.subject,
        permission,
        () =>
          deps.store.mutateRequest({
            scope: authorized.installation.scope,
            collectionKey: collection,
            id: recordId,
            expectedRevision: parsed.data.expectedRevision,
            actorSubject: identity.subject,
            operation,
          }),
      );
    } catch (error) {
      if (error instanceof PayloadValidationError) {
        return sendJson(res, 400, { error: error.message, code: error.code });
      }
      throw error;
    }
    if (!result.ok) return mutationFailure(res, result);
    return sendJson(res, 200, { ok: true, data: { record: recordToWire(result.record) } });
  }
  if (ref.recordId !== undefined && req.method === 'DELETE') {
    const recordId = ref.recordId;
    const authorized = await requireInstallationPermission(
      res,
      ref,
      identity,
      'records:delete',
      deps,
    );
    if (authorized === undefined) return;
    const definition = enabledCollection(res, authorized.installation, collection);
    if (definition === undefined) return;
    const body = await readJsonBody(req, deps.maxBody);
    if (!body.ok) return sendJson(res, body.status, { error: body.error });
    const revision = expectedRevision(body.value);
    if (revision === undefined) {
      return sendJson(res, 400, { error: 'expectedRevision must be a positive integer' });
    }
    if (definition.authority.authority === 'external') {
      const loaded = await loadExternalRecord(
        authorized.installation,
        definition,
        ref.recordId,
        deps,
      );
      if (loaded === undefined)
        return sendJson(res, 503, { error: 'collection source unavailable' });
      if (loaded.record === undefined) return sendJson(res, 404, { error: 'record not found' });
      const { record } = loaded;
      if (record.revision !== revision) {
        return sendJson(res, 409, {
          error: 'record revision conflict',
          code: 'revision_conflict',
          currentRevision: record.revision,
        });
      }
      await deps.sourceStore?.suppressExternalRecord({
        ...sourceBindingKey(authorized.installation, definition),
        sourceId: record.source.id,
        reason: 'customer_request',
        now: now(deps),
      });
      const deletedAt = now(deps).toISOString();
      return sendJson(res, 200, {
        ok: true,
        data: {
          recordId: record.id,
          authority: 'external',
          disposition: 'suppressed',
          deletedAt,
        },
      });
    }
    const result = await runBusinessStaffOperation(
      deps,
      authorized.scope,
      identity.subject,
      'records:delete',
      () =>
        deps.store.deleteRequest({
          scope: authorized.installation.scope,
          collectionKey: collection,
          id: recordId,
          expectedRevision: revision,
          actorSubject: identity.subject,
          reason: 'customer_request',
        }),
    );
    if (!result.ok) return mutationFailure(res, result);
    return sendJson(res, 200, {
      ok: true,
      data: {
        recordId: result.record.id,
        authority: 'native',
        disposition: 'deleted',
        deletedAt: result.record.deletedAt,
      },
    });
  }
  return methodNotAllowed(res);
}
