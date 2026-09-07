import { ActionStatus, EmptyState, Metric, Panel, WidgetHeader } from './shared.js';

export function AnalyticsWidget() {
  return (
    <main>
      <WidgetHeader
        eyebrow="Noodle Cloud"
        title="Analytics"
        description="A bounded request window from the selected app environment."
        statusPath="ok"
      />
      <Panel title="Request health">
        <dl className="metrics">
          <Metric label="Requests" path="data.metrics.totals.requests" />
          <Metric label="Tool calls" path="data.metrics.totals.toolCalls" />
          <Metric label="Error rate" path="data.metrics.errors.errorRate" />
          <Metric label="P95 latency" path="data.metrics.latency.p95Ms" hint="Milliseconds" />
        </dl>
      </Panel>
      <Panel title="Observation window">
        <dl className="facts">
          <Metric label="Since" path="data.window.since" />
          <Metric label="Until" path="data.window.until" />
          <Metric label="Partial" path="data.truncated" />
          <Metric label="Legacy handshakes" path="data.metrics.totals.legacyInitializations" />
        </dl>
        <p className="notice" data-tone="warn" data-bind-if="data.truncated">
          Partial data: the bounded analytics scan reached its limit. Narrow the time window for a
          complete view.
        </p>
      </Panel>
      <Panel title="Activity sources">
        <p className="notice">
          Caller names are reported by client software and are not verified identities. Embedded
          assistant usage is a separate telemetry unit and is not counted here.
        </p>
        <div
          className="collection"
          data-collection="data.metrics.clientActivity.callers"
          data-collection-item="caller"
        >
          <template data-collection-template="">
            <article className="collection-card">
              <h3>MCP caller</h3>
              <p>
                Attribution: <strong data-bind="caller.attribution">—</strong>
              </p>
              <p data-bind-if="caller.reportedName">
                Reported name: <strong data-bind="caller.reportedName">—</strong>
              </p>
              <p>
                Recognized family: <strong data-bind="caller.family">—</strong>
              </p>
              <p>
                Requests: <strong data-bind="caller.requests">—</strong> · errors:{' '}
                <strong data-bind="caller.errors">—</strong>
              </p>
              <p>
                Era requests: modern <strong data-bind="caller.protocolEras.modern">—</strong> ·
                legacy <strong data-bind="caller.protocolEras.legacy">—</strong> · unattributed{' '}
                <strong data-bind="caller.protocolEras.unknown">—</strong>
              </p>
            </article>
          </template>
          <EmptyState>No MCP caller activity was observed in this window.</EmptyState>
        </div>
        <div
          className="collection"
          data-collection="data.metrics.clientActivity.legacyHandshakes.byReportedClient"
          data-collection-item="handshake"
        >
          <template data-collection-template="">
            <article className="collection-card">
              <h3>Legacy protocol handshake</h3>
              <p data-bind-if="handshake.reportedName">
                Reported name: <strong data-bind="handshake.reportedName">—</strong>
              </p>
              <p>
                Handshakes: <strong data-bind="handshake.initializations">—</strong>
              </p>
              <p>
                Last handshake: <strong data-bind="handshake.lastInitializedAt">—</strong>
              </p>
            </article>
          </template>
          <EmptyState>No legacy handshakes were observed in this window.</EmptyState>
        </div>
      </Panel>
      <Panel title="Tools">
        <div
          className="collection"
          data-collection="data.metrics.byTool"
          data-collection-item="tool"
        >
          <template data-collection-template="">
            <article className="collection-card">
              <h3 data-bind="tool.tool">Tool</h3>
              <p>
                Calls: <strong data-bind="tool.calls">—</strong>
              </p>
              <p>
                Errors: <strong data-bind="tool.errors">—</strong>
              </p>
            </article>
          </template>
          <EmptyState>No tool calls were observed in this window.</EmptyState>
        </div>
      </Panel>
      <ActionStatus />
    </main>
  );
}
