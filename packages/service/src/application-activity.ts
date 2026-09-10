import { createHmac } from 'node:crypto';
import { canonicalJson, sha256Canonical } from '@noodle-borg/compiler';
import type {
  ActivityHistoryAllowance,
  ResolveActivityHistoryAllowance,
} from '@noodle-borg/module';
import type { ServedTarget } from '@noodle-borg/transport-http';
import {
  ApplicationActivityListResponseSchema,
  ApplicationActivityPreviewResponseSchema,
  ApplicationActivitySettingsResponseSchema,
  ApplicationActivitySettingsSaveRequestSchema,
  OperationCoordinationListRequestSchema,
  OperationCoordinationListResponseSchema,
  OperationCoordinationResolveRequestSchema,
  OperationCoordinationResolveResponseSchema,
} from '@noodle-borg/wire-contracts';
import { resolveApplicationRuntimeTarget } from './application-runtime-target.js';
import type {
  BusinessInformationStore,
  InstallationScope,
} from './business-information/contracts.js';
import type { ApplicationConnections } from './connections/types.js';
import {
  createOperationCoordinationPort,
  type OperationCoordinationStore,
} from './operation-coordination.js';
import {
  createOperationEvidencePort,
  type OperationEvidenceCursor,
  type OperationEvidenceStore,
  type OperationHistorySetting,
} from './operation-evidence.js';
import type { ServerRegistry } from './registry.js';

export type { ActivityHistoryAllowance } from '@noodle-borg/module';
export interface ApplicationActivityOptions {
  readonly store: OperationEvidenceStore;
  readonly epoch: string;
  readonly identityKey: string;
  readonly allowance: ResolveActivityHistoryAllowance;
  readonly now?: () => number;
  readonly coordination?: OperationCoordinationStore;
}
export type ActivityProjectionAction =
  | 'list'
  | 'export'
  | 'preview'
  | 'settings'
  | 'save-settings'
  | 'coordination-list'
  | 'coordination-resolve';
const POLICY_MESSAGES = {
  activity_conflict: 'History settings or plan changed. Reload before continuing.',
  activity_invalid: 'Activity paging or retention is invalid for the current policy.',
  activity_unavailable: 'Verified activity history policy is unavailable.',
  coordination_invalid: 'Invalid coordination request.',
  coordination_conflict:
    'The operation is active, changed, or unavailable. Inspect the current state before reviewing it again.',
  coordination_unavailable: 'Verified coordination state is unavailable.',
} as const;
export class ActivityPolicyError extends Error {
  constructor(readonly code: keyof typeof POLICY_MESSAGES) {
    super(POLICY_MESSAGES[code]);
  }
}

/** One verified plan projection governs current access and the ceiling on newly assigned expiry. */
export class ApplicationActivity {
  constructor(readonly options: ApplicationActivityOptions) {}
  /** Shared strict operator projection. Callers authorize the live installation grant before and after it. */
  async project(
    scope: InstallationScope,
    action: ActivityProjectionAction,
    input: {
      readonly parameters: readonly (readonly [string, string])[];
      readonly body?: unknown;
      readonly canEdit: boolean;
      readonly reviewer: string;
    },
  ) {
    const coordinating = action.startsWith('coordination');
    const invalid = () =>
      new ActivityPolicyError(coordinating ? 'coordination_invalid' : 'activity_invalid');
    const allowed =
      action === 'coordination-list'
        ? ['limit', 'beforeResource']
        : action === 'list' || action === 'export'
          ? ['limit', 'cursor']
          : [];
    const parameters = new Map<string, string>();
    for (const [key, value] of input.parameters) {
      if (!allowed.includes(key) || parameters.has(key)) throw invalid();
      parameters.set(key, value);
    }
    const mutation = <Response>(
      response: Response,
      eventType: string,
      details: Readonly<Record<string, string | number>>,
    ) => ({
      response,
      audit: { eventType, details },
    });
    if (action === 'coordination-resolve') {
      const parsed = OperationCoordinationResolveRequestSchema.safeParse(input.body);
      if (!parsed.success) throw invalid();
      const store = this.options.coordination;
      if (!store) throw new ActivityPolicyError('coordination_unavailable');
      let resolved: boolean;
      try {
        resolved = await store.resolve(scope, parsed.data.resource, parsed.data.token, {
          reviewer: input.reviewer,
          reason: parsed.data.reason,
        });
      } catch {
        throw new ActivityPolicyError('coordination_unavailable');
      }
      if (!resolved) throw new ActivityPolicyError('coordination_conflict');
      return mutation(
        OperationCoordinationResolveResponseSchema.parse({ ok: true, data: { resolved: true } }),
        'config.operation.coordination_resolved',
        { resource: parsed.data.resource },
      );
    }
    if (action === 'coordination-list') {
      const parsed = OperationCoordinationListRequestSchema.safeParse({
        ...(parameters.has('limit') ? { limit: Number(parameters.get('limit')) } : {}),
        ...(parameters.has('beforeResource')
          ? { beforeResource: parameters.get('beforeResource') }
          : {}),
      });
      if (!parsed.success) throw invalid();
      const store = this.options.coordination;
      if (!store) throw new ActivityPolicyError('coordination_unavailable');
      try {
        const limit = parsed.data.limit ?? 100;
        const records = await store.list(scope, limit, parsed.data.beforeResource);
        if (records.some((record) => canonicalJson(record.scope) !== canonicalJson(scope)))
          throw new Error('Coordination scope mismatch');
        return {
          response: OperationCoordinationListResponseSchema.parse({
            ok: true,
            data: {
              records: records.map(
                ({ resource, token, reference, operationDigest, startedAt, deadline, state }) => ({
                  resource,
                  token,
                  reference,
                  operationDigest,
                  startedAt: new Date(startedAt).toISOString(),
                  deadline: new Date(deadline).toISOString(),
                  state,
                }),
              ),
              ...(records.length === limit ? { nextBeforeResource: records.at(-1)?.resource } : {}),
            },
          }),
        };
      } catch {
        throw new ActivityPolicyError('coordination_unavailable');
      }
    }
    if (action === 'save-settings') {
      const parsed = ApplicationActivitySettingsSaveRequestSchema.safeParse(input.body);
      if (!parsed.success) throw invalid();
      const data = await this.save(scope, parsed.data);
      return mutation(
        ApplicationActivitySettingsResponseSchema.parse({ ok: true, data }),
        'config.activity.retention_changed',
        { retentionDays: data.retentionDays },
      );
    }
    if (action === 'preview')
      return {
        response: ApplicationActivityPreviewResponseSchema.parse({
          ok: true,
          data: await this.preview(scope),
        }),
      };
    if (action === 'settings')
      return {
        response: ApplicationActivitySettingsResponseSchema.parse({
          ok: true,
          data: (await this.settings(scope, input.canEdit)).projection,
        }),
      };
    const limit = parameters.has('limit') ? Number(parameters.get('limit')) : 50;
    const cursor = parameters.get('cursor');
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (cursor !== undefined && (!cursor || cursor.length > 2048))
    )
      throw invalid();
    return {
      response: ApplicationActivityListResponseSchema.parse({
        ok: true,
        data: await this.page(scope, {
          purpose: action,
          limit,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      }),
    };
  }
  async settings(scope: InstallationScope, canEdit: boolean) {
    const allowance = await this.options.allowance(scope.org);
    if (
      !allowance ||
      !validDays(allowance.maximumDays) ||
      !validDays(allowance.defaultDays) ||
      allowance.defaultDays > allowance.maximumDays ||
      !allowance.revision
    )
      throw new ActivityPolicyError('activity_unavailable');
    let setting = await this.options.store.readRetention(scope);
    if (!setting) {
      await this.options.store.setRetention(scope, allowance.defaultDays, undefined);
      setting = await this.options.store.readRetention(scope);
    }
    if (!setting || !validDays(setting.days)) throw new ActivityPolicyError('activity_unavailable');
    return {
      setting,
      allowance,
      projection: {
        revision: this.revision(scope, setting, allowance),
        retentionDays: Math.min(setting.days, allowance.maximumDays),
        maximumDays: allowance.maximumDays,
        canEdit,
      },
    };
  }
  async save(scope: InstallationScope, input: { expectedRevision: string; retentionDays: number }) {
    const current = await this.settings(scope, true);
    if (current.projection.revision !== input.expectedRevision)
      throw new ActivityPolicyError('activity_conflict');
    if (!validDays(input.retentionDays) || input.retentionDays > current.allowance.maximumDays)
      throw new ActivityPolicyError('activity_invalid');
    if (
      !(await this.options.store.setRetention(scope, input.retentionDays, current.setting.revision))
    )
      throw new ActivityPolicyError('activity_conflict');
    return (await this.settings(scope, true)).projection;
  }
  async page(
    scope: InstallationScope,
    input: {
      readonly purpose: 'list' | 'export';
      readonly limit: number;
      readonly cursor?: string;
    },
  ) {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
      throw new ActivityPolicyError('activity_invalid');
    const policy = (await this.settings(scope, false)).projection;
    const binding = this.hash({
      purpose: `activity-${input.purpose}-v1`,
      scope,
      revision: policy.revision,
      limit: input.limit,
    });
    const records = await this.options.store.list(
      scope,
      this.options.now?.() ?? Date.now(),
      policy.maximumDays,
      input.limit + 1,
      decodeActivityCursor(input.cursor, binding),
    );
    if ((await this.settings(scope, false)).projection.revision !== policy.revision)
      throw new ActivityPolicyError('activity_conflict');
    const page = records.slice(0, input.limit);
    const last = page.at(-1);
    return {
      activities: page.map(
        ({
          id,
          tool,
          operation,
          connectionId,
          actorDigest,
          outcome,
          startedAt,
          completedAt,
          reference,
        }) => ({
          id,
          tool,
          operation,
          actorReference: this.hash({ purpose: 'activity-actor-v1', scope, actorDigest }),
          ...(connectionId === undefined ? {} : { connectionId }),
          outcome,
          startedAt: new Date(startedAt).toISOString(),
          ...(completedAt === undefined
            ? {}
            : { completedAt: new Date(completedAt).toISOString() }),
          ...(reference === undefined ? {} : { reference }),
        }),
      ),
      historyDays: policy.maximumDays,
      ...(records.length > page.length && last
        ? {
            nextCursor: Buffer.from(
              JSON.stringify({ binding, startedAt: last.startedAt, id: last.id }),
            ).toString('base64url'),
          }
        : {}),
    };
  }
  private hash(value: unknown) {
    return createHmac('sha256', this.options.identityKey)
      .update(canonicalJson(value))
      .digest('hex');
  }
  private revision(
    scope: InstallationScope,
    setting: OperationHistorySetting,
    allowance: ActivityHistoryAllowance,
  ) {
    return sha256Canonical({ scope, setting, allowance });
  }
  async preview(scope: InstallationScope) {
    const unavailable = () => {
      throw new ActivityPolicyError('activity_unavailable');
    };
    const resolve = () =>
      this.options.allowance(scope.org, { includePreview: true }).catch(unavailable);
    const allowance = await resolve();
    if (
      !allowance ||
      !validDays(allowance.maximumDays) ||
      !validDays(allowance.defaultDays) ||
      allowance.defaultDays > allowance.maximumDays ||
      !allowance.revision
    )
      throw new ActivityPolicyError('activity_unavailable');
    const preview = allowance.preview;
    if (!preview)
      return { state: 'unavailable' as const, reason: 'no_verified_paid_period' as const };
    const asOf = Date.parse(preview.asOf);
    const paidPeriodEnd = Date.parse(preview.paidPeriodEnd);
    if (
      !Number.isSafeInteger(asOf) ||
      !Number.isSafeInteger(paidPeriodEnd) ||
      paidPeriodEnd <= asOf ||
      preview.scenarios.length < 1 ||
      preview.scenarios.length > 2 ||
      new Set(preview.scenarios.map(({ id }) => id)).size !== preview.scenarios.length ||
      preview.scenarios.some(
        ({ id, label, maximumDays }) =>
          !id ||
          id.length > 128 ||
          !label ||
          label.length > 128 ||
          !validDays(maximumDays) ||
          maximumDays >= allowance.maximumDays,
      )
    )
      throw new ActivityPolicyError('activity_unavailable');
    const counts = await this.options.store
      .preview(scope, {
        asOf,
        paidPeriodEnd,
        currentMaximumDays: allowance.maximumDays,
        scenarios: preview.scenarios,
      })
      .catch(unavailable);
    const current = await resolve();
    if (current?.revision !== allowance.revision)
      throw new ActivityPolicyError('activity_conflict');
    return {
      state: 'available' as const,
      kind: 'hypothetical' as const,
      asOf: new Date(asOf).toISOString(),
      paidPeriodEnd: new Date(paidPeriodEnd).toISOString(),
      revision: this.hash({
        purpose: 'activity-preview-v1',
        scope,
        allowance: allowance.revision,
        preview,
        counts,
      }),
      currentMaximumDays: allowance.maximumDays,
      currentlyAccessibleCount: counts.currentlyAccessibleCount,
      physicallyExpiresByPeriodEndCount: counts.physicallyExpiresByPeriodEndCount,
      scenarios: preview.scenarios.map((scenario, index) => ({
        ...scenario,
        additionallyHiddenAtPeriodEndCount:
          counts.scenarios[index]?.additionallyHiddenAtPeriodEndCount ?? 0,
      })),
    };
  }
  async bind(
    target: ServedTarget,
    deps: {
      installations: BusinessInformationStore;
      registry: ServerRegistry;
      connections?: ApplicationConnections;
    },
  ): Promise<ServedTarget> {
    if (!target.org || !target.app || !target.environment || !target.deploymentId) return target;
    const matching = (await deps.installations.listInstallations(target.org)).filter(
      (item) => item.scope.app === target.app && item.scope.env === target.environment,
    );
    if (matching.length === 0) return target;
    const installation = matching[0];
    if (!installation || matching.length !== 1)
      throw new ActivityPolicyError('activity_unavailable');
    const scope = installation.scope;
    const revision = target.served.deps.executionBinding?.revision;
    const epochRevision = sha256Canonical({ revision, epoch: this.options.epoch });
    const authorize = async () => {
      const active = await deps.registry.getActiveByTenant({
        org: scope.org,
        app: scope.app,
        env: scope.env,
      });
      if (!active || active.deploymentId !== target.deploymentId) return false;
      const current = await resolveApplicationRuntimeTarget(
        active,
        deps.installations,
        deps.connections?.readGenerations,
      );
      return (
        !!current &&
        revision !== undefined &&
        current.served.deps.executionBinding?.revision === revision
      );
    };
    const evidence = createOperationEvidencePort({
      ...this.options,
      scope,
      deploymentId: target.deploymentId,
      historyDays: async () => (await this.settings(scope, false)).projection.retentionDays,
      executionBoundMs: (intent) => intent.executionBoundMs,
      connectionGeneration: (id) =>
        target.served.deps.executionBinding?.connections[id] ?? revision,
      authorize,
    });
    const coordination =
      this.options.coordination &&
      createOperationCoordinationPort({
        ...this.options,
        store: this.options.coordination,
        scope,
        authorize,
        connectionGeneration: (id) => target.served.deps.executionBinding?.connections[id],
      });
    return {
      ...target,
      served: {
        ...target.served,
        deps: {
          ...target.served.deps,
          operationEvidence: evidence,
          ...(coordination ? { operationCoordination: coordination } : {}),
          executionBinding: {
            revision: epochRevision,
            connections: target.served.deps.executionBinding?.connections ?? {},
          },
        },
      },
    };
  }
}
function validDays(value: number) {
  return Number.isInteger(value) && value >= 1 && value <= 365;
}

function decodeActivityCursor(
  raw: string | undefined,
  binding: string,
): OperationEvidenceCursor | undefined {
  if (raw === undefined) return undefined;
  try {
    if (raw.length > 2048) throw new Error();
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString());
    if (
      value.binding !== binding ||
      !Number.isSafeInteger(value.startedAt) ||
      value.startedAt < 0 ||
      typeof value.id !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.id)
    )
      throw new Error();
    return { startedAt: value.startedAt, id: value.id };
  } catch {
    throw new ActivityPolicyError('activity_invalid');
  }
}
