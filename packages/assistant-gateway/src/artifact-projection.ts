import { MCP_APP_MIME_TYPE, type RuntimeArtifact } from '@noodle-borg/compiler';

/**
 * One surface's view of a deployment's artifact.
 *
 * The design choice worth preserving: this projects the **artifact object**, not the readers. A dozen
 * call sites across the turn, interaction, and execution paths do `artifact.tools.find(...)`; handing
 * each a filtered artifact means an unlisted tool is not hidden but *absent*, so none of them needs to
 * know projection exists. Filtering the readers instead would be a dozen places to forget — and would
 * leave the paths the compiler cannot close over (a `callServerTool` target, an elicitation branch)
 * unguarded at runtime, which is exactly the gap this is the backstop for.
 *
 * It is deliberately a pure filter with no cache. "One projected view per session" means one *seam*,
 * not memoisation; a `(deployment, surface)` memo can be added later if anything measures it.
 */

/** What the author selected for this surface, from the compiled manifest. */
export interface SurfaceCapabilityRef {
  readonly kind: 'tool' | 'resource' | 'prompt' | 'knowledge';
  readonly name: string;
}

export function projectArtifactForSurface(
  artifact: RuntimeArtifact,
  capabilities: readonly SurfaceCapabilityRef[],
): RuntimeArtifact {
  const selected = new Set(
    capabilities.filter((entry) => entry.kind === 'tool').map((entry) => entry.name),
  );
  // Fail closed: an empty selection offers nothing. It must never read as "unset, so offer everything" —
  // that inversion is how a surface silently exposes the whole server.
  const tools = artifact.tools.filter((tool) => selected.has(tool.name));

  // A resource survives only by being linked from a surviving tool. Anything unreferenced — a data
  // resource, a widget whose only tool was dropped — is therefore not public by default, which is what
  // closes `resources/list` and `resources/read` having applied no caller filter at all.
  const linked = new Set(
    tools
      .map(
        (tool) => (tool as { _meta?: { ui?: { resourceUri?: unknown } } })._meta?.ui?.resourceUri,
      )
      .filter((uri): uri is string => typeof uri === 'string'),
  );
  const resources = (artifact.resources ?? []).filter(
    (resource) =>
      linked.has(resource.uri) &&
      (resource.mimeType === MCP_APP_MIME_TYPE || resource.mimeType === undefined),
  );

  // Knowledge follows the same absence rule: an unlisted component projects to nothing, so its
  // generated `search_<name>` tool is simply not part of this surface's artifact.
  const selectedKnowledge = new Set(
    capabilities.filter((entry) => entry.kind === 'knowledge').map((entry) => entry.name),
  );
  const knowledge = (artifact.server.knowledge ?? []).filter((component) =>
    selectedKnowledge.has(component.name),
  );
  if (artifact.server.knowledge === undefined) return { ...artifact, tools, resources };
  return { ...artifact, tools, resources, server: { ...artifact.server, knowledge } };
}
