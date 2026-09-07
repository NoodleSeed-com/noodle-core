import { useLayout, useOpenExternal, useSendFollowUpMessage, useToolInfo } from '../helpers.js';
import './widget-style.css';

const capabilities: readonly {
  readonly name: string;
  readonly description: string;
}[] = [
  {
    name: 'React view resource',
    description: 'Compiled widget HTML with a hydrated React entrypoint.',
  },
  {
    name: 'Widget helper calls',
    description: 'App-only tools route through the same host-mediated path.',
  },
  {
    name: 'Durable cart state',
    description: 'Caller-scoped cart records use Noodle state handles with revisions.',
  },
  {
    name: 'External handoff',
    description: 'Checkout opens through declared allowlisted domains.',
  },
  {
    name: 'Model context',
    description: 'Relevant UI state is mirrored through data-llm.',
  },
  {
    name: 'CSP and permissions',
    description: 'Resource metadata declares network and clipboard needs.',
  },
] as const;

export default function CapabilitiesCard() {
  const { theme } = useLayout();
  const toolInfo = useToolInfo('show_capabilities');
  const openExternal = useOpenExternal();
  const sendFollowUpMessage = useSendFollowUpMessage();
  const structured = toolInfo.structuredContent as
    | { readonly status?: string; readonly note?: string }
    | undefined;

  return (
    <main
      className={`nw-shell${theme === 'dark' ? ' dark' : ''}`}
      data-llm={`Food Ordering capabilities: ${capabilities.map((item) => item.name).join(', ')}`}
    >
      <section className="nw-card">
        <header className="nw-header">
          <span className="nw-icon" aria-hidden="true">
            <PuzzleIcon />
          </span>
          <div className="nw-title-block">
            <h1 className="nw-title">MCP capabilities</h1>
            <p className="nw-subtitle">
              {structured?.status ?? 'Food Ordering widget capabilities are ready.'}
            </p>
          </div>
          <span className="nw-chip">Connected</span>
        </header>
        <div className="nw-body">
          <p className="nw-section-title">Available features</p>
          <ul className="nw-feature-list">
            {capabilities.map((capability) => (
              <li className="nw-feature" key={capability.name}>
                <span className="nw-check" aria-hidden="true">
                  <CheckIcon />
                </span>
                <span>
                  <span className="nw-feature-name">{capability.name}</span>
                  <span className="nw-feature-desc">{capability.description}</span>
                </span>
              </li>
            ))}
          </ul>
          <div className="nw-actions">
            <button
              className="nw-button nw-button-primary"
              type="button"
              onClick={() =>
                sendFollowUpMessage({
                  prompt: 'Summarize what the Food Ordering MCP App widget demonstrates.',
                })
              }
            >
              <SparkIcon />
              Ask assistant
            </button>
            <button
              className="nw-button"
              type="button"
              onClick={() => openExternal('https://example.com/noodle-widget-docs')}
            >
              <ExternalIcon />
              Open docs
            </button>
          </div>
          {structured?.note ? <p className="nw-note">{structured.note}</p> : null}
        </div>
        <footer className="nw-footer">
          <span className="nw-meta">
            <ShieldIcon />
            Secure widget surface
          </span>
          <span>v1.0.0</span>
        </footer>
      </section>
    </main>
  );
}

function PuzzleIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 4h5v4h3a2 2 0 0 1 0 4h-3v3H9v-3H6a2 2 0 0 1 0-4h2V4Z" />
      <path d="M13 15v5H4v-5" />
      <path d="M13 20h7v-8" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m6 12 4 4 8-8" />
    </svg>
  );
}

function SparkIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" />
    </svg>
  );
}

function ExternalIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14 4h6v6" />
      <path d="m20 4-9 9" />
      <path d="M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3 5 6v5c0 4.4 2.8 8.3 7 10 4.2-1.7 7-5.6 7-10V6l-7-3Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}
