import { useState } from 'react';
import { useCallTool, useLayout, useToolInfo, useViewState } from '../helpers.js';
import './widget-style.css';

type Priority = 'high' | 'medium' | 'low';

type Task = {
  readonly id: string;
  readonly title: string;
  readonly priority: Priority;
  readonly done: boolean;
};

const PRIORITIES: readonly Priority[] = ['high', 'medium', 'low'];

function asToday(value: unknown) {
  return value as { readonly status?: string; readonly tasks?: readonly Task[] } | undefined;
}

export default function TaskList() {
  const { displayMode, theme } = useLayout();
  const today = asToday(useToolInfo('list_today').structuredContent);
  const addTask = useCallTool('add_task');
  const completeTask = useCallTool('complete_task');
  const setPriorityTool = useCallTool('set_priority');

  const seeded = today?.tasks ?? [];
  // Local, session-scoped state layered over the seeded list — the three flows write here and record
  // the change through a tool call. Captured tasks live in `added` so the list updates in place.
  const [added, setAdded] = useState<readonly Task[]>([]);
  const [done, setDone] = useState<readonly string[]>([]);
  const [priority, setPriority] = useState<Record<string, Priority>>({});
  const [draft, setDraft] = useViewState('draft', '');
  const [status, setStatus] = useState(today?.status ?? 'Capture, prioritize, and complete.');

  const tasks: readonly Task[] = [...seeded, ...added];
  const openCount = tasks.filter((task) => !done.includes(task.id)).length;

  // Each flow updates local state optimistically, then records the change through a tool call. If the
  // call fails, revert the optimistic change and surface a failure message instead of a false success.
  async function capture() {
    const title = draft.trim();
    if (title.length === 0) return;
    const id = `added_${added.length}`;
    setAdded((current) => [...current, { id, title, priority: 'medium', done: false }]);
    setDraft('');
    try {
      const result = await addTask.callTool({ title, priority: 'medium' });
      const structured = result.structuredContent as { readonly status?: string } | undefined;
      setStatus(structured?.status ?? `Added “${title}”.`);
    } catch {
      setAdded((current) => current.filter((task) => task.id !== id));
      setStatus(`Couldn't add “${title}” — try again.`);
    }
  }

  async function reprioritize(task: Task, next: Priority) {
    const prev = priority[task.id];
    setPriority((current) => ({ ...current, [task.id]: next }));
    try {
      const result = await setPriorityTool.callTool({ task: task.id, priority: next });
      const structured = result.structuredContent as { readonly status?: string } | undefined;
      setStatus(structured?.status ?? `Set ${task.title} to ${next}.`);
    } catch {
      setPriority((current) => {
        const restored = { ...current };
        if (prev === undefined) delete restored[task.id];
        else restored[task.id] = prev;
        return restored;
      });
      setStatus(`Couldn't re-prioritize ${task.title} — try again.`);
    }
  }

  async function complete(task: Task) {
    setDone((current) => [...current, task.id]);
    try {
      const result = await completeTask.callTool({ task: task.id, title: task.title });
      const structured = result.structuredContent as { readonly status?: string } | undefined;
      setStatus(structured?.status ?? `Completed “${task.title}”.`);
    } catch {
      setDone((current) => current.filter((id) => id !== task.id));
      setStatus(`Couldn't complete “${task.title}” — try again.`);
    }
  }

  return (
    <main
      className={`nw-shell${theme === 'dark' ? ' dark' : ''}`}
      data-llm={`Acme Tasks: ${openCount} open of ${tasks.length}; ${done.length} completed this session`}
    >
      <section className="nw-card">
        <header className="nw-header">
          <span className="nw-icon" aria-hidden="true">
            <CheckIcon />
          </span>
          <div className="nw-title-block">
            <h1 className="nw-title">Acme Tasks</h1>
            <p className="nw-subtitle" aria-live="polite">
              {status}
            </p>
          </div>
          <span className="nw-chip">
            {displayMode === 'fullscreen' ? 'Fullscreen' : `${openCount} open`}
          </span>
        </header>

        {/* Flow 1 — Capture */}
        <div className="nw-capture">
          <input
            className="nw-input"
            placeholder="Add a task…"
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') capture();
            }}
          />
          <button
            className="nw-button nw-button-primary"
            type="button"
            disabled={addTask.isPending}
            onClick={capture}
          >
            Add
          </button>
        </div>

        {/* Flow 2 — Prioritize, Flow 3 — Complete */}
        <ul className="nw-list">
          {tasks.map((task) => {
            const isDone = done.includes(task.id);
            const level = priority[task.id] ?? task.priority;
            return (
              <li className={`nw-task${isDone ? ' nw-task-done' : ''}`} key={task.id}>
                <button
                  aria-label={isDone ? 'Completed' : 'Complete task'}
                  className={`nw-check${isDone ? ' nw-check-on' : ''}`}
                  type="button"
                  disabled={isDone}
                  onClick={() => complete(task)}
                >
                  {isDone ? '✓' : ''}
                </button>
                <span className="nw-task-title">{task.title}</span>
                <select
                  aria-label="Priority"
                  className={`nw-priority nw-priority-${level}`}
                  value={level}
                  disabled={isDone}
                  onChange={(event) => reprioritize(task, event.currentTarget.value as Priority)}
                >
                  {PRIORITIES.map((entry) => (
                    <option key={entry} value={entry}>
                      {entry}
                    </option>
                  ))}
                </select>
              </li>
            );
          })}
        </ul>
        <p className="nw-note">
          Two-way in chat: read your list, capture, re-prioritize, and complete.
        </p>
      </section>
    </main>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 12.5 9 17l11-11" />
    </svg>
  );
}
