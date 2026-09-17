import { createHash } from 'node:crypto';
import type { AtomicDailyCounterStore } from '@noodle-borg/admission-limits/portable';
import type { CapabilityBudget } from './budget.js';
import type { WebCapability, WebExtractResult, WebPolicy } from './contracts.js';
import { CapabilityError } from './errors.js';
import { effectiveWebPolicy, executeWebExtract, type PublicPageReaderPort } from './executor.js';
import { WEB_EXTRACT_LIMITS } from './limits.js';
import {
  type CapabilityPolicyRecord,
  type CapabilityPolicyStore,
  type CapabilityPolicyUpdate,
  type CapabilityScope,
  capabilityScopeKey,
} from './policy-store.js';

type Tenant = Pick<CapabilityScope, 'org' | 'app' | 'env'>;
export interface CapabilityServiceOptions {
  readonly profile: 'development' | 'hosted';
  readonly policies: CapabilityPolicyStore;
  readonly counters: AtomicDailyCounterStore;
  readonly reader: PublicPageReaderPort;
  /** Exact hosted cohort targets. Empty or absent disables all hosted extraction. */
  readonly enabledScopes?: readonly Tenant[];
  readonly audit?: (
    fields: Readonly<Record<string, string | number | boolean>> & Tenant,
  ) => void | Promise<void>;
}
export interface CapabilityInvocation {
  readonly tenant: Tenant;
  readonly deploymentId: string;
  readonly executionId: string;
  readonly subject?: string;
  readonly anonymous: boolean;
  readonly network?: string;
  readonly authorized: boolean;
  readonly budget: CapabilityBudget;
  readonly signal?: AbortSignal;
}

/** Policy/admission authority shared by normal tools and operator diagnostics. Never resolves a model. */
export class CapabilityService {
  constructor(readonly options: CapabilityServiceOptions) {
    if (options.profile === 'hosted' && (!options.policies.durable || !options.counters.durable)) {
      throw new Error('capability_durable_authority_required');
    }
  }
  enabled(tenant: Tenant): boolean {
    return (
      this.options.profile === 'development' ||
      (this.options.enabledScopes ?? []).some(
        (scope) => scope.org === tenant.org && scope.app === tenant.app && scope.env === tenant.env,
      )
    );
  }
  async inspect(tenant: Tenant, declaration: WebCapability) {
    const record = await this.options.policies.get({ ...tenant, name: declaration.name });
    const operator = record === undefined ? {} : policyBounds(record.policy);
    return {
      name: declaration.name,
      class: declaration.class,
      title: declaration.title,
      serviceKey: `capability.web-extract.${declaration.name}.provider`,
      available: this.enabled(tenant) && record?.policy.enabled === true,
      profile: this.options.profile === 'hosted' ? 'managed-learning-cohort' : 'local-first-party',
      revision: record?.revision ?? 0,
      developerPolicy: declaration.policy ?? {},
      operatorPolicy: record?.policy ?? { enabled: false, dailyCalls: 100 },
      effectivePolicy: effectiveWebPolicy(declaration.policy, operator),
      ...(record === undefined ? {} : { actor: record.actor, updatedAt: record.updatedAt }),
    };
  }
  async configure(tenant: Tenant, declaration: WebCapability, update: CapabilityPolicyUpdate) {
    const effective = effectiveWebPolicy(declaration.policy, policyBounds(update.policy));
    for (const key of ['maxUrls', 'maxCalls', 'timeoutMs', 'maxTextBytes'] as const) {
      if (update.policy[key] !== undefined && update.policy[key] !== effective[key])
        throw new CapabilityError('capability_policy_denied');
    }
    if (update.policy.domains?.some((host) => !effective.domains?.includes(host)))
      throw new CapabilityError('capability_policy_denied');
    return this.options.policies.replace({ ...tenant, name: declaration.name }, update);
  }
  async execute(
    declaration: WebCapability,
    input: unknown,
    context: CapabilityInvocation,
    reader: PublicPageReaderPort = this.options.reader,
  ): Promise<WebExtractResult> {
    const scope = { ...context.tenant, name: declaration.name };
    if (!this.enabled(context.tenant)) throw new CapabilityError('capability_unavailable');
    let record: CapabilityPolicyRecord | undefined;
    try {
      record = await this.options.policies.get(scope);
    } catch {
      throw new CapabilityError('capability_unavailable');
    }
    if (record?.policy.enabled !== true) throw new CapabilityError('capability_unavailable');
    if (context.anonymous && !context.network)
      throw new CapabilityError('capability_policy_denied');
    if (!context.anonymous && !context.subject)
      throw new CapabilityError('capability_policy_denied');
    const scopeId = opaque(capabilityScopeKey(scope));
    const amount = WEB_EXTRACT_LIMITS.maxHttpAttempts;
    const attribution = context.anonymous
      ? `network:${context.network}`
      : `subject:${context.subject}`;
    const started = Date.now();
    try {
      const result = await executeWebExtract(declaration, input, {
        reader,
        enabled: true,
        authorized: context.authorized,
        budget: context.budget,
        operatorPolicy: policyBounds(record.policy),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
        admit: async () => {
          const requests = [
            { key: 'capability:web-extract:fleet', amount, limit: 1000 * amount },
            { key: `capability:${scopeId}`, amount, limit: record.policy.dailyCalls * amount },
            {
              key: `capability:caller:${opaque(`${scopeId}:${attribution}`)}`,
              amount,
              limit: 10 * amount,
            },
            ...(context.network === undefined
              ? []
              : [
                  {
                    key: `capability:network:${opaque(context.network)}`,
                    amount,
                    limit: 30 * amount,
                  },
                ]),
          ];
          const attempt = {
            key: `capability:attempt:${opaque(`${scopeId}:${context.deploymentId}:${context.executionId}`)}`,
            fingerprint: opaque(JSON.stringify(input)),
          };
          const outcome = await this.options.counters.consumeAllOnce(requests, attempt, new Date());
          // A replay is not a cache hit: there is no retained source body, so it cannot authorize more I/O.
          return outcome.kind === 'consumed';
        },
      });
      await this.options.audit?.({
        ...context.tenant,
        class: declaration.class,
        scope: scopeId,
        policyRevision: record.revision,
        status: result.status,
        pages: result.items.length,
        elapsedMs: Date.now() - started,
      });
      return result;
    } catch (error) {
      const safe =
        error instanceof CapabilityError ? error : new CapabilityError('capability_unavailable');
      await Promise.resolve()
        .then(() =>
          this.options.audit?.({
            ...context.tenant,
            class: declaration.class,
            scope: scopeId,
            policyRevision: record.revision,
            status: safe.code,
            elapsedMs: Date.now() - started,
          }),
        )
        .catch(() => {});
      throw safe;
    }
  }
}

function opaque(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function policyBounds(policy: WebPolicy & { enabled: boolean; dailyCalls: number }): WebPolicy {
  const { enabled: _enabled, dailyCalls: _daily, ...bounds } = policy;
  return bounds;
}
