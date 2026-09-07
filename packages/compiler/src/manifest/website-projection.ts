import type {
  ArtifactFulfilment,
  ArtifactPrompt,
  ArtifactResource,
  ArtifactStep,
  ArtifactTool,
} from '../artifact/types.js';
import type { CompileError } from '../errors.js';
import { type CondNode, collectPaths, type ExprNode } from './expression.js';

/**
 * Compile-time enforcement of website assistant surfaces (ADR 0201, amended 2026-08-12). These are
 * not runtime rejections — they are states the artifact must be unable to represent:
 *
 * 1. **Resolution.** A projected name that no component declares would narrow the surface silently.
 * 2. **No identity on a `public` surface.** An anonymous caller resolves `${user...}` to nothing, and
 *    "nothing" is how a filter accidentally returns everyone's data. The same capability on a `mixed`
 *    surface is legal — there it is the sign-in trigger, as ChatGPT prompts to link an account.
 * 3. **Two declarations.** A side effect is reachable publicly only when the author projected it *and*
 *    set `confirm: true`; fail-closed, so an unannotated tool counts as an effect.
 *
 * An `authenticated` surface serves a verified person and is unconstrained by 2 and 3.
 *
 * `anonymousBehavior` is exported for the elevation runtime rather than emitted into the artifact: it is
 * re-derived per call, because a new `ArtifactTool` field would be a Core surface change under ADR 0150.
 * ADR 0055's third class — a declared anonymous fallback — stays reserved, not produced.
 */

interface AssistantSurfaceInput {
  readonly mode: 'authenticated' | 'public' | 'mixed';
  readonly capabilities?: readonly { readonly kind: string; readonly name: string }[] | undefined;
}

export interface AssistantProjectionInput {
  readonly surfaces?: readonly AssistantSurfaceInput[] | undefined;
}

export interface WebsiteProjectionSurfaces {
  readonly tools: readonly ArtifactTool[];
  readonly resources: readonly ArtifactResource[];
  readonly prompts: readonly ArtifactPrompt[];
  /** Compiled knowledge components (ADR 0202): projectable as `knowledge` capabilities. */
  readonly knowledge?: readonly { readonly name: string }[] | undefined;
}

/** A tool touches identity when it reads `${user}` or requires verified claims (ADR 0185). */
export function anonymousBehavior(tool: ArtifactTool): 'public-safe' | 'requires-identity' {
  if (tool.authorization !== undefined) return 'requires-identity';
  return readsUser(tool.fulfilment) ? 'requires-identity' : 'public-safe';
}

export function validateWebsiteProjection(
  assistant: AssistantProjectionInput | undefined,
  surfaces: WebsiteProjectionSurfaces,
): readonly CompileError[] {
  if (assistant?.surfaces === undefined) return [];
  const errors: CompileError[] = [];
  const declared = new Set([
    ...surfaces.tools.map((entry) => `tool:${entry.name}`),
    ...surfaces.resources.map((entry) => `resource:${entry.name}`),
    ...surfaces.prompts.map((entry) => `prompt:${entry.name}`),
    ...(surfaces.knowledge ?? []).map((entry) => `knowledge:${entry.name}`),
  ]);
  const toolsByName = new Map(surfaces.tools.map((tool) => [tool.name, tool]));

  assistant.surfaces.forEach((surface, surfaceIndex) => {
    surface.capabilities?.forEach((capability, index) => {
      if (!declared.has(`${capability.kind}:${capability.name}`)) {
        errors.push({
          code: 'assistant_capability_unknown',
          path: `server.assistant.surfaces[${surfaceIndex}].capabilities[${index}]`,
          message: `assistant capability ${capability.kind} "${capability.name}" is not declared by this server`,
        });
        return;
      }
      if (surface.mode === 'authenticated' || capability.kind !== 'tool') return;

      const tool = toolsByName.get(capability.name);
      if (tool === undefined) return;
      const path = `tools.${tool.name}`;

      if (surface.mode === 'public' && anonymousBehavior(tool) === 'requires-identity') {
        errors.push({
          code: 'assistant_public_user_reference',
          path,
          message: `"${tool.name}" needs a signed-in user but is projected to a public website surface, whose visitor is anonymous; use publicWebsite({ signIn: true }) to let visitors sign in for it`,
        });
      }

      const touchesConnector =
        tool.fulfilment.kind === 'operation' ||
        tool.fulfilment.steps.some((step) => step.kind === 'operation');
      if (
        touchesConnector &&
        tool.annotations?.readOnlyHint !== true &&
        tool.annotations?.confirm !== true
      ) {
        errors.push({
          code: 'assistant_public_effect_unconfirmed',
          path,
          message: `"${tool.name}" is projected to a ${surface.mode} website surface, so it must declare annotations.readOnly() or set { confirm: true }`,
        });
      }
    });
  });

  return errors;
}

/**
 * Reads every expression a fulfilment evaluates — one operation's args, or a flow's output plus each
 * step's args and its `if` guard, since a condition can read `${user}` just as an argument can.
 */
function readsUser(fulfilment: ArtifactFulfilment): boolean {
  const nodes: (ExprNode | CondNode)[] =
    fulfilment.kind === 'operation'
      ? Object.values(fulfilment.args)
      : [
          ...Object.values(fulfilment.output),
          ...fulfilment.steps.flatMap((step: ArtifactStep) => [
            ...(step.if === undefined ? [] : [step.if]),
            ...(step.kind === 'operation' ? Object.values(step.args) : []),
          ]),
        ];
  return nodes.some((node) => collectPaths(node).some((path) => path.root === 'user'));
}
