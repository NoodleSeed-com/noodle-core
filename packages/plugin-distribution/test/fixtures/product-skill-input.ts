import type { ProductSkillPackageInput } from '@noodle-borg/agent-packaging';

const SHA = 'a'.repeat(64);

/** Frozen multi-surface package input shared by product-skill renderer tests. */
export const PRODUCT_SKILL_INPUT = Object.freeze({
  schemaVersion: '1' as const,
  app: Object.freeze({ name: 'acme_tasks', title: 'Acme Tasks', version: '1.0.0' }),
  skill: Object.freeze({
    description: 'Use Acme Tasks to review and complete work.',
    useWhen: Object.freeze(['A user asks to review their work.', 'A user asks to complete work.']),
    workflows: Object.freeze([
      Object.freeze({
        id: 'review_then_complete',
        title: 'Review then complete work',
        intent: 'Review the work before making a change.',
        steps: Object.freeze([
          Object.freeze({
            capability: Object.freeze({ kind: 'resource' as const, name: 'task_details' }),
            guidance: 'Start with the current task details.',
          }),
          Object.freeze({
            capability: Object.freeze({ kind: 'tool' as const, name: 'complete_task' }),
            guidance: 'Complete only the task the user selected.',
            behavior: Object.freeze({
              readOnly: false,
              destructive: true,
              idempotent: false,
              openWorld: false,
              confirmationRequired: true,
            }),
          }),
        ]),
      }),
    ]),
    boundaries: Object.freeze(['Do not invent task IDs.', 'Ask before completing ambiguous work.']),
    examples: Object.freeze([
      Object.freeze({ prompt: 'Review my open task.', workflow: 'review_then_complete' }),
    ]),
  }),
  surface: Object.freeze({
    auth: Object.freeze({ required: true, kind: 'oidc' as const }),
    tools: Object.freeze([
      Object.freeze({
        kind: 'tool' as const,
        name: 'list_tasks',
        title: 'List tasks',
        description: 'List the current tasks.',
        input: Object.freeze({
          type: 'object',
          fields: Object.freeze([
            Object.freeze({
              name: 'secret_filter',
              type: 'string',
              required: false,
              description: 'This schema must stay out of the reference.',
            }),
          ]),
        }),
        behavior: Object.freeze({
          readOnly: true,
          destructive: false,
          idempotent: true,
          openWorld: false,
          confirmationRequired: false,
        }),
        visibility: Object.freeze(['model', 'app'] as const),
        widget: 'task_widget',
      }),
      Object.freeze({
        kind: 'tool' as const,
        name: 'complete_task',
        description: 'Complete a selected task.',
        input: Object.freeze({ type: 'object' }),
        behavior: Object.freeze({
          readOnly: false,
          destructive: true,
          idempotent: false,
          openWorld: false,
          confirmationRequired: true,
        }),
        visibility: Object.freeze(['model'] as const),
      }),
      Object.freeze({
        kind: 'tool' as const,
        name: 'refresh_widget',
        description: 'Refresh the app widget.',
        input: Object.freeze({ type: 'object' }),
        behavior: Object.freeze({
          readOnly: false,
          destructive: false,
          idempotent: true,
          openWorld: true,
          confirmationRequired: false,
        }),
        visibility: Object.freeze(['app'] as const),
      }),
    ]),
    resources: Object.freeze([
      Object.freeze({
        kind: 'resource' as const,
        name: 'task_details',
        uri: 'acme://tasks/details',
        description: 'Current details for one task.',
      }),
    ]),
    prompts: Object.freeze([
      Object.freeze({
        kind: 'prompt' as const,
        name: 'summarize_tasks',
        description: 'Summarize the current work.',
        arguments: Object.freeze([
          Object.freeze({ name: 'period', description: 'The time period.', required: true }),
        ]),
      }),
    ]),
    widgets: Object.freeze([
      Object.freeze({
        kind: 'widget' as const,
        name: 'task_widget',
        title: 'Task widget',
        description: 'An interactive task list.',
        tool: 'list_tasks',
      }),
    ]),
  }),
  provenance: Object.freeze({
    sourceManifestSha256: SHA,
    mcpSurfaceSha256: 'b'.repeat(64),
    compilerVersion: '1' as const,
  }),
}) satisfies ProductSkillPackageInput;
