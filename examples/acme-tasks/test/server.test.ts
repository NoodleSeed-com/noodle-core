import { describe, expect, it } from 'vitest';
import app from '../src/server.js';

describe('acme-tasks example', () => {
  it('exports a Noodle server definition', () => {
    expect(typeof app.toManifest).toBe('function');
  });

  it('exposes a tool for each of the top-3 prioritized flows', async () => {
    // Capture → add_task, Prioritize → list_today (+ set_priority helper), Complete → complete_task.
    const text = JSON.stringify(await app.toManifest());
    expect(text).toContain('add_task');
    expect(text).toContain('list_today');
    expect(text).toContain('complete_task');
    expect(text).toContain('set_priority');
  });

  it('seeds today’s list highest-priority first', async () => {
    const text = JSON.stringify(await app.toManifest());
    expect(text).toMatch(/"tasks":\[\{"id":"email_vendor".*"priority":"high"/);
  });

  it('opts the conversational completion action into runtime confirmation', async () => {
    const manifest = await app.toManifest();
    const completeTask = manifest.tools.find((candidate) => candidate.name === 'complete_task');
    const addTask = manifest.tools.find((candidate) => candidate.name === 'add_task');
    const setPriority = manifest.tools.find((candidate) => candidate.name === 'set_priority');

    expect(completeTask?.annotations?.confirm).toBe(true);
    expect(addTask?.annotations).not.toHaveProperty('confirm');
    expect(setPriority?.visibility).toEqual(['app']);
  });

  it('teaches its three product workflows through one host-neutral agent guide', async () => {
    const manifest = await app.toManifest();
    const guide = manifest.server.agentGuide;

    expect(guide?.workflows.map((workflow) => workflow.id)).toEqual([
      'review_tasks',
      'capture_task',
      'complete_task',
    ]);
    expect(
      guide?.workflows.flatMap((workflow) => workflow.steps.map((step) => step.capability.name)),
    ).toEqual(expect.arrayContaining(['list_today', 'set_priority', 'add_task', 'complete_task']));
    expect(
      guide?.workflows
        .find((workflow) => workflow.id === 'review_tasks')
        ?.steps.map((step) => step.capability.name),
    ).toContain('set_priority');
    expect(
      guide?.examples.every((example) =>
        guide.workflows.some((workflow) => workflow.id === example.workflow),
      ),
    ).toBe(true);
    expect(guide?.boundaries.some((boundary) => boundary.toLowerCase().includes('confirm'))).toBe(
      true,
    );
  });
});
