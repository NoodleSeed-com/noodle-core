import type { AppPackageArtifactV1, AppPackageCapabilityKind, AppPackageSurface } from './types.js';

export interface AppPackageCapabilitySelection {
  readonly tools: readonly string[];
  readonly resources: readonly string[];
  readonly prompts: readonly string[];
}

/**
 * Project one validated App Package onto an already-authorized capability set.
 *
 * This helper deliberately knows nothing about callers, roles, scopes, hosts, or transport. The owning
 * surface decides which names are available. Workflows remain atomic, examples follow their workflow, and
 * widgets survive only when their opening tool survives.
 */
export function projectAppPackageCapabilities(
  artifact: AppPackageArtifactV1,
  selection: AppPackageCapabilitySelection,
): AppPackageArtifactV1 | undefined {
  const selected = {
    tool: new Set(selection.tools),
    resource: new Set(selection.resources),
    prompt: new Set(selection.prompts),
  } satisfies Record<AppPackageCapabilityKind, ReadonlySet<string>>;
  const surface = projectSurface(artifact.surface, selected);
  const available = {
    tool: new Set(surface.tools.map((capability) => capability.name)),
    resource: new Set(surface.resources.map((capability) => capability.name)),
    prompt: new Set(surface.prompts.map((capability) => capability.name)),
  } satisfies Record<AppPackageCapabilityKind, ReadonlySet<string>>;
  const workflows = artifact.skill.workflows.filter((workflow) =>
    workflow.steps.every((step) => available[step.capability.kind].has(step.capability.name)),
  );
  if (workflows.length === 0) return undefined;

  const workflowIds = new Set(workflows.map((workflow) => workflow.id));
  return {
    ...artifact,
    skill: {
      ...artifact.skill,
      workflows,
      examples: artifact.skill.examples.filter((example) => workflowIds.has(example.workflow)),
    },
    surface,
  };
}

function projectSurface(
  surface: AppPackageSurface,
  selected: Readonly<Record<AppPackageCapabilityKind, ReadonlySet<string>>>,
): AppPackageSurface {
  const tools = surface.tools.filter((tool) => selected.tool.has(tool.name));
  const toolNames = new Set(tools.map((tool) => tool.name));
  return {
    ...surface,
    tools,
    resources: surface.resources.filter((resource) => selected.resource.has(resource.name)),
    prompts: surface.prompts.filter((prompt) => selected.prompt.has(prompt.name)),
    widgets: surface.widgets.filter((widget) => toolNames.has(widget.tool)),
  };
}
