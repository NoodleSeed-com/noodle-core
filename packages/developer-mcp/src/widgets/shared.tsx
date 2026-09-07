import type { ReactNode } from 'react';

export function WidgetHeader(props: {
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
  readonly statusPath: string;
}) {
  return (
    <header className="widget-header">
      <div>
        <p className="eyebrow">{props.eyebrow}</p>
        <h1>{props.title}</h1>
        <p className="lede">{props.description}</p>
      </div>
      <StatusBadge path={props.statusPath} />
    </header>
  );
}

export function Panel(props: {
  readonly title: string;
  readonly description?: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="panel">
      <header className="panel-header">
        <h2>{props.title}</h2>
        {props.description === undefined ? null : <p>{props.description}</p>}
      </header>
      {props.children}
    </section>
  );
}

function StatusBadge(props: { readonly path: string }) {
  return (
    <p className="status-badge" role="status">
      <span className="visually-hidden" data-status-label="">
        Status:
      </span>{' '}
      <span data-bind={props.path}>Loading</span>
    </p>
  );
}

export function BoundValue(props: {
  readonly label: string;
  readonly path: string;
  readonly className?: string;
}) {
  return (
    <div className={props.className ?? 'fact'}>
      <dt>{props.label}</dt>
      <dd data-bind={props.path}>Loading</dd>
    </div>
  );
}

export function Metric(props: {
  readonly label: string;
  readonly path: string;
  readonly hint?: string;
}) {
  return (
    <div className="metric">
      <dt>{props.label}</dt>
      <dd data-bind={props.path}>—</dd>
      {props.hint === undefined ? null : <p>{props.hint}</p>}
    </div>
  );
}

export function ActionStatus() {
  return (
    <output className="action-status" aria-live="polite" data-noodle-action-status="">
      Ready.
    </output>
  );
}

export function EmptyState(props: { readonly children: ReactNode }) {
  return (
    <p className="empty-state" data-collection-empty="">
      {props.children}
    </p>
  );
}
