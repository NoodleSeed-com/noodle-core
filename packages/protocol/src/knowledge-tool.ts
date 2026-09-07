/**
 * The generated `search_<name>` tool (ADR 0202 D4), shared by both era handlers. Like
 * `noodle_context`, it is a reserved non-fulfilment tool: listed from `server.knowledge`,
 * executed through the injected deployment-bound port, never through the fulfilment engine.
 * Gate off (or no port) ⇒ the tool is absent from listing and unknown at call time.
 */
import type { RuntimeArtifact } from '@noodle-borg/compiler';
import type { ExecuteDeps, KnowledgeSearchHit } from '@noodle-borg/runtime';
import { coerceToolArguments } from './input-validation.js';

type KnowledgeComponent = NonNullable<RuntimeArtifact['server']['knowledge']>[number];

export function findKnowledgeComponent(
  artifact: RuntimeArtifact,
  toolName: string,
): KnowledgeComponent | undefined {
  return artifact.server.knowledge?.find((component) => component.generatedTool.name === toolName);
}

/** Listing predicate: the artifact declares knowledge AND the deployment's port is live. */
export async function knowledgeToolsEnabled(
  artifact: RuntimeArtifact,
  deps: ExecuteDeps,
): Promise<boolean> {
  if ((artifact.server.knowledge?.length ?? 0) === 0) return false;
  if (deps.knowledgeSearch === undefined) return false;
  return deps.knowledgeSearch.enabled();
}

export type KnowledgeCallOutcome =
  | { readonly kind: 'invalid'; readonly issues: readonly unknown[] }
  | { readonly kind: 'error'; readonly reason: string; readonly message: string }
  | { readonly kind: 'ok'; readonly output: { readonly hits: readonly KnowledgeSearchHit[] } };

export async function runKnowledgeSearchTool(
  component: KnowledgeComponent,
  deps: ExecuteDeps,
  rawArguments: Record<string, unknown>,
): Promise<KnowledgeCallOutcome> {
  const coerced = coerceToolArguments(component.generatedTool.inputSchema, rawArguments);
  if (coerced.issues.length > 0) return { kind: 'invalid', issues: coerced.issues };
  if (deps.knowledgeSearch === undefined) {
    return { kind: 'error', reason: 'not_enabled', message: 'knowledge search is unavailable' };
  }
  const request = coerced.value as { query: string; limit?: number };
  const outcome = await deps.knowledgeSearch.search(component.name, request);
  if (!outcome.ok) return { kind: 'error', reason: outcome.reason, message: outcome.message };
  return { kind: 'ok', output: { hits: outcome.hits } };
}
