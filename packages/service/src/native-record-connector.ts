import { admitPublicRecord, type DailyCounterStore } from '@noodle-borg/admission-limits/portable';
import {
  RECORD_CONNECTOR_ID,
  RECORD_CONNECTOR_VERSION,
  RECORD_OPERATION_SIGNATURES,
  type RuntimeArtifact,
  validateJsonSchema,
} from '@noodle-borg/compiler';
import { type Connector, type ConnectorCall, ConnectorInvocationError } from '@noodle-borg/runtime';
import { creationPayload } from './business-information/collection-controls.js';
import type {
  BusinessInformationStore,
  BusinessPermission,
  InstalledCollectionDefinition,
  JsonObject,
  SolutionInstallation,
} from './business-information/contracts.js';
import {
  businessGrantAllows,
  idempotencyDigest,
  requestFingerprint,
} from './business-information/model.js';
import { NativeStorageLimitError } from './business-information/native-storage-budget.js';
import {
  CursorValidationError,
  PayloadValidationError,
} from './business-information/validation.js';
import { recordToWire } from './routes/business-information-wire.js';
import type { TenantRef } from './store.js';

export interface NativeRecordConnectorInput {
  readonly tenant: TenantRef;
  readonly artifact: RuntimeArtifact;
  readonly deploymentId?: string;
}
export interface NativeRecordConnectorDependencies {
  readonly store: BusinessInformationStore;
  readonly counters: DailyCounterStore;
  readonly publicIntakeEnabled?: boolean;
  readonly now?: () => Date;
}
export type NativeRecordConnectorFactory = (
  input: NativeRecordConnectorInput,
) => Connector | undefined;

/** Platform composition supplies storage; an authored declaration alone grants no installed authority. */
export function createDeploymentNativeRecordConnector(
  input: NativeRecordConnectorInput,
  dependencies: NativeRecordConnectorDependencies,
): Connector | undefined {
  if (
    !input.artifact.server.managedCollections?.some(
      (collection) => collection.source.authority === 'native',
    )
  )
    return undefined;
  return new NativeRecordConnector(input, dependencies);
}

class NativeRecordConnector implements Connector {
  readonly id = RECORD_CONNECTOR_ID;
  readonly version = RECORD_CONNECTOR_VERSION;
  constructor(
    private readonly input: NativeRecordConnectorInput,
    private readonly dependencies: NativeRecordConnectorDependencies,
  ) {}
  signature(operation: string) {
    return RECORD_OPERATION_SIGNATURES[operation];
  }
  executionBoundMs(operation: string): number | undefined {
    return this.signature(operation)?.type === 'action' ? 10_000 : undefined;
  }

  async invoke(call: ConnectorCall): Promise<unknown> {
    const signature = this.signature(call.operation);
    if (signature === undefined || validateJsonSchema(signature.input, call.args).length > 0)
      return fail(call, 400, 'Invalid native record operation arguments.');
    if (signature.type === 'action' && !/^[a-f0-9]{64}$/.test(call.execution?.id ?? ''))
      return fail(
        call,
        503,
        'A trusted execution identity is required before a native record write.',
      );
    const installations = (
      await this.dependencies.store.listInstallations(this.input.tenant.org)
    ).filter(
      (installation) =>
        installation.scope.app === this.input.tenant.app &&
        installation.scope.env === this.input.tenant.env,
    );
    if (installations.length !== 1)
      return fail(call, 503, 'Native record installation is unavailable.');
    const installation = installations[0];
    if (installation === undefined)
      return fail(call, 503, 'Native record installation is unavailable.');
    const collection = installation.definition.collections.find(
      (entry) => entry.key === call.args.collection,
    );
    const authored = this.input.artifact.server.managedCollections?.find(
      (entry) => entry.name === call.args.collection,
    );
    if (
      collection === undefined ||
      authored === undefined ||
      !installation.managedCollections.includes(collection.key)
    )
      return fail(call, 404, 'Native collection is not enabled for this application.');
    if (collection.authority.authority !== 'native' || authored.source.authority !== 'native')
      return fail(
        call,
        405,
        'External reference collections do not accept native record operations.',
      );
    if (
      collection.schemaDigest.replace(/^sha256:/, '') !==
      authored.schemaDigest.replace(/^sha256:/, '')
    )
      return fail(
        call,
        409,
        'Collection definition changed; activate the current application before continuing.',
      );
    const publicInput = call.operation === 'submit_record';
    if (!publicInput) await this.authorize(call, installation);
    try {
      return await this.execute(call, installation, collection, publicInput);
    } catch (error) {
      if (error instanceof CursorValidationError)
        return fail(call, 400, 'Invalid or stale record cursor; restart the query.');
      if (error instanceof NativeStorageLimitError) return fail(call, 409, error.message);
      if (error instanceof PayloadValidationError)
        return fail(
          call,
          400,
          'Record fields do not match the declared collection permissions and schema.',
        );
      throw error;
    }
  }

  private async authorize(call: ConnectorCall, installation: SolutionInstallation): Promise<void> {
    if (call.caller?.identityKind !== 'platform')
      return fail(call, 403, 'A live business grant is required for staff record operations.');
    const permission: BusinessPermission =
      call.operation === 'create_record'
        ? 'records:create'
        : call.operation === 'update_record'
          ? 'records:update'
          : call.operation === 'delete_record'
            ? 'records:delete'
            : 'records:read';
    const grant = await this.dependencies.store.getGrant(installation.scope, call.caller.subject);
    if (!businessGrantAllows(grant, permission))
      return fail(call, 403, 'A live business grant is required for this record operation.');
  }

  private async execute(
    call: ConnectorCall,
    installation: SolutionInstallation,
    collection: InstalledCollectionDefinition,
    publicInput: boolean,
  ): Promise<unknown> {
    const store = this.dependencies.store;
    const scope = installation.scope;
    const actorSubject = call.caller?.subject ?? 'anonymous';
    if (call.operation === 'submit_record' || call.operation === 'create_record') {
      // Validate before receipt probing/admission, and preserve the admitted payload as the replay fingerprint.
      creationPayload(collection, call.args.payload, publicInput);
      const payload = call.args.payload as JsonObject;
      const key = call.execution?.id;
      if (key === undefined) return fail(call, 503, 'A trusted execution identity is required.');
      const request = {
        scope,
        collectionKey: collection.key,
        idempotencyKey: key,
        payload,
        ...(publicInput ? { publicInput: true as const } : {}),
        origin: { kind: 'mcp' as const, reference: 'native-tool' },
        actorSubject,
      };
      const completed = await store.probeRequest(request);
      if (completed.disposition === 'conflict')
        return fail(
          call,
          409,
          'This execution identity was already used with different record content.',
        );
      if (completed.disposition === 'replayed') {
        call.reportOutcome?.({ outcome: 'completed', reference: completed.record.id });
        return publicInput
          ? receipt(completed.record)
          : { ok: true, record: recordToWire(completed.record) };
      }
      if (publicInput) {
        if (!installation.intakeActive || this.dependencies.publicIntakeEnabled === false)
          return fail(call, 503, 'Public record intake is paused.');
        if (call.publicAdmission === undefined || !call.publicAdmission.network)
          return fail(
            call,
            503,
            'Trusted network admission context is required for public record writes.',
          );
        const quota = await admitPublicRecord({
          counters: this.dependencies.counters,
          surfaceId: installation.publicId,
          attempt: {
            key: `solution-intake:logical:${installation.publicId}:${idempotencyDigest(key)}`,
            fingerprint: requestFingerprint(request),
          },
          buckets: call.publicAdmission,
          now: this.dependencies.now?.() ?? new Date(),
        });
        if (!quota.allowed)
          return fail(
            call,
            quota.reason === 'quota_exceeded'
              ? 429
              : quota.reason === 'idempotency_conflict'
                ? 409
                : 503,
            quota.reason === 'quota_exceeded'
              ? 'Public record admission limit exceeded.'
              : 'Public record admission is unavailable.',
          );
      } else await this.authorize(call, installation);
      if (call.signal?.aborted)
        return fail(call, 503, 'Native record write was cancelled before dispatch.');
      const created = await store.createRequest(request);
      if (created.disposition === 'conflict')
        return fail(call, 409, 'Record creation conflicts with the original execution.');
      if (created.disposition === 'paused')
        return fail(call, 503, 'Public record intake is paused.');
      call.reportOutcome?.({ outcome: 'completed', reference: created.record.id });
      return publicInput
        ? receipt(created.record)
        : { ok: true, record: recordToWire(created.record) };
    }
    if (call.operation === 'list_records') {
      const result = await store.listRequests({
        scope,
        collectionKey: collection.key,
        ...(call.args.cursor === undefined ? {} : { cursor: String(call.args.cursor) }),
        ...(call.args.limit === undefined ? {} : { limit: Number(call.args.limit) }),
      });
      return {
        ok: true,
        records: result.records.map(recordToWire),
        ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
      };
    }
    const id = String(call.args.id);
    if (call.operation === 'get_record') {
      const record = await store.getRequest(scope, collection.key, id);
      if (record === undefined) return fail(call, 404, 'Native record was not found.');
      return { ok: true, record: recordToWire(record) };
    }
    await this.authorize(call, installation);
    const mutation = {
      scope,
      collectionKey: collection.key,
      id,
      expectedRevision: Number(call.args.expectedRevision),
      actorSubject,
    };
    if (call.signal?.aborted)
      return fail(call, 503, 'Native record write was cancelled before dispatch.');
    const result =
      call.operation === 'delete_record'
        ? await store.deleteRequest({ ...mutation, reason: 'customer_request' })
        : await store.mutateRequest({
            ...mutation,
            operation: {
              kind: 'update',
              payload: call.args.patch as JsonObject,
              ...(call.args.unset === undefined ? {} : { unset: call.args.unset as string[] }),
            },
          });
    if (!result.ok)
      return fail(
        call,
        result.reason === 'not_found' ? 404 : result.reason === 'conflict' ? 409 : 422,
        'Native record operation was not applied; inspect the current record and revision.',
      );
    call.reportOutcome?.({ outcome: 'completed', reference: result.record.id });
    return call.operation === 'delete_record'
      ? receipt(result.record)
      : { ok: true, record: recordToWire(result.record) };
  }
}

function receipt(record: { readonly id: string; readonly revision: number }) {
  return { ok: true, recordId: record.id, revision: record.revision };
}
function fail(call: ConnectorCall, status: number, message: string): never {
  call.reportOutcome?.({ outcome: 'rejected' });
  throw new ConnectorInvocationError(message, { status, retryable: false });
}
