import { ActionStatus, BoundValue, EmptyState, Panel, WidgetHeader } from './shared.js';

export function AppOverviewWidget() {
  return (
    <main>
      <WidgetHeader
        eyebrow="Noodle Cloud"
        title="App overview"
        description="Deployment state for the organization and environments selected at connection time."
        statusPath="data.active"
      />
      <Panel title="Selected app" description="This view is limited to the active developer grant.">
        <dl className="facts">
          <BoundValue label="App" path="data.app" />
          <BoundValue label="Environment" path="data.selectedEnvironment" />
          <BoundValue label="Active" path="data.active" />
          <BoundValue label="Last activity" path="data.lastActivityAt" />
        </dl>
      </Panel>
      <Panel title="Granted environments">
        <div
          className="tag-list"
          data-collection="data.environments"
          data-collection-item="environment"
        >
          <template data-collection-template="">
            <span className="tag" data-bind="environment">
              Loading
            </span>
          </template>
          <EmptyState>No environment is available in this result.</EmptyState>
        </div>
      </Panel>
      <Panel title="Active deployment">
        <dl className="facts">
          <BoundValue label="Deployment" path="data.latest.deploymentId" />
          <BoundValue label="Created" path="data.latest.createdAt" />
          <BoundValue label="Access" path="data.latest.accessMode" />
          <BoundValue label="Owner" path="data.latest.ownerSubject" />
          <BoundValue label="Endpoint" path="data.latest.endpointUrl" />
        </dl>
        <p className="notice" data-bind-if="data.active">
          An active deployment is serving this environment.
        </p>
      </Panel>
      <ActionStatus />
    </main>
  );
}
