import { useState } from 'react';
import { useCallTool, useLayout, useOpenExternal, useToolInfo, useViewState } from '../helpers.js';
import './widget-style.css';

type Destination = {
  readonly id: string;
  readonly name: string;
  readonly region: string;
  readonly vibe: string;
  readonly priceFrom: number;
  readonly bestMonths: string;
  readonly why: string;
};

function asDiscovery(value: unknown) {
  return value as
    | {
        readonly status?: string;
        readonly month?: string;
        readonly travelers?: number;
        readonly options?: readonly Destination[];
      }
    | undefined;
}

export default function DiscoveryCarousel() {
  const { displayMode, theme } = useLayout();
  const openExternal = useOpenExternal();
  const discovery = asDiscovery(useToolInfo('discover_getaways').structuredContent);
  const shortlist = useCallTool('shortlist_getaway');
  const handoff = useCallTool('create_handoff');

  const options = discovery?.options ?? [];
  const month = discovery?.month ?? 'June';
  const travelers = discovery?.travelers ?? 2;
  const [chosen, setChosen] = useViewState('chosen', options[0]?.id ?? '');
  const [status, setStatus] = useState(discovery?.status ?? 'Pick a getaway to continue.');
  const selected = options.find((entry) => entry.id === chosen) ?? options[0];
  const continueLabel = handoff.isPending
    ? 'Opening Acme…'
    : `Continue on Acme${selected ? ` · ${selected.name}` : ''}`;

  async function shortlistDestination(destination: Destination) {
    setChosen(destination.id);
    try {
      const result = await shortlist.callTool({ destination: destination.name });
      const structured = result.structuredContent as { readonly status?: string } | undefined;
      setStatus(structured?.status ?? `Shortlisted ${destination.name}.`);
    } catch {
      setStatus(`Couldn't shortlist ${destination.name} — try again.`);
    }
  }

  async function continueOnAcme() {
    if (selected === undefined) return;
    // The handoff is the product: configure here, transact off-app. The deep link carries the trip.
    // Only open the external target on a successful handoff; surface failures instead of failing silently.
    try {
      const result = await handoff.callTool({
        destination: selected.id,
        destinationName: selected.name,
        month,
        travelers,
      });
      const structured = result.structuredContent as { readonly handoffUrl?: string } | undefined;
      if (structured?.handoffUrl) openExternal(structured.handoffUrl);
      else setStatus('Continue on Acme is unavailable right now — try again.');
    } catch {
      setStatus('Continue on Acme failed — try again.');
    }
  }

  return (
    <main
      className={`nw-shell${theme === 'dark' ? ' dark' : ''}`}
      data-llm={`Acme Getaways discovery: ${options.length} options for ${month}, ${travelers} traveler(s); shortlisted ${selected?.name ?? 'none'}`}
    >
      <section className="nw-card">
        <header className="nw-header">
          <span className="nw-icon" aria-hidden="true">
            <CompassIcon />
          </span>
          <div className="nw-title-block">
            <h1 className="nw-title">Acme Getaways</h1>
            <p className="nw-subtitle" aria-live="polite">
              {status}
            </p>
          </div>
          <span className="nw-chip">
            {displayMode === 'fullscreen' ? 'Fullscreen' : 'Discover'}
          </span>
        </header>

        <div className="nw-carousel">
          {options.map((entry) => (
            <article
              className={`nw-dest${entry.id === chosen ? ' nw-dest-active' : ''}`}
              key={entry.id}
            >
              <div className="nw-dest-head">
                <span className="nw-dest-name">{entry.name}</span>
                <span className="nw-price">from ${entry.priceFrom}</span>
              </div>
              <p className="nw-dest-region">
                {entry.region} · best {entry.bestMonths}
              </p>
              {/* Grounded copy: the "why" comes from Acme's catalog, not invented at runtime. */}
              <p className="nw-dest-why">{entry.why}</p>
              <button
                aria-pressed={entry.id === chosen}
                className="nw-button nw-button-ghost"
                type="button"
                onClick={() => shortlistDestination(entry)}
              >
                {entry.id === chosen ? 'Shortlisted' : 'Shortlist'}
              </button>
            </article>
          ))}
        </div>

        <div className="nw-actions">
          <button
            className="nw-button nw-button-primary"
            type="button"
            disabled={selected === undefined || handoff.isPending}
            onClick={continueOnAcme}
          >
            <ExternalIcon />
            {continueLabel}
          </button>
        </div>
        <p className="nw-note">Booking and payment happen on acme.example — never inside chat.</p>
      </section>
    </main>
  );
}

function CompassIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="m15.5 8.5-2 5-5 2 2-5 5-2Z" />
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
