import { ActionStatus, BoundValue, EmptyState, Panel, WidgetHeader } from './shared.js';

const ROLLBACK_ARGUMENTS =
  '{"app":"{{data.target.app}}","env":"{{data.target.env}}","deploymentId":"{{data.rollbackCandidate.deploymentId}}"}';

export function DeploymentDetailWidget() {
  return (
    <main>
      <WidgetHeader
        eyebrow="Noodle Cloud"
        title="Deployment detail"
        description="Runtime health, surface compatibility, and governed rollback state."
        statusPath="data.health.state"
      />
      <Panel title="Deployment identity">
        <dl className="facts">
          <BoundValue label="App" path="data.target.app" />
          <BoundValue label="Environment" path="data.target.env" />
          <BoundValue label="Deployment" path="data.deployment.deploymentId" />
          <BoundValue label="Created" path="data.deployment.createdAt" />
          <BoundValue label="Access" path="data.deployment.accessMode" />
          <BoundValue label="Owner" path="data.deployment.ownerSubject" />
          <BoundValue label="Endpoint" path="data.deployment.endpointUrl" />
        </dl>
      </Panel>
      <Panel title="Runtime health">
        <dl className="facts">
          <BoundValue label="State" path="data.health.state" />
          <BoundValue label="MCP Apps" path="data.surface.compatibility.mcpApps" />
          <BoundValue label="ChatGPT" path="data.surface.compatibility.chatgpt" />
          <BoundValue label="Claude" path="data.surface.compatibility.claude" />
        </dl>
        <div
          className="collection"
          data-collection="data.health.missingSecrets"
          data-collection-item="missing"
        >
          <template data-collection-template="">
            <p className="collection-card" data-bind="missing">
              Loading
            </p>
          </template>
          <EmptyState>No missing managed configuration was reported.</EmptyState>
        </div>
      </Panel>
      <Panel
        title="Rollback"
        description="Noodle Cloud rechecks ownership, selected environment, compatibility, and admission before activation."
      >
        <div className="action-row">
          <dl className="facts">
            <BoundValue label="Candidate" path="data.rollbackCandidate.deploymentId" />
            <BoundValue label="Created" path="data.rollbackCandidate.createdAt" />
          </dl>
          <button
            type="button"
            className="primary-action danger-action"
            data-action="call"
            data-action-tool="rollback_deployment"
            data-action-args={ROLLBACK_ARGUMENTS}
            data-bind-if="data.rollbackCandidate.deploymentId"
            hidden
          >
            Roll back to candidate
          </button>
        </div>
        <p className="notice">
          If no candidate is shown, use the headless deployment workflow to inspect an explicit
          deployment ID.
        </p>
      </Panel>
      <Panel title="Rollback outcome">
        <dl className="facts" data-bind-if="data.rollback.deploymentId">
          <BoundValue label="Activated deployment" path="data.rollback.deploymentId" />
          <BoundValue label="Previously active" path="data.rollback.previousDeploymentId" />
          <BoundValue label="Already active" path="data.rollback.alreadyActive" />
          <BoundValue label="Endpoint" path="data.rollback.endpointUrl" />
          <BoundValue label="Owner" path="data.rollback.ownerSubject" />
        </dl>
      </Panel>
      <ActionStatus />
    </main>
  );
}
