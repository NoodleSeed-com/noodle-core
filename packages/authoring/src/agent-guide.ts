export type AgentCapabilityKind = 'tool' | 'resource' | 'prompt';

export interface AgentCapabilityRef {
  readonly kind: AgentCapabilityKind;
  readonly name: string;
}

export interface AgentWorkflowStepSource {
  readonly capability: AgentCapabilityRef;
  readonly guidance?: string;
}

export interface AgentWorkflowSource {
  readonly id: string;
  readonly title: string;
  readonly intent?: string;
  readonly steps: readonly AgentWorkflowStepSource[];
}

export interface AgentExampleSource {
  readonly prompt: string;
  readonly workflow: string;
}

/** Host-neutral product guidance, authored once for the complete MCP server surface. */
export interface AgentGuideSource {
  readonly description: string;
  readonly useWhen: readonly string[];
  readonly workflows: readonly AgentWorkflowSource[];
  readonly boundaries?: readonly string[];
  readonly examples?: readonly AgentExampleSource[];
}

/** Clone readonly author input into the generated manifest data boundary. */
export function manifestAgentGuide(source: AgentGuideSource): AgentGuideSource {
  return {
    description: source.description,
    useWhen: [...source.useWhen],
    workflows: source.workflows.map((workflow) => ({
      id: workflow.id,
      title: workflow.title,
      ...(workflow.intent !== undefined ? { intent: workflow.intent } : {}),
      steps: workflow.steps.map((step) => ({
        capability: { ...step.capability },
        ...(step.guidance !== undefined ? { guidance: step.guidance } : {}),
      })),
    })),
    ...(source.boundaries !== undefined ? { boundaries: [...source.boundaries] } : {}),
    ...(source.examples !== undefined
      ? { examples: source.examples.map((example) => ({ ...example })) }
      : {}),
  };
}
