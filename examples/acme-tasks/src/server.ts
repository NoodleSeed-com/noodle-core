import { annotations, server, tool, z } from '@noodleseed/one';
import { ACME_TASKS_AGENT_GUIDE } from './agent-guide.js';

// Acme Tasks is a fictional productivity app. It is a two-way (read + write) experience rather than a
// top-of-funnel handoff: the top-3 prioritized user flows all complete in chat — Capture, Prioritize,
// and Complete. It is the flagship for designing an app around its prioritized flows (see the README).
//
// Authoring notes:
// - A tool `fulfil` is *recorded*, not run as live JS. Place inputs directly into an output string as
//   `${input.x}` so they substitute at runtime; do not transform them (no arithmetic/filter on inputs).
//   The seed list below is static data the runtime returns verbatim — the "today" view.
// - A real deployment would connect the user's account with the end-user auth pattern (see the
//   `customer-auth` example); this example keeps a seeded list so the focus stays on the flows.

const today = [
  {
    id: 'email_vendor',
    title: 'Email the vendor about the Q3 quote',
    priority: 'high',
    done: false,
  },
  { id: 'review_pr', title: 'Review the analytics pull request', priority: 'medium', done: false },
  { id: 'book_offsite', title: 'Book flights for the team offsite', priority: 'low', done: false },
] as const;

const priority = z.enum(['high', 'medium', 'low']);

// Tool annotations for host planners: listing is read-only; capture/complete/re-prioritize are local
// non-destructive writes.
const readOnly = annotations.readOnly();
const localWrite = annotations.localAction({ destructive: false });
const confirmedWrite = annotations.localAction({ destructive: false, confirm: true });
const widgetWrite = annotations.localAction({ destructive: false, confirm: false });

const taskOutput = z.object({
  id: z.string(),
  title: z.string(),
  priority,
  done: z.boolean(),
});

export default server(
  'acme_tasks',
  {
    title: 'Acme Tasks',
    version: '1.0.0',
    agentGuide: ACME_TASKS_AGENT_GUIDE,
    // ChatGPT's stateless MCP lane cannot carry Noodle's standard confirmation form. Keep
    // confirm:true for capable/embedded hosts, but explicitly trust native host approval there.
    interactions: { confirmationFallback: 'host' },
    branding: {
      name: 'Acme Tasks',
      accent: '#7C3AED',
      surface: '#F5F3FF',
      surfaceDark: '#161228',
      radius: 'lg',
      density: 'comfortable',
    },
  },
  [
    // Flow 2 — Prioritize / Today: render the list so the human triages and the model can speak to it.
    tool('list_today', {
      title: 'Show today’s tasks',
      description: 'Show today’s Acme Tasks and render the task-list widget.',
      annotations: readOnly,
      input: z.object({ focus: z.string().default('today') }),
      // Bound the list output. A recorded `fulfil` cannot slice an array, so the honest bound here is
      // a cap on the shape itself; a connector-backed list takes a pagination input instead (see the
      // `weather` example). `noodle check` reports an unbounded array as `tool_design_output_bounds`.
      output: z.object({
        status: z.string(),
        focus: z.string(),
        tasks: z.array(taskOutput).max(20),
      }),
      fulfil: ({ input }) => ({
        status: `Acme Tasks for ${input.focus}: ${today.length} open items, highest priority first.`,
        focus: input.focus,
        tasks: today,
      }),
      viewTitle: 'Today’s tasks',
      viewDescription: 'A prioritized task list: capture, re-prioritize, and complete in place.',
      // ChatGPT host status copy (openai/toolInvocation/*) — required for widget-opening tools.
      invoking: 'Loading your tasks…',
      invoked: 'Tasks ready',
      domain: 'https://tasks.acme.example',
      view: {
        component: 'task-list',
        entry: './views/task-list.tsx',
      },
      csp: {
        connectDomains: ['https://acme.example'],
        resourceDomains: ['https://acme.example'],
        frameDomains: ['https://acme.example'],
      },
    }),
    // Flow 1 — Capture: add a task from natural language ("remind me to email the vendor").
    tool('add_task', {
      title: 'Add a task',
      description: 'Capture a new Acme task with a title and priority.',
      annotations: localWrite,
      input: z.object({
        title: z.string().meta({ title: 'Task' }),
        priority: priority.default('medium').meta({ title: 'Priority' }),
      }),
      output: z.object({
        status: z.string(),
        title: z.string(),
        priority,
      }),
      fulfil: ({ input }) => ({
        status: `Added “${input.title}” (${input.priority}).`,
        title: input.title,
        priority: input.priority,
      }),
    }),
    // Flow 3 — Complete: mark a task done. Model-visible so the model can complete on request.
    tool('complete_task', {
      title: 'Complete task',
      description: 'This will mark the selected task complete for everyone using Acme Tasks.',
      annotations: confirmedWrite,
      input: z.object({
        task: z.string().meta({ title: 'Task ID' }),
        title: z.string().min(1).meta({ title: 'Task' }),
      }),
      output: z.object({
        status: z.string(),
        task: z.string(),
      }),
      fulfil: ({ input }) => ({
        status: `Completed “${input.title}”.`,
        task: input.task,
      }),
    }),
    // Flow 2 helper (widget-only): re-prioritize a task from the list widget.
    tool('set_priority', {
      title: 'Change task priority',
      visibility: ['app'],
      description: 'Re-prioritize a task from the list widget.',
      annotations: widgetWrite,
      input: z.object({
        task: z.string().meta({ title: 'Task ID' }),
        priority: priority.meta({ title: 'New priority' }),
      }),
      output: z.object({
        status: z.string(),
        task: z.string(),
        priority,
      }),
      fulfil: ({ input }) => ({
        status: `Set ${input.task} to ${input.priority} priority.`,
        task: input.task,
        priority: input.priority,
      }),
    }),
  ],
);
