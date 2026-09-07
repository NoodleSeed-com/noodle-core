import type { AgentGuideSource } from '@noodleseed/one';

/** Product guidance is authored once for the full Acme Tasks MCP surface. */
export const ACME_TASKS_AGENT_GUIDE = {
  description: 'Use Acme Tasks to review, capture, prioritize, and complete the team task list.',
  useWhen: [
    'The user asks about their Acme work items.',
    'The user wants to capture or finish an Acme task.',
  ],
  workflows: [
    {
      id: 'review_tasks',
      title: 'Review today’s tasks',
      intent: 'Ground the task list before taking action.',
      steps: [
        { capability: { kind: 'tool', name: 'list_today' } },
        {
          capability: { kind: 'tool', name: 'set_priority' },
          guidance: 'Use only from the task-list app when reprioritizing.',
        },
      ],
    },
    {
      id: 'capture_task',
      title: 'Capture a task',
      steps: [
        {
          capability: { kind: 'tool', name: 'add_task' },
          guidance: 'Ground the new task title and priority exactly.',
        },
      ],
    },
    {
      id: 'complete_task',
      title: 'Complete a task',
      steps: [
        {
          capability: { kind: 'tool', name: 'complete_task' },
          guidance: 'Confirm the exact grounded task with the user before completion.',
        },
      ],
    },
  ],
  boundaries: [
    'Never invent a task identifier.',
    'Ground writes in the exact task and confirm completion with the user.',
  ],
  examples: [
    { prompt: 'What should I do today?', workflow: 'review_tasks' },
    { prompt: 'Add a follow-up with the vendor.', workflow: 'capture_task' },
    { prompt: 'Finish the vendor follow-up.', workflow: 'complete_task' },
  ],
} as const satisfies AgentGuideSource;
