import { useEffect, useState } from 'react';
import { useCallTool, useSendFollowUpMessage, useToolInfo } from '../helpers.js';
import './widget-style.css';

type Brief = { title?: string; audience?: string; goal?: string };
type Snapshot = { value: Brief; revision: number; status: string; proposal?: Brief };

function displayBrief(data: Snapshot | undefined): Brief {
  const proposal = data?.proposal;
  return proposal && (proposal.title || proposal.audience || proposal.goal)
    ? proposal
    : (data?.value ?? {});
}

function snapshot(result: unknown): Snapshot | undefined {
  if (!result || typeof result !== 'object') return;
  const envelope = result as { isError?: boolean; structuredContent?: Partial<Snapshot> };
  const data = envelope.structuredContent;
  if (
    !envelope.isError &&
    data &&
    data.value &&
    typeof data.value === 'object' &&
    Number.isInteger(data.revision) &&
    typeof data.status === 'string'
  ) {
    return data as Snapshot;
  }
}

export default function DraftCard() {
  const info = useToolInfo('open_draft');
  const read = useCallTool('open_draft');
  const save = useCallTool('save_draft');
  const followUp = useSendFollowUpMessage();
  const [saved, setSaved] = useState(() => snapshot(info));
  const [brief, setBrief] = useState<Brief>(() => displayBrief(snapshot(info)));
  const [busy, setBusy] = useState(false);
  const [reloadRequired, setReloadRequired] = useState(false);
  const [message, setMessage] = useState('Review your brief. An account is optional.');
  useEffect(() => {
    const next = snapshot({ structuredContent: info.structuredContent });
    if (next) {
      setSaved(next);
      setBrief(displayBrief(next));
    }
  }, [info.structuredContent]);
  const complete = Boolean(brief.title?.trim() && brief.audience?.trim() && brief.goal?.trim());
  const unchanged = ['title', 'audience', 'goal'].every(
    (key) => brief[key as keyof Brief] === saved?.value[key as keyof Brief],
  );

  async function run(operation: 'load' | 'save') {
    setBusy(true);
    try {
      const result =
        operation === 'load'
          ? await read.callTool({})
          : await save.callTool({ ...brief, expectedRevision: saved?.revision });
      const next = snapshot(result);
      if (!next) throw new Error('No authoritative result');
      setSaved(next);
      setBrief(displayBrief(next));
      setReloadRequired(false);
      setMessage(operation === 'save' ? 'Your brief is saved.' : 'Saved brief loaded.');
    } catch {
      setReloadRequired(true);
      setMessage(
        'No save was confirmed. Reload saved to check the latest brief before trying again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="brief-shell">
      <header>
        <p className="brief-eyebrow">YOUR FIRST USEFUL STEP</p>
        <h1>Your project brief</h1>
        <p>Make something useful before creating an account.</p>
      </header>
      <section className="brief-fields">
        <label>
          Project title
          <input
            required
            maxLength={120}
            value={brief.title ?? ''}
            placeholder="A better first week"
            onChange={(event) => setBrief({ ...brief, title: event.currentTarget.value })}
          />
        </label>
        <label>
          Who is this for?
          <textarea
            required
            maxLength={240}
            rows={2}
            value={brief.audience ?? ''}
            placeholder="New teammates joining our product team"
            onChange={(event) => setBrief({ ...brief, audience: event.currentTarget.value })}
          />
        </label>
        <label>
          What would success look like?
          <textarea
            required
            maxLength={240}
            rows={3}
            value={brief.goal ?? ''}
            placeholder="Complete their first useful project in a week"
            onChange={(event) => setBrief({ ...brief, goal: event.currentTarget.value })}
          />
        </label>
        <p role="status" aria-live="polite">
          {busy ? 'Waiting for the result…' : message}
        </p>
        <div className="brief-actions">
          <button type="button" disabled={busy} onClick={() => void run('load')}>
            Reload saved
          </button>
          <button
            className="brief-primary"
            type="button"
            onClick={() => void run('save')}
            disabled={busy || !saved || !complete || reloadRequired}
          >
            Save brief
          </button>
        </div>
      </section>
      <footer>
        <p>
          A saved brief lasts up to 24 hours and can follow you when you sign in. No project has
          been created.
        </p>
        <button
          type="button"
          disabled={
            busy || !complete || !unchanged || !saved || saved.revision === 0 || reloadRequired
          }
          onClick={() =>
            void followUp({ prompt: 'I would like to continue with my saved brief in an account.' })
          }
        >
          Continue with an account
        </button>
      </footer>
    </main>
  );
}
