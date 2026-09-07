import { describe, expect, it } from 'vitest';
import { type AgentGuideSource, server, tool, z } from '../src/index.js';

const guide = {
  description: 'Use Acme Tasks to inspect and update the team task list.',
  useWhen: ['The user asks about Acme work items.', 'The user wants to complete an Acme task.'],
  workflows: [
    {
      id: 'review_then_complete',
      title: 'Review then complete a task',
      intent: 'Ground the requested task before changing it.',
      steps: [
        { capability: { kind: 'tool', name: 'list_tasks' } },
        {
          capability: { kind: 'tool', name: 'complete_task' },
          guidance: 'Confirm the exact task with the user before the write.',
        },
      ],
    },
  ],
  boundaries: ['Never invent a task identifier.'],
  examples: [{ prompt: 'Finish the vendor follow-up.', workflow: 'review_then_complete' }],
} as const satisfies AgentGuideSource;

const capabilityKinds = {
  description: 'Use all capability kinds.',
  useWhen: ['A product workflow needs a symbolic capability reference.'],
  workflows: [
    {
      id: 'all_capabilities',
      title: 'Use all capabilities',
      steps: [
        { capability: { kind: 'tool', name: 'list_tasks' } },
        { capability: { kind: 'resource', name: 'task_details' } },
        { capability: { kind: 'prompt', name: 'summarize_task' } },
      ],
    },
  ],
} as const satisfies AgentGuideSource;

void capabilityKinds;

function acmeServer(options: { readonly agentGuide?: AgentGuideSource } = {}) {
  return server('acme_tasks', { title: 'Acme Tasks', version: '1.0.0', ...options }, [
    tool('list_tasks', {
      description: 'List Acme tasks.',
      input: z.object({}),
      fulfil: () => ({ tasks: [] }),
    }),
    tool('complete_task', {
      description: 'Complete an Acme task.',
      input: z.object({ task: z.string() }),
      fulfil: () => ({ ok: true }),
    }),
  ]);
}

describe('agent guide authoring', () => {
  it('emits a defensive Core-v2 manifest guide', async () => {
    const manifest = await acmeServer({ agentGuide: guide }).toManifest();

    expect(manifest.manifestVersion).toBe('2');
    expect(manifest.server.agentGuide).toEqual(guide);
    expect(manifest.server.agentGuide).not.toBe(guide);
    expect(manifest.server.agentGuide?.workflows).not.toBe(guide.workflows);
  });

  it('omits the guide when it is not authored', async () => {
    const manifest = await acmeServer().toManifest();

    expect(manifest.server).not.toHaveProperty('agentGuide');
  });
});
