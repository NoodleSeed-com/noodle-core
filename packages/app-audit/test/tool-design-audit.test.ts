import type { RuntimeArtifact } from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import { auditToolDesignFindings, MODEL_VISIBLE_TOOL_BUDGET } from '../src/tool-design-audit.js';

type ToolSpec = {
  readonly name: string;
  readonly title?: string;
  readonly input?: Record<string, unknown>;
  readonly output?: Record<string, unknown>;
  readonly appOnly?: boolean;
  readonly contextProvider?: true;
};

function artifactWith(tools: readonly ToolSpec[]): RuntimeArtifact {
  return {
    server: {},
    tools: tools.map((spec) => ({
      name: spec.name,
      ...(spec.title === undefined ? {} : { title: spec.title }),
      description: `The ${spec.name} tool, described well enough for review.`,
      inputSchema: spec.input ?? { type: 'object', properties: {} },
      ...(spec.output === undefined ? {} : { outputSchema: spec.output }),
      ...(spec.contextProvider === undefined ? {} : { contextProvider: spec.contextProvider }),
      ...(spec.appOnly ? { _meta: { ui: { visibility: ['app'] } } } : {}),
      fulfilment: { kind: 'flow', steps: [], output: {} },
    })),
  } as unknown as RuntimeArtifact;
}

function finding(artifact: RuntimeArtifact, code: string) {
  const match = auditToolDesignFindings(artifact).find((item) => item.code === code);
  expect(match, `expected a ${code} finding`).toBeDefined();
  return match;
}

/** A well-designed list tool: titled, typed output, and a bounded array. */
const goodListTool: ToolSpec = {
  name: 'find_tasks',
  title: 'Find tasks',
  input: { type: 'object', properties: { query: { type: 'string' } } },
  output: {
    type: 'object',
    properties: { matches: { type: 'array', maxItems: 20, items: { type: 'object' } } },
  },
};

describe('tool_design_titles', () => {
  it('warns and names each model-visible tool missing a title', () => {
    const artifact = artifactWith([goodListTool, { name: 'close_task' }]);
    expect(finding(artifact, 'tool_design_titles')).toMatchObject({ severity: 'warn' });
    expect(finding(artifact, 'tool_design_titles')?.message).toContain('close_task');
    expect(finding(artifact, 'tool_design_titles')?.message).not.toContain('find_tasks');
  });

  it('stays info when every model-visible tool has a title', () => {
    expect(finding(artifactWith([goodListTool]), 'tool_design_titles')).toMatchObject({
      severity: 'info',
    });
  });

  it('ignores app-only helper tools, which the model never sees', () => {
    const artifact = artifactWith([goodListTool, { name: 'set_priority', appOnly: true }]);
    expect(finding(artifact, 'tool_design_titles')).toMatchObject({ severity: 'info' });
  });
});

describe('tool_design_output_shape', () => {
  it('warns when a model-visible tool declares no output schema', () => {
    const artifact = artifactWith([{ name: 'close_task', title: 'Close task' }]);
    expect(finding(artifact, 'tool_design_output_shape')).toMatchObject({ severity: 'warn' });
    expect(finding(artifact, 'tool_design_output_shape')?.message).toContain('close_task');
  });

  it('stays info when every model-visible tool declares an output schema', () => {
    expect(finding(artifactWith([goodListTool]), 'tool_design_output_shape')).toMatchObject({
      severity: 'info',
    });
  });
});

describe('tool_design_output_bounds', () => {
  it('warns on an unbounded array output with no pagination input', () => {
    const artifact = artifactWith([
      {
        name: 'list_orders',
        title: 'List orders',
        output: { type: 'object', properties: { orders: { type: 'array' } } },
      },
    ]);
    expect(finding(artifact, 'tool_design_output_bounds')).toMatchObject({ severity: 'warn' });
    expect(finding(artifact, 'tool_design_output_bounds')?.message).toContain('list_orders');
  });

  it('accepts maxItems as the bound', () => {
    expect(finding(artifactWith([goodListTool]), 'tool_design_output_bounds')).toMatchObject({
      severity: 'info',
    });
  });

  // Regression: the first vocabulary only knew limit/cursor/offset/page, so a tool passing BigQuery's
  // real `max_results` bound through was reported as unbounded — pushing the author toward a redundant
  // and possibly untrue maxItems on top of a genuine bound.
  it.each([
    'max_results',
    'maxResults',
    'count',
    'first',
    'top',
    'page_token',
  ])('accepts %s as a bounding input', (field) => {
    const artifact = artifactWith([
      {
        name: 'list_orders',
        title: 'List orders',
        input: { type: 'object', properties: { [field]: { type: 'integer' } } },
        output: { type: 'object', properties: { orders: { type: 'array' } } },
      },
    ]);
    expect(finding(artifact, 'tool_design_output_bounds')).toMatchObject({ severity: 'info' });
  });

  it('accepts a pagination input as the bound', () => {
    const artifact = artifactWith([
      {
        name: 'list_orders',
        title: 'List orders',
        input: { type: 'object', properties: { limit: { type: 'integer' } } },
        output: { type: 'object', properties: { orders: { type: 'array' } } },
      },
    ]);
    expect(finding(artifact, 'tool_design_output_bounds')).toMatchObject({ severity: 'info' });
  });

  it('finds an unbounded array nested inside the output object', () => {
    const artifact = artifactWith([
      {
        name: 'get_report',
        title: 'Get report',
        output: {
          type: 'object',
          properties: {
            report: { type: 'object', properties: { rows: { type: 'array' } } },
          },
        },
      },
    ]);
    expect(finding(artifact, 'tool_design_output_bounds')).toMatchObject({ severity: 'warn' });
  });

  it('does not warn about scalar-only outputs', () => {
    const artifact = artifactWith([
      {
        name: 'close_task',
        title: 'Close task',
        output: { type: 'object', properties: { ok: { type: 'boolean' } } },
      },
    ]);
    expect(finding(artifact, 'tool_design_output_bounds')).toMatchObject({ severity: 'info' });
  });
});

describe('tool_design_surface_budget', () => {
  function tools(count: number): readonly ToolSpec[] {
    return Array.from({ length: count }, (_unused, index) => ({
      ...goodListTool,
      name: `find_tasks_${index}`,
    }));
  }

  it('warns above the model-visible tool budget', () => {
    const artifact = artifactWith(tools(MODEL_VISIBLE_TOOL_BUDGET + 1));
    expect(finding(artifact, 'tool_design_surface_budget')).toMatchObject({ severity: 'warn' });
    expect(finding(artifact, 'tool_design_surface_budget')?.message).toContain(
      `${MODEL_VISIBLE_TOOL_BUDGET + 1}`,
    );
  });

  it('stays info at the budget', () => {
    const artifact = artifactWith(tools(MODEL_VISIBLE_TOOL_BUDGET));
    expect(finding(artifact, 'tool_design_surface_budget')).toMatchObject({ severity: 'info' });
  });

  it('counts only model-visible tools', () => {
    const artifact = artifactWith([
      ...tools(MODEL_VISIBLE_TOOL_BUDGET),
      { ...goodListTool, name: 'widget_helper', appOnly: true },
    ]);
    expect(finding(artifact, 'tool_design_surface_budget')).toMatchObject({ severity: 'info' });
  });
});

describe('tool_design_context', () => {
  it('reports the declared context provider', () => {
    const artifact = artifactWith([
      goodListTool,
      { name: 'acme_context', title: 'Acme context', contextProvider: true, output: {} },
    ]);
    expect(finding(artifact, 'tool_design_context')?.message).toContain('acme_context');
  });

  it('stays info, never a warning, when no context provider is declared', () => {
    expect(finding(artifactWith([goodListTool]), 'tool_design_context')).toMatchObject({
      severity: 'info',
    });
  });
});

describe('tool-design findings as a set', () => {
  it('never reports an error severity, so check exit codes are unchanged', () => {
    const worst = artifactWith([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
    for (const item of auditToolDesignFindings(worst)) {
      expect(item.severity).not.toBe('error');
      expect(item.fix.length).toBeGreaterThan(0);
      expect(item.next.length).toBeGreaterThan(0);
    }
  });

  it('reports every tool-design code even when the server declares no tools', () => {
    const codes = auditToolDesignFindings(artifactWith([])).map((item) => item.code);
    expect(codes).toEqual([
      'tool_design_titles',
      'tool_design_output_shape',
      'tool_design_output_bounds',
      'tool_design_surface_budget',
      'tool_design_context',
    ]);
  });
});
