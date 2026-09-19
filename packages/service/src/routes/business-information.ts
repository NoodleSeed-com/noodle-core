import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  DailyCounterStore,
  PublicAdmissionSigningKeys,
  PublicRecordAdmissionLimits,
} from '@noodle-borg/admission-limits/portable';
import type { DeployAuthGate } from '@noodle-borg/control-plane/portable';
import { readJsonBody, sendJson } from '@noodle-borg/transport-http';
import {
  BusinessGrantCreateRequestSchema,
  formatWireError,
  SolutionInstallationCreateRequestSchema,
  SolutionInstallationIntakeRequestSchema,
} from '@noodle-borg/wire-contracts';
import { admitBusinessTarget } from '../business-api-admission.js';
import { resolveInstallDefinition } from '../business-information/definition-resolver.js';
import {
  BUILT_IN_SOLUTION_PROFILES,
  type BusinessInformationStore,
  type InstalledCollectionDefinition,
  MANAGED_SOLUTION_PROFILE_KEYS,
  type PrivateDefinitionSelector,
  type SolutionDefinitionSnapshot,
  type SolutionInstallation,
  type SourceIngestionStore,
  validateCollectionEnabled,
} from '../business-information/portable.js';
import type { BusinessOnboarding } from '../business-onboarding.js';
import type { BusinessWorkspaceStore } from '../business-workspaces/store.js';
import { sendForbidden } from '../http-util.js';
import type {
  InstallationActivationReader,
  SolutionInstallationActivator,
} from '../solution-installation-activation.js';
import type { AuditSink } from '../store/audit.js';
import type { ConfigStore, ControlPlaneStore } from '../store.js';
import {
  requireIdentity,
  requireInstallationGrant,
  requireInstallationPermission,
  resolveBusinessStaffGrant,
  runBusinessStaffOperation,
} from './business-information-access.js';
import {
  installationProjection,
  retryInstallationActivation,
  stableInstallationId,
} from './business-information-installation.js';
import type { SolutionInstallationRef } from './business-information-paths.js';
import { expectedRevision } from './business-information-request.js';
import { grantToWire, profileToWire } from './business-information-wire.js';
import { canManageMembers } from './org-admin.js';

export interface BusinessInformationRouteDeps {
  readonly workspaces?: BusinessWorkspaceStore;
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
    const grant = await resolveBusinessStaffGrant(
      deps,
      result.installation.scope,
      identity.subject,
    );
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
      role: Parameters<typeof installationProjection>[1];
    }> = [];
    for (const installation of installations) {
      const grant = await resolveBusinessStaffGrant(deps, installation.scope, identity.subject);
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
    const result = await runBusinessStaffOperation(
      deps,
      authorized.scope,
      identity.subject,
      'installation:administer',
      () =>
        deps.store.setIntakeState({
          scope: authorized.scope,
          expectedRevision: parsed.data.expectedRevision,
          active: parsed.data.active,
          actorSubject: identity.subject,
        }),
    );
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

export {
  requireIdentity,
  requireInstallationGrant,
  requireInstallationPermission,
} from './business-information-access.js';
export { handleManagedRecords } from './business-information-records.js';

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
