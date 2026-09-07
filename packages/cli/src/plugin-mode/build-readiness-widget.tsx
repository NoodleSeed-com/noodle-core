import { injectWidgetBridge } from '@noodle-borg/protocol';
import { renderToStaticMarkup } from 'react-dom/server';

import { BUILD_READINESS_WIDGET_STYLES } from './build-readiness-widget.css.js';

export const BUILD_READINESS_WIDGET_URI = 'ui://noodle-developer/build-readiness/v1' as const;
export const BUILD_READINESS_WIDGET_MIME_TYPE = 'text/html;profile=mcp-app' as const;

const CLOSED_WIDGET_META = {
  ui: {
    csp: { connectDomains: [], resourceDomains: [] },
    prefersBorder: true as const,
  },
  'openai/widgetDescription':
    'A compact Noodle build decision with live local gates, bounded findings, and the next safe action.',
};

const GATE_ARGUMENTS = (operation: string) =>
  JSON.stringify({ workspaceHandle: '{{data.workspaceHandle}}', operation });
const WORKSPACE_ARGUMENTS = JSON.stringify({ workspaceHandle: '{{data.workspaceHandle}}' });
const CANCEL_ARGUMENTS = JSON.stringify({
  workspaceHandle: '{{data.workspaceHandle}}',
  runId: '{{data.activeRunId}}',
});

export function BuildReadinessWidget() {
  return (
    <main className="readiness-card" data-build-readiness="">
      <div className="loading-shader" aria-hidden="true" />
      <header className="decision">
        <div className="brand-row">
          <span className="brand-mark" aria-hidden="true">
            <NoodleIcon />
          </span>
          <p>Noodle Seed · Build readiness</p>
        </div>
        <div className="decision-row">
          <div className="decision-copy">
            <h1 data-bind="data.title">Checking project</h1>
            <p className="summary" data-bind="data.summary">
              Resolving trustworthy local build evidence.
            </p>
          </div>
          <p className="decision-badge" role="status" data-bind-tone="data.tone">
            <span data-bind="data.decision">Loading</span>
          </p>
        </div>
      </header>

      <section className="section" aria-labelledby="readiness-stages">
        <div className="section-heading">
          <h2 id="readiness-stages">Build path</h2>
          <p className="section-note">Current source</p>
        </div>
        <ol className="stage-list" data-collection="data.stages" data-collection-item="stage">
          <template data-collection-template="">
            <li className="stage-row" data-bind-tone="stage.tone">
              <span className="stage-label">
                <span className="stage-dot" aria-hidden="true" />
                <span data-bind="stage.label">Stage</span>
              </span>
              <span className="stage-status" data-bind="stage.status">
                Not run
              </span>
            </li>
          </template>
        </ol>
      </section>

      <section className="section" aria-labelledby="readiness-findings">
        <div className="section-heading">
          <h2 id="readiness-findings">What needs attention</h2>
          <p className="section-note">Up to 3</p>
        </div>
        <ul className="finding-list" data-collection="data.findings" data-collection-item="finding">
          <template data-collection-template="">
            <li className="finding-row">
              <AlertIcon />
              <div className="finding-copy">
                <p className="finding-code" data-bind="finding.code">
                  Finding
                </p>
                <p className="finding-message" data-bind="finding.message">
                  Review this item.
                </p>
              </div>
            </li>
          </template>
          <p className="empty-findings" data-collection-empty="">
            No blocking findings in the latest bounded result.
          </p>
        </ul>
      </section>

      <footer className="section">
        <div className="action-row">
          <GateButton action="validate" label="Validate project" operation="validate" />
          <GateButton action="test" label="Run tests" operation="test" />
          <GateButton action="targetCheck" label="Check target" operation="target-check" />
          <button
            type="button"
            className="action action-primary"
            data-action="call"
            data-action-tool="deploy_build"
            data-action-args={WORKSPACE_ARGUMENTS}
            data-bind-if="data.actions.deploy"
            hidden
          >
            <DeployIcon />
            Deploy build
          </button>
          <button
            type="button"
            className="action action-secondary"
            data-action="call"
            data-action-tool="run_build_gate"
            data-action-args={GATE_ARGUMENTS('preview')}
            data-bind-if="data.actions.preview"
            hidden
          >
            <PreviewIcon />
            Open preview
          </button>
          <button
            type="button"
            className="action action-secondary action-cancel"
            data-action="call"
            data-action-tool="cancel_build_run"
            data-action-args={CANCEL_ARGUMENTS}
            data-bind-if="data.actions.cancel"
            hidden
          >
            <StopIcon />
            Cancel run
          </button>
        </div>
        <output className="action-status" aria-live="polite" data-noodle-action-status="">
          Ready for the next decision.
        </output>
      </footer>
    </main>
  );
}

function GateButton(props: {
  readonly action: 'validate' | 'test' | 'targetCheck';
  readonly label: string;
  readonly operation: string;
}) {
  return (
    <button
      type="button"
      className="action action-primary"
      data-action="call"
      data-action-tool="run_build_gate"
      data-action-args={GATE_ARGUMENTS(props.operation)}
      data-bind-if={`data.actions.${props.action}`}
      hidden
    >
      <RunIcon />
      {props.label}
    </button>
  );
}

function NoodleIcon() {
  return (
    <svg className="icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M5 6.5h6.25a3.75 3.75 0 1 1 0 7.5H8.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M5 10h6.1a2 2 0 1 1 0 4H10"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function RunIcon() {
  return (
    <svg className="icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="m7.25 5 6 5-6 5V5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function PreviewIcon() {
  return (
    <svg className="icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M2.75 10s2.5-4 7.25-4 7.25 4 7.25 4-2.5 4-7.25 4-7.25-4-7.25-4Z"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <circle cx="10" cy="10" r="1.75" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function DeployIcon() {
  return (
    <svg className="icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M10 14.75v-9.5m0 0L6.5 8.75M10 5.25l3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4 13.5v2.25h12V13.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg className="icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="6" y="6" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg className="icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M10 3.25 17 16H3l7-12.75Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="M10 7.25v4.25m0 2.25v.1"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

export interface RenderedBuildReadinessWidget {
  readonly uri: typeof BUILD_READINESS_WIDGET_URI;
  readonly mimeType: typeof BUILD_READINESS_WIDGET_MIME_TYPE;
  readonly text: string;
  readonly _meta: typeof CLOSED_WIDGET_META;
}

export function renderBuildReadinessWidget(): RenderedBuildReadinessWidget {
  const body = renderToStaticMarkup(<BuildReadinessWidget />);
  const document = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Noodle build readiness</title><style>${BUILD_READINESS_WIDGET_STYLES}</style></head><body>${body}</body></html>`;
  return {
    uri: BUILD_READINESS_WIDGET_URI,
    mimeType: BUILD_READINESS_WIDGET_MIME_TYPE,
    text: injectWidgetBridge(BUILD_READINESS_WIDGET_MIME_TYPE, document),
    _meta: CLOSED_WIDGET_META,
  };
}

export function buildReadinessWidgetToolMeta() {
  return {
    ui: { resourceUri: BUILD_READINESS_WIDGET_URI },
    'openai/outputTemplate': BUILD_READINESS_WIDGET_URI,
  };
}
