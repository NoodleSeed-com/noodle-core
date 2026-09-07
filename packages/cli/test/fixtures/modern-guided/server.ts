import { annotations, server, tool, z } from '@noodleseed/one';

export default server(
  'modern_guided',
  {
    title: 'Modern Guided',
    version: '1.0.0',
    interactions: { confirmationFallback: 'host' },
    agentGuide: {
      description: 'Use Modern Guided to review and complete tasks.',
      useWhen: ['The user asks about tasks.'],
      workflows: [
        {
          id: 'review_tasks',
          title: 'Review tasks',
          steps: [
            { capability: { kind: 'tool', name: 'list_today' } },
            { capability: { kind: 'tool', name: 'set_priority' } },
          ],
        },
        {
          id: 'complete_task',
          title: 'Complete a task',
          steps: [{ capability: { kind: 'tool', name: 'complete_task' } }],
        },
      ],
      boundaries: ['Never invent task identifiers.'],
      examples: [{ prompt: 'Review my tasks.', workflow: 'review_tasks' }],
    },
  },
  [
    tool('list_today', {
      description: 'List today’s tasks.',
      annotations: annotations.readOnly(),
      input: z.object({}),
      output: z.object({ tasks: z.array(z.string()).max(10) }),
      fulfil: () => ({ tasks: ['review_pr'] }),
    }),
    tool('set_priority', {
      description: 'Re-prioritize a task from the list widget.',
      visibility: ['app'],
      annotations: annotations.localAction({ destructive: false }),
      input: z.object({ task: z.string(), priority: z.string() }),
      output: z.object({ task: z.string(), priority: z.string() }),
      fulfil: ({ input }) => ({ task: input.task, priority: input.priority }),
    }),
    tool('complete_task', {
      description: 'Complete a task after confirmation.',
      annotations: annotations.localAction({ destructive: false, confirm: true }),
      input: z.object({ task: z.string(), title: z.string() }),
      output: z.object({ task: z.string() }),
      fulfil: ({ input }) => ({ task: input.task }),
    }),
  ],
);
