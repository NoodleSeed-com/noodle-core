import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  DailyCounterStore,
  PublicAdmissionSigningKeys,
  PublicRecordAdmissionLimits,
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
  SolutionInstallationIntakeRequestSchema,
} from '@noodle-borg/wire-contracts';
import {
  admitBusinessMutation,
  admitBusinessTarget,
  authorizeBusinessApi,
} from '../business-api-admission.js';
import { resolveInstallDefinition } from '../business-information/definition-resolver.js';
import {
  BUILT_IN_SOLUTION_PROFILES,
  type BusinessInformationStore,
  type BusinessPermission,
  businessGrantAllows,
  type InstallationScope,
  type InstalledCollectionDefinition,
  MANAGED_SOLUTION_PROFILE_KEYS,
  type ManagedRequestOperation,
  PayloadValidationError,
  type PrivateDefinitionSelector,
  type SolutionDefinitionSnapshot,
  type SolutionInstallation,
  type SourceIngestionStore,
  validateCollectionEnabled,
} from '../business-information/portable.js';
import type { BusinessOnboarding } from '../business-onboarding.js';
import { sendForbidden } from '../http-util.js';
import type {
  InstallationActivationReader,
  SolutionInstallationActivator,
} from '../solution-installation-activation.js';
import type { AuditSink } from '../store/audit.js';
import type { ConfigStore, ControlPlaneStore } from '../store.js';
import {
  loadExternalRecord,
  sendExternalRecordPage,
  sourceBindingKey,
  unsupportedExternalOperation,
} from './business-information-external.js';
import {
  installationProjection,
  retryInstallationActivation,
  stableInstallationId,
} from './business-information-installation.js';
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
  grantToWire,
  profileToWire,
  recordDetailToWire,
  recordToWire,
} from './business-information-wire.js';
import { canManageMembers } from './org-admin.js';

export interface BusinessInformationRouteDeps {
  readonly businessOnboarding?: BusinessOnboarding;
  readonly activateInstallation?: SolutionInstallationActivator;
  readonly readInstallationActivation?: InstallationActivationReader;
  readonly configStore?: ConfigStore;
  readonly store: BusinessInformationStore;
  readonly gate: DeployAuthGate;
  readonly controlPlane: ControlPlaneStore;
  readonly maxBody: number;
  readonly publicCounters: DailyCounterStore;
  readonly publicAdmissionKeys?: PublicAdmissionSigningKeys;
  readonly publicAdmissionLimits?: Partial<PublicRecordAdmissionLimits>;
  readonly audit?: AuditSink;
  readonly trustProxy: boolean;
  readonly publicIntakeEnabled?: boolean;
  readonly now?: () => Date;
  readonly resolvePrivateDefinition?: (
    selector: PrivateDefinitionSelector,
  ) => Promise<SolutionDefinitionSnapshot | undefined>;
  readonly sourceStore?: SourceIngestionStore;
  readonly runSourceIngestion?: () => Promise<void>;
}

export function handleSolutionCatalog(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET') {
    methodNotAllowed(res);
    return;
  }
  sendJson(res, 200, {
    ok: true,
    data: {
      profiles: MANAGED_SOLUTION_PROFILE_KEYS.map((key) =>
        profileToWire(BUILT_IN_SOLUTION_PROFILES[key]),
      ),
    },
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
  if (ref.action === 'activate') return retryInstallationActivation(req, res, ref, identity, deps);
  if (req.method === 'POST' && ref.installationId === undefined) {
    if (!(await canManageMembers(deps.controlPlane, ref.org, identity))) {
      return sendForbidden(res, 'organization owner required');
    }
    if (!(await admitBusinessTarget(res, ref))) return;
    const body = await readJsonBody(req, deps.maxBody);
    if (!body.ok) return sendJson(res, body.status, { error: body.error });
    const parsed = SolutionInstallationCreateRequestSchema.safeParse(body.value);
    if (!parsed.success) return invalid(res, parsed.error);
    const definition = await resolveInstallDefinition(
      parsed.data.definition,
      ref.org,
      deps.resolvePrivateDefinition,
    );
    if (definition === undefined) {
      return sendJson(res, 404, {
        error: 'solution definition is unavailable',
        code: 'definition_unavailable',
      });
    }
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
      ...(parsed.data.definition.kind === 'managed'
        ? { profileKey: parsed.data.definition.profileId }
        : { definition }),
      managedCollections: definition.collections.map((collection) => collection.key),
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
    if (
      parsed.data.businessNotice &&
      !(await deps.store.getBusinessNotice(result.installation.scope))
    ) {
      await deps.store.setBusinessNotice({
        scope: result.installation.scope,
        expectedRevision: 0,
        notice: parsed.data.businessNotice,
        actorSubject: identity.subject,
      });
    }
    const activated = await deps.activateInstallation?.({
      installation: result.installation,
      actor: identity,
    });
    if (activated === undefined || !activated.ok) {
      return sendJson(res, activated?.status ?? 503, {
        ok: false,
        code: activated?.code ?? 'installation_activation_unavailable',
        error:
          activated?.message ??
          'The installation is saved, but application activation is unavailable. Retry installation when the service is ready.',
        installationId: result.installation.scope.installationId,
      });
    }
    return sendJson(res, result.disposition === 'created' ? 201 : 200, {
      ok: true,
      data: {
        installation: await installationProjection(result.installation, grant.role, identity, deps),
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
    if (permitted.length > 0 && !(await admitBusinessTarget(res, ref))) return;
    return sendJson(res, 200, {
      ok: true,
      data: {
        installations: await Promise.all(
          permitted.map(({ installation, role }) =>
            installationProjection(installation, role, identity, deps),
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
        installation: await installationProjection(
          authorized.installation,
          authorized.grant.role,
          identity,
          deps,
        ),
      },
    });
  }
  if (req.method === 'PATCH' && ref.installationId !== undefined) {
    const authorized = await requireInstallationPermission(
      res,
      ref,
      identity,
      'installation:administer',
      deps,
    );
    if (authorized === undefined) return;
    const body = await readJsonBody(req, deps.maxBody);
    if (!body.ok) return sendJson(res, body.status, { error: body.error });
    const parsed = SolutionInstallationIntakeRequestSchema.safeParse(body.value);
    if (!parsed.success) return invalid(res, parsed.error);
    const result = await deps.store.setIntakeState({
      scope: authorized.scope,
      expectedRevision: parsed.data.expectedRevision,
      active: parsed.data.active,
      actorSubject: identity.subject,
    });
    if (!result.ok) return mutationFailure(res, result);
    return sendJson(res, 200, {
      ok: true,
      data: {
        installation: await installationProjection(
          result.installation,
          authorized.grant.role,
          identity,
          deps,
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
    const grants = await deps.store.listGrants(scope);
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
      deps.store.listRequests({
        scope: authorized.installation.scope,
        collectionKey: collection,
        ...paging.value,
        ...query.value,
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
    const record = await deps.store.getRequest(
      authorized.installation.scope,
      collection,
      ref.recordId,
    );
    if (record === undefined) return sendJson(res, 404, { error: 'record not found' });
    return sendJson(res, 200, {
      ok: true,
      data: recordDetailToWire(authorized.installation, record),
    });
  }
  if (ref.recordId !== undefined && req.method === 'PATCH') {
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
      const result = await deps.store.migrateLegacyRequest({
        scope: authorized.installation.scope,
        collectionKey: collection,
        id: ref.recordId,
        expectedRevision: parsed.data.expectedRevision,
        actorSubject: identity.subject,
      });
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
    let result: Awaited<ReturnType<BusinessInformationStore['mutateRequest']>>;
    try {
      result = await deps.store.mutateRequest({
        scope: authorized.installation.scope,
        collectionKey: collection,
        id: ref.recordId,
        expectedRevision: parsed.data.expectedRevision,
        actorSubject: identity.subject,
        operation,
      });
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

export async function requireIdentity(
  req: IncomingMessage,
  res: ServerResponse,
  deps: BusinessInformationRouteDeps,
): Promise<ControlPlaneIdentity | false> {
  return authorizeBusinessApi(req, res, deps);
}

export async function requireInstallationGrant(
  res: ServerResponse,
  ref: SolutionInstallationRef,
  identity: ControlPlaneIdentity,
  deps: BusinessInformationRouteDeps,
  permission?: BusinessPermission,
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
  if (permission && !businessGrantAllows(grant, permission)) {
    sendForbidden(res, `business permission required: ${permission}`);
    return undefined;
  }
  if (!(await admitBusinessTarget(res, installation.scope))) return undefined;
  return { installation, scope: installation.scope, grant };
}

export async function requireInstallationPermission(
  res: ServerResponse,
  ref: SolutionInstallationRef,
  identity: ControlPlaneIdentity,
  permission: BusinessPermission,
  deps: BusinessInformationRouteDeps,
): ReturnType<typeof requireInstallationGrant> {
  return requireInstallationGrant(res, ref, identity, deps, permission);
}

export function mutationFailure(
  res: ServerResponse,
  result: { readonly reason: string; readonly currentRevision: number },
): void {
  const status =
    result.reason === 'not_found'
      ? 404
      : ['conflict', 'last_administrator', 'application_unavailable'].includes(result.reason)
        ? 409
        : 422;
  sendJson(res, status, {
    error: result.reason.replaceAll('_', ' '),
    code: result.reason,
    currentRevision: result.currentRevision,
  });
}

export function enabledCollection(
  res: ServerResponse,
  installation: SolutionInstallation,
  collection: string,
): InstalledCollectionDefinition | undefined {
  try {
    return validateCollectionEnabled(installation, collection);
  } catch {
    sendJson(res, 404, { error: 'collection not found' });
    return undefined;
  }
}

export function now(deps: BusinessInformationRouteDeps): Date {
  return deps.now?.() ?? new Date();
}

export function invalid(res: ServerResponse, error: Parameters<typeof formatWireError>[0]): void {
  sendJson(res, 400, { error: formatWireError(error) });
}

export function idempotencyConflict(res: ServerResponse): void {
  sendJson(res, 409, {
    error: 'the idempotency key was already used with different content',
    code: 'idempotency_conflict',
  });
}

export function methodNotAllowed(res: ServerResponse): void {
  sendJson(res, 405, { error: 'method not allowed' });
}

export { createNativeRecord } from './business-information-record-create.js';
