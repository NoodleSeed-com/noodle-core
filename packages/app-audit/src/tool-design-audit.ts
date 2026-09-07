import type { RuntimeArtifact } from '@noodle-borg/compiler';
import type { AuditFinding } from './mcp-apps-audit.js';

/**
 * Tool-design heuristics for `noodle check`. These audit how a server presents itself to a model,
 * not whether it compiles: titles and behavior hints, typed and bounded outputs, tool-surface size,
 * and deliberate context provisioning. The doctrine they enforce is the public
 * `apps/docs/content/guides/tool-design.mdx` guide.
 *
 * Every finding here is `info` or `warn` and never `error`, so adding them cannot change the exit
 * code of an existing `noodle check` run. Directory-submission enforcement stays in the
 * `--target chatgpt` / `--target claude` audits and, later, `noodle beacon`.
 */
type ArtifactTool = RuntimeArtifact['tools'][number];

/**
 * Model-visible tool count above which `noodle check` warns. A documented heuristic, not a host
 * limit: no host publishes a hard number, but tool-selection accuracy degrades as the list grows
 * and every listed tool costs context on every turn.
 */
export const MODEL_VISIBLE_TOOL_BUDGET = 20;

/**
 * Input field names that mean the caller, not the server, decides how much comes back. Deliberately
 * broad in both spelling and vocabulary: upstream APIs bound pages under many names (`max_results` on
 * BigQuery, `count` on Open-Meteo, `top` on OData, `first` on GraphQL), and a tool that already passes
 * one of them through is bounded — flagging it would push the author to add a redundant, and possibly
 * untrue, `maxItems` on top of a real bound.
 */
const PAGINATION_INPUTS = new Set([
  'limit',
  'cursor',
  'offset',
  'page',
  'page_size',
  'pageSize',
  'per_page',
  'perPage',
  'max_results',
  'maxResults',
  'max_rows',
  'maxRows',
  'page_token',
  'pageToken',
  'next_token',
  'nextToken',
  'count',
  'first',
  'top',
]);

/** How deep to look for an array inside an output schema before giving up. */
const MAX_OUTPUT_SCHEMA_DEPTH = 4;

/**
 * A tool the model can see. `_meta.ui.visibility` (SEP-1865) defaults to model-and-app; an explicit
 * `['app']` marks a widget-only helper, which no model-facing heuristic should penalize.
 */
export function isModelVisibleTool(tool: ArtifactTool): boolean {
  const visibility = tool._meta?.ui?.visibility;
  return !Array.isArray(visibility) || visibility.includes('model');
}

export function auditToolDesignFindings(artifact: RuntimeArtifact): readonly AuditFinding[] {
  const modelVisible = artifact.tools.filter(isModelVisibleTool);
  return [
    auditTitles(modelVisible),
    auditOutputShape(modelVisible),
    auditOutputBounds(modelVisible),
    auditSurfaceBudget(modelVisible),
    auditContextProvider(artifact.tools),
  ];
}

function auditTitles(tools: readonly ArtifactTool[]): AuditFinding {
  const missing = tools.filter((tool) => !tool.title);
  return {
    code: 'tool_design_titles',
    severity: missing.length === 0 ? 'info' : 'warn',
    message:
      missing.length === 0
        ? 'Every model-visible tool declares a human-readable title.'
        : `Model-visible tools with no title: ${names(missing)}.`,
    cause:
      'Hosts show `title` as the action name in tool pickers and confirmation prompts, and both consumer directories reject tools without one.',
    fix: "Add a short action title to each tool: tool('close_task', { title: 'Close task', ... }).",
    next: 'noodle check',
  };
}

function auditOutputShape(tools: readonly ArtifactTool[]): AuditFinding {
  const untyped = tools.filter((tool) => tool.outputSchema === undefined);
  return {
    code: 'tool_design_output_shape',
    severity: untyped.length === 0 ? 'info' : 'warn',
    message:
      untyped.length === 0
        ? 'Every model-visible tool declares an output schema.'
        : `Model-visible tools with no output schema: ${names(untyped)}.`,
    cause:
      'Without an output schema the model has to parse prose and hosts have no structured result to render or validate.',
    fix: 'Declare the few labelled fields the model needs: output: z.object({ ... }).',
    next: 'noodle validate && noodle check',
  };
}

function auditOutputBounds(tools: readonly ArtifactTool[]): AuditFinding {
  const unbounded = tools.filter(
    (tool) => hasUnboundedArray(tool.outputSchema, 0) && !hasPaginationInput(tool.inputSchema),
  );
  return {
    code: 'tool_design_output_bounds',
    severity: unbounded.length === 0 ? 'info' : 'warn',
    message:
      unbounded.length === 0
        ? 'List-shaped tool outputs are bounded by maxItems or a pagination input.'
        : `Model-visible tools returning an unbounded list: ${names(unbounded)}.`,
    cause:
      'An unbounded list either exhausts the context window or is truncated somewhere the author does not control, and every returned field costs context on later turns.',
    fix: 'Cap the array (z.array(item).max(50)) or accept a bounded pagination input (limit/cursor).',
    next: 'noodle check',
  };
}

function auditSurfaceBudget(tools: readonly ArtifactTool[]): AuditFinding {
  const over = tools.length > MODEL_VISIBLE_TOOL_BUDGET;
  return {
    code: 'tool_design_surface_budget',
    severity: over ? 'warn' : 'info',
    message: over
      ? `${tools.length} model-visible tools exceeds the recommended budget of ${MODEL_VISIBLE_TOOL_BUDGET}.`
      : `${tools.length} model-visible tool(s), within the recommended budget of ${MODEL_VISIBLE_TOOL_BUDGET}.`,
    cause:
      'Tool selection degrades as the list grows. The budget is a documented heuristic, not a host limit; the real threshold depends on how distinct the descriptions are.',
    fix: "Collapse variants that differ only by a filter into one intent-shaped tool with a typed enum, and mark widget-only helpers visibility: ['app'].",
    next: 'noodle check',
  };
}

function auditContextProvider(tools: readonly ArtifactTool[]): AuditFinding {
  const providers = tools.filter((tool) => tool.contextProvider === true);
  return {
    code: 'tool_design_context',
    severity: 'info',
    message:
      providers.length > 0
        ? `Application context is provided by ${names(providers)}.`
        : 'No context provider is declared; the model learns workspace, plan, and permission facts only by asking.',
    cause:
      'Every invocation already carries a server-authoritative timestamp, locale, and time zone; application context (workspace, plan, permissions) is the part only the app can supply.',
    fix: 'Declare server context defaults, and mark one zero-input tool contextProvider: true when the model needs portable application context.',
    next: 'noodle check',
  };
}

function names(tools: readonly ArtifactTool[]): string {
  return tools.map((tool) => tool.name).join(', ');
}

function hasPaginationInput(schema: unknown): boolean {
  const properties = asRecord(asRecord(schema)?.properties);
  if (properties === undefined) return false;
  return Object.keys(properties).some((key) => PAGINATION_INPUTS.has(key));
}

/**
 * Look for an array with no `maxItems` anywhere in the output schema, bounded by
 * {@link MAX_OUTPUT_SCHEMA_DEPTH} so a pathological schema cannot make the audit expensive. Nested
 * lists count: a report object wrapping unbounded rows costs the same context as a top-level one.
 */
function hasUnboundedArray(schema: unknown, depth: number): boolean {
  if (depth > MAX_OUTPUT_SCHEMA_DEPTH) return false;
  const record = asRecord(schema);
  if (record === undefined) return false;
  if (record.type === 'array' && record.maxItems === undefined) return true;
  if (hasUnboundedArray(record.items, depth + 1)) return true;
  const properties = asRecord(record.properties);
  if (properties === undefined) return false;
  return Object.values(properties).some((value) => hasUnboundedArray(value, depth + 1));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
