import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  clientAddressBucket,
  type DailyCounterStore,
} from '@noodle-borg/admission-limits/portable';
import type { ControlPlaneIdentity, DeployAuthGate } from '@noodle-borg/control-plane/portable';
import { readJsonBody, sendJson } from '@noodle-borg/transport-http';
import {
  BusinessGrantCreateRequestSchema,
  formatWireError,
  ManagedRecordCreateRequestSchema,
  ManagedRecordMutationRequestSchema,
  ManagedRecordStatusSchema,
  SolutionInstallationCreateRequestSchema,
} from '@noodle-borg/wire-contracts';
import {
  BUILT_IN_SOLUTION_PROFILES,
  type BusinessInformationStore,
  type BusinessPermission,
  businessGrantAllows,
  CursorValidationError,
  type InstallationScope,
  type JsonObject,
  type ManagedRequestOperation,
  PayloadValidationError,
  type SolutionInstallation,
  validateProfilePayload,
} from '../business-information/portable.js';
import { sendForbidden } from '../http-util.js';
import type { ControlPlaneStore } from '../store.js';
import type {
  PublicSolutionIntakeRef,
  SolutionInstallationRef,
} from './business-information-paths.js';
import {
  activityToWire,
  grantToWire,
  installationToWire,
  profileToWire,
  recordToWire,
} from './business-information-wire.js';
import { authorizeControlPlane } from './control-plane.js';
import { canManageMembers } from './org-admin.js';

export interface BusinessInformationRouteDeps {
  readonly store: BusinessInformationStore;
  readonly gate: DeployAuthGate;
  readonly controlPlane: ControlPlaneStore;
  readonly maxBody: number;
  readonly publicCounters: DailyCounterStore;
  readonly trustProxy: boolean;
  readonly now?: () => Date;
}

export function handleSolutionCatalog(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET') {
    methodNotAllowed(res);
    return;
  }
  sendJson(res, 200, {
    ok: true,
    data: { profiles: Object.values(BUILT_IN_SOLUTION_PROFILES).map(profileToWire) },
  });
}

export async function handleSolutionInstallations(
  req: IncomingMessage,
  res: ServerResponse,
  ref: SolutionInstallationRef,
  deps: BusinessInformationRouteDeps,
): Promise<void> {
  const identity = await requireIdentity(req, res, deps);
  if (identity === false) return;
  if (req.method === 'POST' && ref.installationId === undefined) {
    if (!(await canManageMembers(deps.controlPlane, ref.org, identity))) {
      return sendForbidden(res, 'organization owner required');
    }
    const body = await readJsonBody(req, deps.maxBody);
    if (!body.ok) return sendJson(res, body.status, { error: body.error });
    const parsed = SolutionInstallationCreateRequestSchema.safeParse(body.value);
    if (!parsed.success) return invalid(res, parsed.error);
    const profile = BUILT_IN_SOLUTION_PROFILES[parsed.data.profileId];
    const installationId = stableInstallationId(
      ref.org,
      parsed.data.appSlug,
      parsed.data.environment,
    );
    const result = await deps.store.createInstallation({
      scope: {
        org: ref.org,
        app: parsed.data.appSlug,
        env: parsed.data.environment,
        installationId,
      },
      profileKey: parsed.data.profileId,
      managedCollections: profile.collections.map((collection) => collection.key),
      retentionDays: parsed.data.retentionDays,
      actorSubject: identity.subject,
      actorEmail: identity.email,
    });
    if (result.disposition === 'conflict') {
      return sendJson(res, 409, {
        error: 'a different solution is already installed for this app and environment',
        code: 'installation_conflict',
      });
    }
    const grant = await deps.store.getGrant(result.installation.scope, identity.subject);
    if (grant === undefined || grant.revokedAt !== undefined) {
      return sendForbidden(res, 'business grant required');
    }
    return sendJson(res, result.disposition === 'created' ? 201 : 200, {
      ok: true,
      data: {
        installation: installationToWire(result.installation, profile, grant.role),
      },
    });
  }
  if (req.method === 'GET' && ref.installationId === undefined) {
    const installations = await deps.store.listInstallations(ref.org);
    const permitted: Array<{
      installation: SolutionInstallation;
      role: 'administrator' | 'manager' | 'operator' | 'viewer';
    }> = [];
    for (const installation of installations) {
      const grant = await deps.store.getGrant(installation.scope, identity.subject);
      if (grant !== undefined && grant.revokedAt === undefined) {
        permitted.push({ installation, role: grant.role });
      }
    }
    return sendJson(res, 200, {
      ok: true,
      data: {
        installations: permitted.map(({ installation, role }) =>
          installationToWire(
            installation,
            BUILT_IN_SOLUTION_PROFILES[installation.profileKey],
            role,
          ),
        ),
      },
    });
  }
  if (req.method === 'GET' && ref.installationId !== undefined) {
    const authorized = await requireInstallationGrant(res, ref, identity, deps);
    if (authorized === undefined) return;
    return sendJson(res, 200, {
      ok: true,
      data: {
        installation: installationToWire(
          authorized.installation,
          BUILT_IN_SOLUTION_PROFILES[authorized.installation.profileKey],
          authorized.grant.role,
        ),
      },
    });
  }
  return methodNotAllowed(res);
}

export async function handleBusinessGrants(
  req: IncomingMessage,
  res: ServerResponse,
  ref: SolutionInstallationRef,
  deps: BusinessInformationRouteDeps,
): Promise<void> {
  const identity = await requireIdentity(req, res, deps);
  if (identity === false) return;
  const authorized = await requireInstallationPermission(res, ref, identity, 'grants:manage', deps);
  if (authorized === undefined) return;
  const { scope } = authorized.installation;
  if (req.method === 'GET' && ref.subject === undefined) {
    const grants = (await deps.store.listGrants(scope)).filter(
      (grant) => grant.revokedAt === undefined,
    );
    return sendJson(res, 200, { ok: true, data: { grants: grants.map(grantToWire) } });
  }
  if (req.method === 'POST' && ref.subject === undefined) {
    const body = await readJsonBody(req, deps.maxBody);
    if (!body.ok) return sendJson(res, body.status, { error: body.error });
    const parsed = BusinessGrantCreateRequestSchema.safeParse(body.value);
    if (!parsed.success) return invalid(res, parsed.error);
    const result = await deps.store.setGrant({
      scope,
      subject: parsed.data.subject,
      email: parsed.data.email,
      role: parsed.data.role,
      expectedRevision: parsed.data.expectedRevision ?? 0,
      actorSubject: identity.subject,
    });
    if (!result.ok) return mutationFailure(res, result);
    return sendJson(res, result.grant.revision === 1 ? 201 : 200, {
      ok: true,
      data: { grant: grantToWire(result.grant) },
    });
  }
  if (req.method === 'DELETE' && ref.subject !== undefined) {
    const body = await readJsonBody(req, deps.maxBody);
    if (!body.ok) return sendJson(res, body.status, { error: body.error });
    const revision = expectedRevision(body.value);
    if (revision === undefined) {
      return sendJson(res, 400, { error: 'expectedRevision must be a positive integer' });
    }
    const result = await deps.store.revokeGrant({
      scope,
      subject: ref.subject,
      expectedRevision: revision,
      actorSubject: identity.subject,
    });
    if (!result.ok) return mutationFailure(res, result);
    return sendJson(res, 200, { ok: true, data: { grant: grantToWire(result.grant) } });
  }
  return methodNotAllowed(res);
}

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
    if (!collectionEnabled(res, authorized.installation, collection)) return;
    const activities = await deps.store.listActivity(
      authorized.installation.scope,
      collection,
      ref.recordId,
    );
    return sendJson(res, 200, {
      ok: true,
      data: { activities: activities.map(activityToWire) },
    });
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
    if (!collectionEnabled(res, authorized.installation, collection)) return;
    const paging = parsePaging(url, 500);
    if (!paging.ok) return sendJson(res, 400, { error: paging.error });
    const page = await cursorRequest(res, () =>
      deps.store.exportRequests({
        scope: authorized.installation.scope,
        collectionKey: collection,
        ...paging.value,
        includeDeleted: url.searchParams.get('includeDeleted') === 'true',
      }),
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
  if (ref.recordId === undefined && req.method === 'GET') {
    const authorized = await requireInstallationPermission(
      res,
      ref,
      identity,
      'records:read',
      deps,
    );
    if (authorized === undefined) return;
    if (!collectionEnabled(res, authorized.installation, collection)) return;
    const paging = parsePaging(url, 100);
    if (!paging.ok) return sendJson(res, 400, { error: paging.error });
    const statusValue = url.searchParams.get('status');
    const status =
      statusValue === null ? undefined : ManagedRecordStatusSchema.safeParse(statusValue);
    if (status !== undefined && !status.success)
      return sendJson(res, 400, { error: 'invalid status' });
    const assigneeSubject = url.searchParams.get('assigneeSubject') ?? undefined;
    const page = await cursorRequest(res, () =>
      deps.store.listRequests({
        scope: authorized.installation.scope,
        collectionKey: collection,
        ...paging.value,
        ...(status === undefined ? {} : { status: status.data }),
        ...(assigneeSubject === undefined ? {} : { assigneeSubject }),
        includeDeleted: url.searchParams.get('includeDeleted') === 'true',
      }),
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
    if (!collectionEnabled(res, authorized.installation, collection)) return;
    const idempotencyKey = requestIdempotencyKey(req);
    if (idempotencyKey === undefined) {
      return sendJson(res, 400, { error: 'Idempotency-Key header is required (1-128 characters)' });
    }
    const body = await readJsonBody(req, deps.maxBody);
    if (!body.ok) return sendJson(res, body.status, { error: body.error });
    const parsed = ManagedRecordCreateRequestSchema.safeParse(body.value);
    if (!parsed.success) return invalid(res, parsed.error);
    const payload = profilePayload(res, authorized.installation, collection, parsed.data.payload);
    if (payload === undefined) return;
    const result = await deps.store.createRequest({
      scope: authorized.installation.scope,
      collectionKey: collection,
      idempotencyKey,
      payload,
      origin: { kind: 'portal' },
      actorSubject: identity.subject,
    });
    if (result.disposition === 'conflict') return idempotencyConflict(res);
    return sendJson(res, result.disposition === 'created' ? 201 : 200, {
      ok: true,
      data: { record: recordToWire(result.record) },
    });
  }
  if (ref.recordId !== undefined && req.method === 'GET') {
    const authorized = await requireInstallationPermission(
      res,
      ref,
      identity,
      'records:read',
      deps,
    );
    if (authorized === undefined) return;
    if (!collectionEnabled(res, authorized.installation, collection)) return;
    const record = await deps.store.getRequest(
      authorized.installation.scope,
      collection,
      ref.recordId,
    );
    if (record === undefined) return sendJson(res, 404, { error: 'record not found' });
    return sendJson(res, 200, { ok: true, data: { record: recordToWire(record) } });
  }
  if (ref.recordId !== undefined && req.method === 'PATCH') {
    const body = await readJsonBody(req, deps.maxBody);
    if (!body.ok) return sendJson(res, body.status, { error: body.error });
    const parsed = ManagedRecordMutationRequestSchema.safeParse(body.value);
    if (!parsed.success) return invalid(res, parsed.error);
    const permission = mutationPermission(parsed.data.operation);
    const authorized = await requireInstallationPermission(res, ref, identity, permission, deps);
    if (authorized === undefined) return;
    if (!collectionEnabled(res, authorized.installation, collection)) return;
    let operation: ManagedRequestOperation;
    if (parsed.data.operation === 'update') {
      const current = await deps.store.getRequest(
        authorized.installation.scope,
        collection,
        ref.recordId,
      );
      if (current?.content === undefined) return sendJson(res, 404, { error: 'record not found' });
      const payload = profilePayload(res, authorized.installation, collection, {
        ...current.content.payload,
        ...parsed.data.patch,
      });
      if (payload === undefined) return;
      operation = { kind: 'update', payload };
    } else if (parsed.data.operation === 'assign') {
      if (parsed.data.assigneeSubject !== null) {
        const assigneeGrant = await deps.store.getGrant(
          authorized.installation.scope,
          parsed.data.assigneeSubject,
        );
        if (
          assigneeGrant === undefined ||
          assigneeGrant.revokedAt !== undefined ||
          assigneeGrant.role === 'viewer'
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
    const result = await deps.store.mutateRequest({
      scope: authorized.installation.scope,
      collectionKey: collection,
      id: ref.recordId,
      expectedRevision: parsed.data.expectedRevision,
      actorSubject: identity.subject,
      operation,
    });
    if (!result.ok) return mutationFailure(res, result);
    return sendJson(res, 200, { ok: true, data: { record: recordToWire(result.record) } });
  }
  if (ref.recordId !== undefined && req.method === 'DELETE') {
    const authorized = await requireInstallationPermission(
      res,
      ref,
      identity,
      'records:delete',
      deps,
    );
    if (authorized === undefined) return;
    if (!collectionEnabled(res, authorized.installation, collection)) return;
    const body = await readJsonBody(req, deps.maxBody);
    if (!body.ok) return sendJson(res, body.status, { error: body.error });
    const revision = expectedRevision(body.value);
    if (revision === undefined) {
      return sendJson(res, 400, { error: 'expectedRevision must be a positive integer' });
    }
    const result = await deps.store.deleteRequest({
      scope: authorized.installation.scope,
      collectionKey: collection,
      id: ref.recordId,
      expectedRevision: revision,
      actorSubject: identity.subject,
      reason: 'customer_request',
    });
    if (!result.ok) return mutationFailure(res, result);
    return sendJson(res, 200, {
      ok: true,
      data: { recordId: result.record.id, deletedAt: result.record.deletedAt },
    });
  }
  return methodNotAllowed(res);
}

export async function handlePublicSolutionIntake(
  req: IncomingMessage,
  res: ServerResponse,
  ref: PublicSolutionIntakeRef,
  deps: BusinessInformationRouteDeps,
): Promise<void> {
  const installation = await deps.store.resolveInstallationByPublicId(ref.publicId);
  if (installation === undefined) return sendJson(res, 404, { error: 'solution not found' });
  const profile = BUILT_IN_SOLUTION_PROFILES[installation.profileKey];
  if (req.method === 'GET' && ref.collection === undefined) {
    const wire = profileToWire(profile);
    return sendJson(res, 200, {
      ok: true,
      data: {
        publicId: installation.publicId,
        title: wire.title,
        description: wire.description,
        collection: wire.collection,
      },
    });
  }
  if (req.method === 'POST' && ref.collection !== undefined) {
    if (!collectionEnabled(res, installation, ref.collection)) return;
    const quota = await consumePublicIntakeQuota(req, ref.publicId, deps);
    if (!quota.allowed) {
      res.setHeader(
        'retry-after',
        String(Math.max(1, Math.ceil((quota.resetAt.getTime() - now(deps).getTime()) / 1000))),
      );
      return sendJson(res, 429, { error: 'public intake limit exceeded', code: 'quota_exceeded' });
    }
    const idempotencyKey = requestIdempotencyKey(req);
    if (idempotencyKey === undefined) {
      return sendJson(res, 400, { error: 'Idempotency-Key header is required (1-128 characters)' });
    }
    const body = await readJsonBody(req, deps.maxBody);
    if (!body.ok) return sendJson(res, body.status, { error: body.error });
    const parsed = ManagedRecordCreateRequestSchema.safeParse(body.value);
    if (!parsed.success) return invalid(res, parsed.error);
    const payload = profilePayload(res, installation, ref.collection, parsed.data.payload);
    if (payload === undefined) return;
    const result = await deps.store.createRequest({
      scope: installation.scope,
      collectionKey: ref.collection,
      idempotencyKey,
      payload,
      origin: { kind: 'embedded', reference: 'public-intake' },
      actorSubject: 'anonymous',
    });
    if (result.disposition === 'conflict') return idempotencyConflict(res);
    return sendJson(res, result.disposition === 'created' ? 201 : 200, {
      ok: true,
      data: { recordId: result.record.id, receivedAt: result.record.createdAt },
    });
  }
  return methodNotAllowed(res);
}

async function requireIdentity(
  req: IncomingMessage,
  res: ServerResponse,
  deps: BusinessInformationRouteDeps,
): Promise<ControlPlaneIdentity | false> {
  return authorizeControlPlane(req, res, deps.gate, { requireIdentity: true });
}

async function requireInstallationGrant(
  res: ServerResponse,
  ref: SolutionInstallationRef,
  identity: ControlPlaneIdentity,
  deps: BusinessInformationRouteDeps,
): Promise<
  | {
      installation: SolutionInstallation;
      scope: InstallationScope;
      grant: NonNullable<Awaited<ReturnType<BusinessInformationStore['getGrant']>>>;
    }
  | undefined
> {
  if (ref.installationId === undefined) return undefined;
  const installation = await deps.store.getInstallationById(ref.org, ref.installationId);
  if (installation === undefined) {
    sendJson(res, 404, { error: 'installation not found' });
    return undefined;
  }
  const grant = await deps.store.getGrant(installation.scope, identity.subject);
  if (grant?.revokedAt !== undefined || grant === undefined) {
    sendForbidden(res, 'business grant required');
    return undefined;
  }
  return { installation, scope: installation.scope, grant };
}

async function requireInstallationPermission(
  res: ServerResponse,
  ref: SolutionInstallationRef,
  identity: ControlPlaneIdentity,
  permission: BusinessPermission,
  deps: BusinessInformationRouteDeps,
): Promise<{ installation: SolutionInstallation; scope: InstallationScope } | undefined> {
  const authorized = await requireInstallationGrant(res, ref, identity, deps);
  if (authorized === undefined) return undefined;
  if (!businessGrantAllows(authorized.grant, permission)) {
    sendForbidden(res, `business permission required: ${permission}`);
    return undefined;
  }
  return authorized;
}

function stableInstallationId(org: string, app: string, env: string): string {
  return `ins-${createHash('sha256').update(`${org}\0${app}\0${env}`).digest('hex').slice(0, 24)}`;
}

function requestIdempotencyKey(req: IncomingMessage): string | undefined {
  const value = req.headers['idempotency-key'];
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) return undefined;
  return value;
}

function expectedRevision(value: unknown): number | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const revision = (value as { expectedRevision?: unknown }).expectedRevision;
  return typeof revision === 'number' && Number.isInteger(revision) && revision > 0
    ? revision
    : undefined;
}

function parsePaging(
  url: URL,
  maximum: number,
): { ok: true; value: { cursor?: string; limit?: number } } | { ok: false; error: string } {
  const cursor = url.searchParams.get('cursor') ?? undefined;
  const rawLimit = url.searchParams.get('limit');
  if (rawLimit === null) return { ok: true, value: cursor === undefined ? {} : { cursor } };
  const limit = Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) {
    return { ok: false, error: `limit must be an integer from 1 to ${maximum}` };
  }
  return { ok: true, value: { ...(cursor === undefined ? {} : { cursor }), limit } };
}

function mutationPermission(operation: string): BusinessPermission {
  if (operation === 'assign') return 'records:assign';
  if (operation === 'set-status') return 'records:status';
  if (operation === 'add-note') return 'records:note';
  return 'records:update';
}

function mutationFailure(
  res: ServerResponse,
  result: { readonly reason: string; readonly currentRevision: number },
): void {
  const status =
    result.reason === 'not_found'
      ? 404
      : result.reason === 'conflict' || result.reason === 'last_administrator'
        ? 409
        : 422;
  sendJson(res, status, {
    error: result.reason.replaceAll('_', ' '),
    code: result.reason,
    currentRevision: result.currentRevision,
  });
}

function collectionEnabled(
  res: ServerResponse,
  installation: SolutionInstallation,
  collection: string,
): boolean {
  if (installation.managedCollections.includes(collection)) return true;
  sendJson(res, 404, { error: 'collection not found' });
  return false;
}

function profilePayload(
  res: ServerResponse,
  installation: SolutionInstallation,
  collection: string,
  value: unknown,
): JsonObject | undefined {
  try {
    return validateProfilePayload(installation.profileKey, collection, value);
  } catch (error) {
    if (!(error instanceof PayloadValidationError)) throw error;
    sendJson(res, 400, { error: error.message, code: error.code });
    return undefined;
  }
}

async function cursorRequest<T>(
  res: ServerResponse,
  request: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await request();
  } catch (error) {
    if (!(error instanceof CursorValidationError)) throw error;
    sendJson(res, 400, { error: 'cursor is invalid', code: 'invalid_cursor' });
    return undefined;
  }
}

async function consumePublicIntakeQuota(
  req: IncomingMessage,
  publicId: string,
  deps: BusinessInformationRouteDeps,
) {
  const timestamp = now(deps);
  const address = deps.trustProxy
    ? typeof req.headers['x-forwarded-for'] === 'string'
      ? req.headers['x-forwarded-for']
      : undefined
    : req.socket.remoteAddress;
  const bucket = clientAddressBucket(address);
  if (bucket !== undefined) {
    const addressOutcome = await deps.publicCounters.consume(
      { key: `solution-intake:address:${publicId}:${bucket}`, limit: 60, window: 'hour' },
      timestamp,
    );
    if (!addressOutcome.allowed) return addressOutcome;
  }
  return deps.publicCounters.consume(
    { key: `solution-intake:surface:${publicId}`, limit: 10_000, window: 'day' },
    timestamp,
  );
}

function now(deps: BusinessInformationRouteDeps): Date {
  return deps.now?.() ?? new Date();
}

function invalid(res: ServerResponse, error: Parameters<typeof formatWireError>[0]): void {
  sendJson(res, 400, { error: formatWireError(error) });
}

function idempotencyConflict(res: ServerResponse): void {
  sendJson(res, 409, {
    error: 'the idempotency key was already used with different content',
    code: 'idempotency_conflict',
  });
}

function methodNotAllowed(res: ServerResponse): void {
  sendJson(res, 405, { error: 'method not allowed' });
}
