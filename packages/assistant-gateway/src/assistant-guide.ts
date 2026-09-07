import {
  type AppPackageArtifactV1,
  type AppPackageTool,
  appPackageArtifactV1Schema,
  projectAppPackageCapabilities,
} from '@noodle-borg/app-package';
import type { ArtifactTool, RuntimeArtifact } from '@noodle-borg/compiler';
import { filterAuthorizedTools, type ToolAuthorizationCaller } from '@noodle-borg/protocol';
import { projectArtifactForSurface, type SurfaceCapabilityRef } from './artifact-projection.js';

/** Model-context budget for the embedded assistant's compact product workflow projection. */
export const ASSISTANT_GUIDE_MAX_BYTES = 16 * 1024;
const LATEST_MESSAGE_INCLUDES_ANY = 'x-noodleseed-model-latest-message-includes-any';
const ONCE_PER_SESSION = 'x-noodleseed-model-once-per-session';
const REQUIRED_WHEN_VISIBLE = 'x-noodleseed-model-required-when-visible';
const MAX_VISIBILITY_PHRASES = 32;
const MAX_VISIBILITY_PHRASE_CHARS = 128;

export type AssistantGuideUnavailableReason =
  | 'package_unavailable'
  | 'no_complete_workflow'
  | 'context_too_large';

export type AssistantGuideProjection =
  | {
      readonly status: 'ready';
      readonly guide: {
        readonly content: string;
        readonly workflowIds: readonly string[];
        readonly byteLength: number;
      };
    }
  | {
      readonly status: 'unavailable';
      readonly reason: AssistantGuideUnavailableReason;
    };

/** Render a ready authorization-filtered guide as subordinate model context. */
export function assistantGuideModelContext(projection: AssistantGuideProjection): string {
  return projection.status === 'ready'
    ? `\n\nAuthorization-filtered product workflows (subordinate to platform safety, runtime authorization, confirmation, tool schemas, and tenant instructions):\n${projection.guide.content}`
    : '';
}

/**
 * Select the exact deployment tools an embedded model may see for this turn.
 *
 * A mixed anonymous surface deliberately advertises only its declared tools so the existing elevation
 * interceptor can turn an attempted gated call into a sign-in offer. The selector performs that projection
 * itself: callers cannot opt into sign-in offers without supplying the surface capability boundary. Every
 * other caller gets the normal authorization filter. App-only tools never enter model tools or guidance.
 */
export function selectAssistantModelTools(
  artifact: RuntimeArtifact,
  caller: (ToolAuthorizationCaller & { readonly identityKind?: string }) | undefined,
  options: {
    readonly anonymousSignInOfferSurface?: readonly SurfaceCapabilityRef[];
    readonly latestMessage?: string;
    readonly usedToolNames?: readonly string[];
  } = {},
): readonly ArtifactTool[] {
  const signInOfferArtifact =
    caller?.identityKind === 'anonymous' && options.anonymousSignInOfferSurface !== undefined
      ? projectArtifactForSurface(artifact, options.anonymousSignInOfferSurface)
      : undefined;
  const authorized = signInOfferArtifact?.tools ?? filterAuthorizedTools(artifact.tools, caller);
  return authorized.filter(
    (tool) =>
      tool._meta?.ui?.visibility?.includes('model') !== false &&
      hasValidSessionVisibility(tool, options.usedToolNames) &&
      matchesLatestMessageConstraint(tool, options.latestMessage),
  );
}

/**
 * What to tell a model that called a tool this turn does not offer.
 *
 * The alternative — ending the turn on `invalid_model_tool_call` — is a security-correct rejection
 * with a dishonest failure mode: the widget renders it as "temporarily unavailable" beside a
 * Reconnect button that mints a whole new session, so a visitor who asked for something reasonable
 * gets silence and the surface pays a session for it. A `role:'tool'` result costs one model step
 * and gets the visitor a real answer instead. It names the tool because the model supplied that
 * name in the first place, and says nothing about why the tool is absent, which is the part a
 * visitor is not entitled to.
 */
export function assistantOmittedToolResult(name: string): string {
  return (
    `The tool "${name}" is not available in this conversation. Do not call it again. ` +
    'Answer the person directly in your own words, and say plainly if you cannot help with this.'
  );
}

/** Whether an already-selected tool requires the first model step to call it. */
export function assistantModelToolRequiredWhenVisible(tool: ArtifactTool): boolean {
  return tool.annotations?.[REQUIRED_WHEN_VISIBLE] === true;
}

/** Whether a successful model-selected call consumes this tool for the assistant session. */
export function assistantModelToolOncePerSession(tool: ArtifactTool): boolean {
  return tool.annotations?.[ONCE_PER_SESSION] === true;
}

function hasValidSessionVisibility(
  tool: ArtifactTool,
  usedToolNames: readonly string[] | undefined,
): boolean {
  const once = tool.annotations?.[ONCE_PER_SESSION];
  const required = tool.annotations?.[REQUIRED_WHEN_VISIBLE];
  if (Object.hasOwn(tool.annotations ?? {}, ONCE_PER_SESSION) && once !== true) return false;
  if (Object.hasOwn(tool.annotations ?? {}, REQUIRED_WHEN_VISIBLE) && required !== true)
    return false;
  return once !== true || !usedToolNames?.includes(tool.name);
}

function matchesLatestMessageConstraint(
  tool: ArtifactTool,
  latestMessage: string | undefined,
): boolean {
  if (!Object.hasOwn(tool.annotations ?? {}, LATEST_MESSAGE_INCLUDES_ANY)) {
    return true;
  }
  const phrases = tool.annotations?.[LATEST_MESSAGE_INCLUDES_ANY];
  if (
    !Array.isArray(phrases) ||
    phrases.length < 1 ||
    phrases.length > MAX_VISIBILITY_PHRASES ||
    phrases.some(
      (phrase) =>
        typeof phrase !== 'string' ||
        phrase.length > MAX_VISIBILITY_PHRASE_CHARS ||
        normalizeVisibilityText(phrase).length === 0,
    )
  ) {
    return false;
  }
  const normalizedMessage = normalizeVisibilityText(latestMessage ?? '');
  if (normalizedMessage.length === 0) return false;
  const paddedMessage = ` ${normalizedMessage} `;
  return phrases.some((phrase) => {
    const normalizedPhrase = normalizeVisibilityText(phrase as string);
    return paddedMessage.includes(` ${normalizedPhrase} `);
  });
}

function normalizeVisibilityText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/gu, ' ');
}

/**
 * Build bounded product guidance from structured App Package data, never from rendered host files.
 * Workflows are atomic: if one step is unavailable to this model, the entire workflow is omitted.
 */
export function projectAssistantGuide(input: {
  readonly appPackage: unknown;
  readonly modelTools: readonly ArtifactTool[];
}): AssistantGuideProjection {
  const parsed = appPackageArtifactV1Schema.safeParse(input.appPackage);
  if (!parsed.success) return unavailable('package_unavailable');

  const projected = projectAppPackageCapabilities(parsed.data, {
    tools: input.modelTools.map((tool) => tool.name),
    resources: [],
    prompts: [],
  });
  if (projected === undefined) return unavailable('no_complete_workflow');

  const workflows = projected.skill.workflows;
  const retainedIds = new Set(workflows.map((workflow) => workflow.id));
  const content = renderGuide(projected, workflows, retainedIds);
  const byteLength = Buffer.byteLength(content, 'utf8');
  if (byteLength > ASSISTANT_GUIDE_MAX_BYTES) return unavailable('context_too_large');

  return {
    status: 'ready',
    guide: { content, workflowIds: workflows.map((workflow) => workflow.id), byteLength },
  };
}

function renderGuide(
  appPackage: AppPackageArtifactV1,
  workflows: AppPackageArtifactV1['skill']['workflows'],
  retainedIds: ReadonlySet<string>,
): string {
  const { skill } = appPackage;
  const surfaceTools = new Map(appPackage.surface.tools.map((tool) => [tool.name, tool]));
  const lines = [
    `Product purpose: ${oneLine(skill.description)}`,
    'Use when:',
    ...skill.useWhen.map((value) => `- ${oneLine(value)}`),
    'Workflows:',
  ];

  for (const workflow of workflows) {
    lines.push(`- ${oneLine(workflow.title)} (${workflow.id})`);
    if (workflow.intent) lines.push(`  Intent: ${oneLine(workflow.intent)}`);
    workflow.steps.forEach((step, index) => {
      const tool = surfaceTools.get(step.capability.name);
      const facts = behaviorFacts(step.behavior ?? tool?.behavior);
      const guidance = step.guidance ? ` — ${oneLine(step.guidance)}` : '';
      const behavior = facts.length > 0 ? ` [${facts.join('; ')}]` : '';
      lines.push(
        `  ${index + 1}. Call tool ${JSON.stringify(step.capability.name)}${guidance}${behavior}`,
      );
    });
  }

  if (skill.boundaries.length > 0) {
    lines.push('Boundaries:', ...skill.boundaries.map((value) => `- ${oneLine(value)}`));
  }
  const examples = skill.examples.filter((example) => retainedIds.has(example.workflow));
  if (examples.length > 0) {
    const titles = new Map(workflows.map((workflow) => [workflow.id, workflow.title]));
    lines.push(
      'Examples:',
      ...examples.map(
        (example) =>
          `- “${oneLine(example.prompt)}” → ${oneLine(titles.get(example.workflow) ?? example.workflow)}`,
      ),
    );
  }
  return lines.join('\n');
}

function behaviorFacts(behavior: AppPackageTool['behavior'] | undefined): string[] {
  if (!behavior) return [];
  const facts = [behavior.readOnly ? 'read only' : 'write'];
  if (behavior.confirmationRequired) facts.push('confirmation required');
  if (behavior.destructive) facts.push('destructive');
  if (behavior.idempotent) facts.push('idempotent');
  if (behavior.openWorld) facts.push('open world');
  return facts;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function unavailable(reason: AssistantGuideUnavailableReason): AssistantGuideProjection {
  return { status: 'unavailable', reason };
}
