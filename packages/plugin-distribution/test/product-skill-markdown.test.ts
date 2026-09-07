import { describe, expect, it } from 'vitest';
import { ProductSkillRenderError, renderProductSkillMarkdown } from '../src/index.js';
import { PRODUCT_SKILL_INPUT } from './fixtures/product-skill-input.js';

describe('product skill Markdown rendering', () => {
  it('renders canonical ordered skill guidance and a bounded MCP reference', () => {
    const { skill, reference } = renderProductSkillMarkdown(PRODUCT_SKILL_INPUT);

    expect(skill).toMatch(
      /^---\nname: acme-tasks\ndescription: Use Acme Tasks to review and complete work\.\n---\n\n# Acme Tasks\n\n<!-- noodle-app-package source:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa surface:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb -->/,
    );
    expect(skill.match(/^## .+$/gm)).toEqual([
      '## When to use this product',
      '## Workflows',
      '## Boundaries',
      '## Examples',
      '## MCP surface',
    ]);
    expect(skill).toContain('1. `resource:task_details` — Start with the current task details.');
    expect(skill).toContain(
      '2. `tool:complete_task` — Complete only the task the user selected. (write; destructive; confirmation required)',
    );
    expect(skill).toContain('[Read the MCP surface reference.](references/mcp-surface.md)');

    expect(reference).toContain('Authentication: required (OIDC).');
    expect(reference).toContain(
      '`complete_task` | Complete a selected task. | write; destructive; confirmation required | model',
    );
    expect(reference).toContain(
      '`list_tasks` | List the current tasks. | read-only; idempotent | model and app',
    );
    expect(reference).toContain(
      '`refresh_widget` | Refresh the app widget. | write; idempotent; open-world | app only',
    );
    expect(reference).toContain('`task_widget` | Task widget | Open with `list_tasks`.');
    expect(reference).not.toMatch(
      /secret_filter|This schema must stay out|fulfilment|connector configuration|widget HTML|customer route|sourcePath/i,
    );
  });

  it.each([
    [
      'credential-shaped prose',
      {
        ...PRODUCT_SKILL_INPUT,
        skill: { ...PRODUCT_SKILL_INPUT.skill, boundaries: [`ghp_${'a'.repeat(36)}`] },
      },
      'app_package_sensitive_content',
    ],
    [
      'an unsafe app name',
      { ...PRODUCT_SKILL_INPUT, app: { ...PRODUCT_SKILL_INPUT.app, name: '../escape' } },
      'app_package_unsafe_path',
    ],
    [
      'an invalid capability name',
      {
        ...PRODUCT_SKILL_INPUT,
        surface: {
          ...PRODUCT_SKILL_INPUT.surface,
          tools: [{ ...PRODUCT_SKILL_INPUT.surface.tools[0], name: 'list|tasks' }],
        },
      },
      'app_package_invalid',
    ],
  ])('rejects direct rendering with %s', (_label, value, code) => {
    expect(() => renderProductSkillMarkdown(value)).toThrow(ProductSkillRenderError);
    try {
      renderProductSkillMarkdown(value);
    } catch (error) {
      expect((error as ProductSkillRenderError).code).toBe(code);
      expect((error as Error).message).not.toContain('ghp_');
    }
  });

  it('escapes generated Markdown table cells defensively', () => {
    const { reference } = renderProductSkillMarkdown({
      ...PRODUCT_SKILL_INPUT,
      surface: {
        ...PRODUCT_SKILL_INPUT.surface,
        tools: [
          {
            ...PRODUCT_SKILL_INPUT.surface.tools[0],
            description: 'Treat `code` | [links](carefully).',
          },
        ],
        widgets: [
          {
            ...PRODUCT_SKILL_INPUT.surface.widgets[0],
            title: 'Tasks *today*',
          },
        ],
      },
    });

    expect(reference).toContain('Treat \\`code\\` \\| \\[links\\]\\(carefully\\).');
    expect(reference).toContain('Tasks \\*today\\*');
    expect(reference).toContain('Open with `list_tasks`.');
  });
});
