import { ActionStatus, EmptyState, Panel, WidgetHeader } from './shared.js';

export function OperationsWidget() {
  return (
    <main>
      <WidgetHeader
        eyebrow="Noodle Cloud"
        title="Operations"
        description="Bounded diagnostic findings and recent application logs."
        statusPath="ok"
      />
      <Panel title="Diagnostic findings" description="Evidence is ordered by severity.">
        <div className="collection" data-collection="data.findings" data-collection-item="finding">
          <template data-collection-template="">
            <article className="collection-card">
              <h3 data-bind="finding.title">Finding</h3>
              <p data-bind="finding.message">Loading</p>
              <p>
                Severity: <strong data-bind="finding.severity">—</strong>
              </p>
            </article>
          </template>
          <EmptyState>No diagnostic findings were returned.</EmptyState>
        </div>
      </Panel>
      <Panel
        title="Recent logs"
        description="The tool result controls the time window and item limit."
      >
        <div className="collection" data-collection="data.events" data-collection-item="event">
          <template data-collection-template="">
            <article className="collection-card">
              <h3 data-bind="event.message">Log event</h3>
              <p>
                Level: <strong data-bind="event.level">—</strong>
              </p>
              <p data-bind="event.createdAt">Loading</p>
            </article>
          </template>
          <EmptyState>No log events were returned for this bounded query.</EmptyState>
        </div>
      </Panel>
      <ActionStatus />
    </main>
  );
}
