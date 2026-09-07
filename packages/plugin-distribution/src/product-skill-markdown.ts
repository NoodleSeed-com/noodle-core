import type {
  ProductSkillMarkdown,
  ProductSkillPackageInput,
  ProductSkillToolBehavior,
} from '@noodle-borg/agent-packaging';
import { skillSlug, validateProductSkillPackageInput } from '@noodle-borg/agent-packaging';

/** Render host-neutral, bounded product-skill Markdown from the safe App Package projection. */
export function renderProductSkillMarkdown(input: ProductSkillPackageInput): ProductSkillMarkdown {
  validateProductSkillPackageInput(input);
  const title = heading(input.app.title);
  return {
    skill: renderSkill(input, title),
    reference: renderReference(input, title),
  };
}

function renderSkill(input: ProductSkillPackageInput, title: string): string {
  const lines = [
    '---',
    `name: ${skillSlug(input.app.name)}`,
    `description: ${yamlScalar(input.skill.description)}`,
    '---',
    '',
    `# ${title}`,
    '',
    `<!-- noodle-app-package source:${input.provenance.sourceManifestSha256} surface:${input.provenance.mcpSurfaceSha256} -->`,
    '',
    '## When to use this product',
    ...input.skill.useWhen.map((useWhen) => `- ${prose(useWhen)}`),
    '',
    '## Workflows',
    ...input.skill.workflows.flatMap((workflow) => [
      '',
      `### ${heading(workflow.title)}`,
      ...(workflow.intent === undefined ? [] : ['', prose(workflow.intent)]),
      '',
      ...workflow.steps.map((step, index) => {
        const guidance = step.guidance === undefined ? '' : ` — ${prose(step.guidance)}`;
        const behavior =
          step.behavior === undefined ? '' : ` (${behaviorLabels(step.behavior).join('; ')})`;
        return `${index + 1}. ${inlineCode(`${step.capability.kind}:${step.capability.name}`)}${guidance}${behavior}`;
      }),
    ]),
    '',
    '## Boundaries',
    ...input.skill.boundaries.map((boundary) => `- ${prose(boundary)}`),
    '',
    '## Examples',
    ...input.skill.examples.map(
      (example) => `- “${prose(example.prompt)}” — use \`${example.workflow}\`.`,
    ),
    '',
    '## MCP surface',
    '',
    '[Read the MCP surface reference.](references/mcp-surface.md)',
    '',
  ];
  return lines.join('\n');
}

function renderReference(input: ProductSkillPackageInput, title: string): string {
  const lines = [
    `# ${title} MCP surface`,
    '',
    input.surface.auth.required
      ? `Authentication: required (${input.surface.auth.kind === 'federatedOidc' ? 'federated OIDC' : 'OIDC'}).`
      : 'Authentication: not required.',
    '',
    '## Tools',
    '',
    '| Tool | Description | Behavior | Visibility |',
    '| --- | --- | --- | --- |',
    ...sorted(input.surface.tools).map(
      (tool) =>
        `| ${tableCode(tool.name)} | ${tableText(tool.description)} | ${behaviorLabels(tool.behavior).join('; ')} | ${visibilityLabel(tool.visibility)} |`,
    ),
    '',
    '## Resources',
    '',
    '| Resource | Description |',
    '| --- | --- |',
    ...sorted(input.surface.resources).map(
      (resource) =>
        `| ${tableCode(resource.name)} | ${tableText(resource.description ?? resource.title ?? 'No description.')} |`,
    ),
    '',
    '## Prompts',
    '',
    '| Prompt | Description | Arguments |',
    '| --- | --- | --- |',
    ...sorted(input.surface.prompts).map(
      (prompt) =>
        `| ${tableCode(prompt.name)} | ${tableText(prompt.description ?? prompt.title ?? 'No description.')} | ${promptArguments(prompt)} |`,
    ),
    '',
    '## Widgets',
    '',
    '| Widget | Description | Opening tool |',
    '| --- | --- | --- |',
    ...sorted(input.surface.widgets).map(
      (widget) =>
        `| ${tableCode(widget.name)} | ${tableText(widget.title ?? widget.description ?? 'Widget.')} | Open with ${tableCode(widget.tool)}. |`,
    ),
    '',
  ];
  return lines.join('\n');
}

function behaviorLabels(behavior: ProductSkillToolBehavior): readonly string[] {
  return [
    behavior.readOnly ? 'read-only' : 'write',
    ...(behavior.destructive ? ['destructive'] : []),
    ...(behavior.idempotent ? ['idempotent'] : []),
    ...(behavior.openWorld ? ['open-world'] : []),
    ...(behavior.confirmationRequired ? ['confirmation required'] : []),
  ];
}

function sorted<T extends { readonly name: string }>(items: readonly T[]): readonly T[] {
  return [...items].sort((left, right) => asciiCompare(left.name, right.name));
}

function asciiCompare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function visibilityLabel(visibility: readonly ('model' | 'app')[]): string {
  if (visibility.length === 1 && visibility[0] === 'app') return 'app only';
  if (visibility.includes('model') && visibility.includes('app')) return 'model and app';
  return 'model';
}

function promptArguments(input: ProductSkillPackageInput['surface']['prompts'][number]): string {
  if (input.arguments.length === 0) return 'None.';
  return input.arguments
    .map(
      (argument) => `${tableCode(argument.name)} (${argument.required ? 'required' : 'optional'})`,
    )
    .join(', ');
}

function heading(value: string): string {
  return prose(value).replaceAll('#', '\\#').slice(0, 200);
}

function prose(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function tableText(value: string): string {
  return prose(value).replace(/([\\|`*_[\]()<>#!])/g, '\\$1');
}

function tableCode(value: string): string {
  return `\`${value.replace(/([\\`|])/g, '\\$1')}\``;
}

function inlineCode(value: string): string {
  return `\`${value.replace(/([\\`])/g, '\\$1')}\``;
}

function yamlScalar(value: string): string {
  const text = prose(value);
  return /^[A-Za-z0-9][A-Za-z0-9 .,'!?()/-]*$/.test(text) ? text : JSON.stringify(text);
}
