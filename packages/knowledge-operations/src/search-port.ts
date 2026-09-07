/**
 * Adapts the knowledge search executor to the runtime's deployment-bound port shape
 * (structurally typed against `@noodle-borg/runtime`'s `KnowledgeSearchPort`): tenant and
 * component set are bound once per deployment; failures become typed refusals, never partial
 * answers, and no provider detail crosses the port.
 */
import {
  KnowledgeError,
  SearchBudgetExhaustedError,
  type SearchHit,
} from '@noodle-borg/knowledge/portable';
import type { KnowledgeSearchComponent, KnowledgeSearchExecutor } from './executor.js';
import type { KnowledgeTenantRef } from './routes.js';

export interface BoundKnowledgeSearchPort {
  enabled(): Promise<boolean>;
  search(
    componentName: string,
    request: { readonly query: string; readonly limit?: number },
  ): Promise<
    | { readonly ok: true; readonly hits: readonly SearchHit[] }
    | {
        readonly ok: false;
        readonly reason: 'budget_exhausted' | 'not_enabled' | 'provider_error';
        readonly message: string;
      }
  >;
}

export type KnowledgeSearchPortFactory = (
  tenant: { readonly org: string; readonly app: string; readonly env: string },
  components: readonly KnowledgeSearchComponent[],
) => BoundKnowledgeSearchPort;

export function knowledgeSearchPortFactory(
  executor: KnowledgeSearchExecutor,
): KnowledgeSearchPortFactory {
  return (tenant, components) => bindKnowledgeSearchPort(executor, tenant, components);
}

export function bindKnowledgeSearchPort(
  executor: KnowledgeSearchExecutor,
  tenant: KnowledgeTenantRef,
  components: readonly KnowledgeSearchComponent[],
): BoundKnowledgeSearchPort {
  return {
    enabled: () => executor.enabled(tenant),
    async search(componentName, request) {
      const component = components.find((candidate) => candidate.name === componentName);
      if (component === undefined) {
        return { ok: false, reason: 'provider_error', message: 'unknown knowledge component' };
      }
      try {
        const hits = await executor.search(tenant, component, request);
        return { ok: true, hits };
      } catch (error) {
        if (error instanceof SearchBudgetExhaustedError) {
          return { ok: false, reason: 'budget_exhausted', message: error.message };
        }
        if (error instanceof KnowledgeError) {
          const reason = error.layer === 'request' ? 'not_enabled' : 'provider_error';
          return { ok: false, reason, message: error.message };
        }
        return { ok: false, reason: 'provider_error', message: 'knowledge search failed' };
      }
    },
  };
}
