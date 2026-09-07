import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJsonBody, sendJson } from '@noodle-borg/transport-http';
import {
  CollectionSourceConfigureRequestSchema,
  CollectionSourceRefreshRequestSchema,
  CollectionSourceRevisionRequestSchema,
} from '@noodle-borg/wire-contracts';
import type {
  BusinessPermission,
  InstalledCollectionDefinition,
  SolutionInstallation,
  SourceBindingRecord,
} from '../business-information/portable.js';
import { SourceCapacityError } from '../business-information/source-custody-budget.js';
import { sourceOperationSignatureDigest } from '../business-information/source-ingestion-validation.js';
import {
  type BusinessInformationRouteDeps,
  enabledCollection,
  invalid,
  methodNotAllowed,
  mutationFailure,
  now,
  requireIdentity,
  requireInstallationPermission,
} from './business-information.js';
import type { SolutionInstallationRef } from './business-information-paths.js';

/** Operate a collection's generic external source without introducing provider-specific routes. */
export async function handleCollectionSource(
  req: IncomingMessage,
  res: ServerResponse,
  ref: SolutionInstallationRef,
  deps: BusinessInformationRouteDeps,
): Promise<void> {
  const identity = await requireIdentity(req, res, deps);
  if (identity === false) return;
  const sourcePermission: BusinessPermission =
    req.method === 'GET'
      ? 'records:read'
      : ref.sourceAction === 'refresh'
        ? 'records:update'
        : 'installation:administer';
  const authorized = await requireInstallationPermission(
    res,
    ref,
    identity,
    sourcePermission,
    deps,
  );
  if (authorized === undefined || ref.collection === undefined) return;
  const collection = enabledCollection(res, authorized.installation, ref.collection);
  if (collection === undefined) return;
  if (collection.authority.authority !== 'external') {
    return sendJson(res, 405, {
      error: 'native collections do not have source controls',
      code: 'operation_not_supported',
    });
  }
  if (deps.sourceStore === undefined) {
    return sendJson(res, 503, { error: 'collection source persistence is unavailable' });
  }
  const key = sourceBindingKey(authorized.installation, collection);
  const current = await deps.sourceStore.getBinding(key);
  if (ref.sourceAction === undefined && req.method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      data: { source: collectionSourceToWire(authorized.installation, collection, current) },
    });
  }
  if (ref.sourceAction === undefined && req.method === 'PATCH') {
    const definitionReference = authorized.installation.definition.reference;
    if (
      definitionReference.kind === 'private' &&
      authorized.installation.scope.org !== definitionReference.publisherOrg
    ) {
      return sendJson(res, 409, {
        error: 'cross-organization source account binding is unavailable',
        code: 'source_cross_org_binding_unavailable',
      });
    }
    const body = await readJsonBody(req, deps.maxBody);
    if (!body.ok) return sendJson(res, body.status, { error: body.error });
    const parsed = CollectionSourceConfigureRequestSchema.safeParse(body.value);
    if (!parsed.success) return invalid(res, parsed.error);
    const expected = current?.revision ?? authorized.installation.revision;
    if (parsed.data.expectedRevision !== expected) {
      return sendJson(res, 409, {
        error: 'source revision conflict',
        code: 'revision_conflict',
        currentRevision: expected,
      });
    }
    const bindingInput = {
      ...key,
      bindingReference: parsed.data.binding.reference,
      configurationReference: parsed.data.configurationReference,
      generation: parsed.data.binding.generation,
      schemaVersion: collection.schemaVersion,
      schemaDigest: collection.schemaDigest.replace(/^sha256:/, ''),
      queryFingerprint: createHash('sha256')
        .update(parsed.data.binding.reference)
        .update('\0')
        .update(parsed.data.configurationReference)
        .digest('hex'),
      scan: {
        connector: collection.authority.connectorId,
        connectorVersion: collection.authority.connectorVersion,
        operation: collection.authority.scanOperation,
        signatureDigest: sourceOperationSignatureDigest(collection.authority.scanSignatureHash),
      },
      retentionDays: authorized.installation.retentionDays,
      pollIntervalMs: 60_000,
    } as const;
    let binding: SourceBindingRecord;
    try {
      if (current === undefined) {
        if (parsed.data.replace === true) {
          return sendJson(res, 404, { error: 'source is not configured' });
        }
        binding = await deps.sourceStore.createBinding(bindingInput);
      } else {
        if (parsed.data.replace !== true) {
          return sendJson(res, 409, {
            error: 'source replacement requires explicit replace consent',
            code: 'source_replacement_required',
            currentRevision: current.revision,
          });
        }
        const replaced = await deps.sourceStore.replaceBinding({
          ...bindingInput,
          expectedRevision: parsed.data.expectedRevision,
          now: now(deps),
        });
        if (!replaced.ok) return mutationFailure(res, replaced);
        binding = replaced.binding;
      }
    } catch (error) {
      if (!isSourceConfigurationConflict(error)) throw error;
      return sendJson(res, 409, {
        error: 'source configuration conflict',
        code: 'source_configuration_conflict',
      });
    }
    return sendJson(res, current === undefined ? 201 : 200, {
      ok: true,
      data: { source: collectionSourceToWire(authorized.installation, collection, binding) },
    });
  }
  if ((ref.sourceAction === 'pause' || ref.sourceAction === 'resume') && req.method === 'POST') {
    const body = await readJsonBody(req, deps.maxBody);
    if (!body.ok) return sendJson(res, body.status, { error: body.error });
    const parsed = CollectionSourceRevisionRequestSchema.safeParse(body.value);
    if (!parsed.success) return invalid(res, parsed.error);
    const result = await deps.sourceStore.setBindingState({
      ...key,
      expectedRevision: parsed.data.expectedRevision,
      state: ref.sourceAction === 'pause' ? 'paused' : 'active',
      now: now(deps),
    });
    if (!result.ok) return mutationFailure(res, result);
    return sendJson(res, 200, {
      ok: true,
      data: {
        source: collectionSourceToWire(authorized.installation, collection, result.binding),
      },
    });
  }
  if (ref.sourceAction === 'refresh' && req.method === 'POST') {
    const body = await readJsonBody(req, deps.maxBody);
    if (!body.ok) return sendJson(res, body.status, { error: body.error });
    const parsed = CollectionSourceRefreshRequestSchema.safeParse(body.value);
    if (!parsed.success) return invalid(res, parsed.error);
    if (current === undefined) return sendJson(res, 404, { error: 'source is not configured' });
    const refresh = await deps.sourceStore.requestRefresh({
      ...key,
      expectedRevision: parsed.data.expectedRevision,
      idempotencyKey: parsed.data.idempotencyKey,
      now: now(deps),
    });
    if (!refresh.ok) return mutationFailure(res, refresh);
    const runSourceIngestion = deps.runSourceIngestion;
    if (runSourceIngestion !== undefined) {
      res.once('finish', () => {
        setImmediate(() => void runSourceIngestion().catch(() => undefined));
      });
    }
    sendJson(res, 202, {
      ok: true,
      data: {
        source: collectionSourceToWire(authorized.installation, collection, refresh.binding),
        job: refresh.receipt,
      },
    });
    return;
  }
  return methodNotAllowed(res);
}

function isSourceConfigurationConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message === 'source binding already exists with different immutable configuration'
  );
}

function sourceBindingKey(
  installation: SolutionInstallation,
  collection: InstalledCollectionDefinition,
) {
  return {
    scope: installation.scope,
    collectionKey: collection.key,
    id: collection.key,
  };
}

function collectionSourceToWire(
  installation: SolutionInstallation,
  collection: InstalledCollectionDefinition,
  binding: SourceBindingRecord | undefined,
) {
  const common = {
    installationId: installation.scope.installationId,
    collection: collection.key,
    authority: 'external' as const,
  };
  if (binding === undefined) {
    return { ...common, revision: installation.revision, state: 'unconfigured' as const };
  }
  return {
    ...common,
    revision: binding.revision,
    state:
      binding.state === 'paused'
        ? ('paused' as const)
        : binding.health === 'failed' || binding.health === 'reauth_required'
          ? ('error' as const)
          : ('active' as const),
    binding: {
      reference: binding.bindingReference ?? binding.id,
      generation: binding.generation,
    },
    configurationReference: binding.configurationReference ?? binding.id,
    enabled: true as const,
    health:
      binding.health === 'initializing'
        ? ('pending' as const)
        : binding.health === 'current'
          ? ('healthy' as const)
          : binding.health === 'stale'
            ? ('degraded' as const)
            : binding.health === 'reauth_required'
              ? ('authorization_required' as const)
              : binding.health === 'paused'
                ? ('paused' as const)
                : ('unavailable' as const),
    completeness:
      binding.scanMode !== undefined
        ? ('rebuilding' as const)
        : binding.completeness === 'complete'
          ? ('complete' as const)
          : binding.lastSuccessfulSyncAt === undefined
            ? ('unknown' as const)
            : ('partial' as const),
    ...(binding.lastSuccessfulSyncAt === undefined
      ? {}
      : { lastCompletedSyncAt: binding.lastSuccessfulSyncAt }),
    ...(binding.nextAttemptAt === undefined ? {} : { nextRefreshAt: binding.nextAttemptAt }),
    ...(binding.errorCode === undefined
      ? {}
      : {
          error: {
            code: binding.errorCode,
            message:
              binding.errorCode === 'source_capacity_exceeded'
                ? new SourceCapacityError().message
                : 'The external source could not be refreshed.',
            retryable:
              binding.health !== 'reauth_required' &&
              binding.errorCode !== 'source_capacity_exceeded',
          },
        }),
  };
}
