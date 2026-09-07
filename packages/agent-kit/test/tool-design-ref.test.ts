import { describe, expect, it } from 'vitest';
import { renderAgentFiles } from '../src/index.js';

function reference(name: string): string {
  const content = renderAgentFiles({}).find((file) =>
    file.path.endsWith(`/references/${name}.md`),
  )?.content;
  expect(content, `expected a ${name} reference`).toBeDefined();
  return content ?? '';
}

describe('tool-design reference', () => {
  it('teaches every rule of the doctrine', () => {
    const doctrine = reference('tool-design');
    for (const heading of [
      '## Design tools for the model',
      '## Title and annotations',
      '## Bound every output',
      '## Keep the tool surface small',
      '## Provision context deliberately',
      '## Errors an agent can act on',
    ]) {
      expect(doctrine).toContain(heading);
    }
  });

  it('cites the exact noodle check codes an agent will see, and their warn-only posture', () => {
    const doctrine = reference('tool-design');
    for (const code of [
      'tool_design_titles',
      'tool_design_output_shape',
      'tool_design_output_bounds',
      'tool_design_surface_budget',
      'tool_design_context',
    ]) {
      expect(doctrine).toContain(code);
    }
    expect(doctrine).toContain('warnings, never failures');
    expect(doctrine).toContain('--min-severity warn');
  });

  it('keeps the intent-shaped resolver plus action recipe that moved out of the authoring workflow', () => {
    const doctrine = reference('tool-design');
    expect(doctrine).toContain('not 1:1 around API endpoints');
    expect(doctrine).toContain("tool('find_tasks'");
    expect(doctrine).toContain("tool('complete_task'");
    expect(doctrine).toContain('export default server(');
  });

  it('states the tool-surface budget as a heuristic, not a host limit', () => {
    const doctrine = reference('tool-design');
    expect(doctrine).toContain('20 model-visible tools');
    expect(doctrine).toContain('not a host limit');
  });

  it('routes the authoring workflow and the server playbook to it instead of duplicating it', () => {
    expect(reference('authoring-workflow')).toContain('`references/tool-design.md`');
    expect(reference('build-an-mcp-server')).toContain('`references/tool-design.md`');
  });
});
